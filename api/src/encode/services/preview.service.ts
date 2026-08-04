import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rm, readFile, writeFile, stat } from 'fs/promises';
import type { ReadStream } from 'fs';
import { SessionService } from './session.service.js';
import type { ProbeResult, AudioTrackInfo } from './probe.service.js';
import { FfmpegService } from './ffmpeg.service.js';

const MAX_AUDIO_BITRATE_KBPS = 150;

export interface PreviewAudioTrack {
    index: number;
    streamIndex: number;
    language?: string;
    name?: string;
    bitrateKbps?: number;
    codec?: string;
    isDefault: boolean;
}

const execFileAsync = promisify(execFile);

// Codecs that can be remuxed to MPEG-TS for browser MSE playback
const TS_COPY_CODECS = new Set(['h264', 'vp8', 'vp9']);

const SEGMENT_DURATION = 4;
const MAX_PREVIEW_HEIGHT = 480;

interface SegmentBoundary {
    start: number;
    duration: number;
}

interface Rendition {
    /** Type-relative video stream index (for -map 0:v:N), -1 when audioOnly */
    videoIndex: number;
    width: number;
    height: number;
    bitrateKbps: number;
    canCopy: boolean;
    /** Scale filter value for transcode mode (e.g. "480:-2") */
    scaleFilter?: string;
    /** When true, the rendition carries only audio (MP3/FLAC/etc. sources) */
    audioOnly?: boolean;
}

interface PreviewState {
    filePath: string;
    duration: number;
    segmentBoundaries: SegmentBoundary[];
    audioTracks: PreviewAudioTrack[];
    renditions: Rendition[];
    previewDir: string;
    masterPlaylist: string;
    mediaPlaylists: string[];
    /** When set, media playlists are filtered to only include overlapping segments */
    trimSegments?: { inSec: number; outSec: number }[];
}

const MAX_CONCURRENT = 3;

@Injectable()
export class PreviewService {
    private readonly logger = new Logger(PreviewService.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');
    private readonly states = new Map<string, PreviewState>();
    private readonly pending = new Map<string, Promise<string>>();
    // Concurrency limiter for FFmpeg processes
    private activeCount = 0;
    private readonly waitQueue: Array<() => void> = [];

    constructor(
        private readonly sessionService: SessionService,
        private readonly ffmpegService: FfmpegService,
    ) {}

    async init(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session?.filePath || !session.probeResult) {
            this.logger.warn(`Cannot init preview for ${sessionId}: no file or probe`);
            return;
        }

        const { filePath, probeResult } = session;
        // Derive scratch dirs from WORK_DIR, never from the source file's
        // location — the source may live anywhere on disk (e.g. a local file
        // picked in the desktop app), and destroy() rm -rf's this directory.
        const previewDir = join(this.workDir, sessionId, 'preview');
        await mkdir(previewDir, { recursive: true });

        const duration = probeResult.format.duration;
        const audioTracks = this.selectAudioTracks(probeResult);

        // Build renditions from available video tracks, or a single
        // audio-only rendition when the source has no video tracks.
        let renditions = this.buildRenditions(probeResult);
        if (renditions.length === 0) {
            if (audioTracks.length === 0) {
                this.logger.warn(`No suitable video renditions for ${sessionId}`);
                return;
            }
            renditions = [{
                videoIndex: -1,
                width: 0,
                height: 0,
                bitrateKbps: 128,
                canCopy: false,
                audioOnly: true,
            }];
        }

        // Keyframe scan for copy-mode renditions (skipped for audio-only)
        const copyRendition = renditions.find((r) => r.canCopy);
        const boundaries = copyRendition
            ? await this.scanKeyframes(sessionId, filePath, copyRendition.videoIndex)
            : [];

        // Generate playlists
        const mediaPlaylists = renditions.map((_, i) =>
            this.generateMediaPlaylist(boundaries, duration, i),
        );
        const masterPlaylist = this.generateMasterPlaylist(renditions);

        this.states.set(sessionId, {
            filePath,
            duration,
            segmentBoundaries: boundaries,
            audioTracks,
            renditions,
            previewDir,
            masterPlaylist,
            mediaPlaylists,
        });

        const renditionSummary = renditions
            .map((r) => r.audioOnly
                ? 'audio-only(aac)'
                : `${r.width}x${r.height}(${r.canCopy ? 'copy' : 'transcode'})`)
            .join(', ');
        const audioSummary = audioTracks.length > 1
            ? `, ${audioTracks.length} audio track(s) [${audioTracks.map((a) => a.language ?? a.name ?? 'und').join(', ')}]`
            : '';
        this.logger.log(
            `Preview initialized for ${sessionId}: ${renditions.length} rendition(s) [${renditionSummary}]${audioSummary}, ` +
                `${boundaries.length || Math.ceil(duration / SEGMENT_DURATION)} segments`,
        );
    }

    isReady(sessionId: string): boolean {
        return this.states.has(sessionId);
    }

    /** Get available audio tracks for client-side track selector */
    getAudioTracks(sessionId: string): PreviewAudioTrack[] | null {
        const state = this.states.get(sessionId);
        return state ? state.audioTracks : null;
    }

    /** Store trim segments and regenerate filtered media playlists */
    setTrimSegments(sessionId: string, segments: { inSec: number; outSec: number }[]): void {
        const state = this.states.get(sessionId);
        if (!state) return;

        state.trimSegments = segments;

        // Regenerate media playlists filtered to trim ranges
        state.mediaPlaylists = state.renditions.map((_, i) =>
            this.generateFilteredMediaPlaylist(state, i),
        );

        this.logger.log(
            `Preview playlists filtered to ${segments.length} trim segment(s) for session ${sessionId}`,
        );
    }

    /** Get master or media playlist */
    getPlaylist(sessionId: string, token: string, renditionIndex?: number, audioTrackIndex?: number): string | null {
        const state = this.states.get(sessionId);
        if (!state) return null;

        let playlist: string;
        if (renditionIndex !== undefined && renditionIndex < state.mediaPlaylists.length) {
            playlist = state.mediaPlaylists[renditionIndex];
        } else {
            playlist = state.masterPlaylist;
        }

        // Append token (and audio track for cache isolation) to all URLs
        const audioParam = (audioTrackIndex !== undefined && state.audioTracks.length > 1)
            ? `&audio=${audioTrackIndex}` : '';
        return playlist.replace(
            /((?:segment\d+\.ts|r\d+\/playlist\.m3u8))/g,
            `$1?token=${token}${audioParam}`,
        );
    }

    /** Get a segment file stream, extracting on demand if not cached */
    async getSegmentStream(
        sessionId: string,
        renditionIndex: number,
        segmentIndex: number,
        audioTrackIndex?: number,
    ): Promise<{ stream: ReadStream; size: number } | null> {
        const state = this.states.get(sessionId);
        if (!state) return null;
        if (renditionIndex < 0 || renditionIndex >= state.renditions.length) return null;

        const totalSegments = state.segmentBoundaries.length > 0
            ? state.segmentBoundaries.length
            : Math.ceil(state.duration / SEGMENT_DURATION);
        if (segmentIndex < 0 || segmentIndex >= totalSegments) return null;

        const ai = audioTrackIndex ?? 0;
        // Cache segments per (rendition, audioTrack) pair when multi-audio
        const cacheDir = state.audioTracks.length > 1 ? `r${renditionIndex}a${ai}` : `r${renditionIndex}`;
        const segDir = join(state.previewDir, cacheDir);
        const segPath = join(segDir, `segment${segmentIndex}.ts`);

        // Return cached segment (ignore empty files left by killed FFmpeg processes)
        if (existsSync(segPath)) {
            const s = await stat(segPath);
            if (s.size > 0) {
                return { stream: createReadStream(segPath), size: s.size };
            }
            // Empty file from cancelled extraction — delete and re-extract
            await rm(segPath, { force: true }).catch(() => {});
        }

        // Extract on demand (deduplicate concurrent requests).
        // .catch on the stored promise prevents unhandled rejections
        // when cancelPending kills the process and clears the map.
        const cacheKey = `${sessionId}:${cacheDir}:${segmentIndex}`;
        let promise = this.pending.get(cacheKey);
        if (!promise) {
            promise = this.extractSegment(state, renditionIndex, segmentIndex, segPath, ai);
            promise.catch(() => {}); // prevent unhandled rejection if cancelled
            this.pending.set(cacheKey, promise);
            promise.finally(() => this.pending.delete(cacheKey)).catch(() => {});
        }

        try {
            await promise;
        } catch (e: any) {
            this.logger.warn(`Segment ${cacheDir}/s${segmentIndex} extraction error: ${e.message}`);
            return null;
        }

        if (existsSync(segPath)) {
            const s = await stat(segPath);
            if (s.size > 0) {
                this.prefetchSegments(sessionId, state, cacheDir, renditionIndex, segmentIndex + 1, 3, ai);
                return { stream: createReadStream(segPath), size: s.size };
            }
            this.logger.warn(`Segment r${renditionIndex}/s${segmentIndex} produced empty file, deleting`);
            await rm(segPath, { force: true }).catch(() => {});
        } else {
            this.logger.warn(`Segment r${renditionIndex}/s${segmentIndex} file not found after extraction`);
        }

        return null;
    }

    /** Pre-extract upcoming segments in background so they're cached for VHS */
    private prefetchSegments(
        sessionId: string,
        state: PreviewState,
        cacheDir: string,
        renditionIndex: number,
        startIndex: number,
        count: number,
        audioTrackIndex: number,
    ): void {
        const totalSegments = state.segmentBoundaries.length > 0
            ? state.segmentBoundaries.length
            : Math.ceil(state.duration / SEGMENT_DURATION);

        for (let i = startIndex; i < startIndex + count && i < totalSegments; i++) {
            const segPath = join(state.previewDir, cacheDir, `segment${i}.ts`);
            const cacheKey = `${sessionId}:${cacheDir}:${i}`;

            if (existsSync(segPath) || this.pending.has(cacheKey)) continue;

            const promise = this.extractSegment(state, renditionIndex, i, segPath, audioTrackIndex);
            promise.catch(() => {});
            this.pending.set(cacheKey, promise);
            promise.finally(() => this.pending.delete(cacheKey)).catch(() => {});
        }
    }

    async destroy(sessionId: string): Promise<void> {
        const state = this.states.get(sessionId);
        if (!state) return;
        this.states.delete(sessionId);
        await rm(state.previewDir, { recursive: true, force: true }).catch(() => {});
    }

    // -----------------------------------------------------------------------
    // Private: audio track selection
    // -----------------------------------------------------------------------

    /** Select audio tracks for preview: one per language, or treat each as distinct when no language metadata */
    /** Expose all audio tracks for the preview selector */
    private selectAudioTracks(probe: ProbeResult): PreviewAudioTrack[] {
        return probe.audioTracks.map((t, i) => ({
            index: i,
            streamIndex: t.index,
            language: t.language,
            name: t.name,
            bitrateKbps: t.bitrateKbps,
            codec: t.codec,
            isDefault: i === 0,
        }));
    }

    // -----------------------------------------------------------------------
    // Private: rendition building
    // -----------------------------------------------------------------------

    /** Build ABR renditions from available video tracks, capped at MAX_PREVIEW_HEIGHT */
    private buildRenditions(probe: ProbeResult): Rendition[] {
        const videos = probe.videoTracks;
        if (videos.length === 0) return [];

        const codec = videos[0].codec.toLowerCase();
        const canCopyCodec = TS_COPY_CODECS.has(codec);

        if (canCopyCodec && videos.length > 1) {
            // Multi-stream file with copy-compatible codec — use existing streams as renditions
            const eligible = videos
                .filter((v) => v.height <= MAX_PREVIEW_HEIGHT)
                .sort((a, b) => b.height - a.height); // highest first

            if (eligible.length > 0) {
                return eligible.map((v) => ({
                    videoIndex: v.index,
                    width: v.width,
                    height: v.height,
                    bitrateKbps: v.bitrateKbps,
                    canCopy: true,
                }));
            }

            // All streams > 480p — use the smallest one
            const smallest = [...videos].sort((a, b) => a.height - b.height)[0];
            return [{
                videoIndex: smallest.index,
                width: smallest.width,
                height: smallest.height,
                bitrateKbps: smallest.bitrateKbps,
                canCopy: true,
            }];
        }

        if (canCopyCodec) {
            const v = videos[0];
            if (v.height <= MAX_PREVIEW_HEIGHT) {
                // Source fits within preview height — single copy rendition
                return [{
                    videoIndex: v.index,
                    width: v.width,
                    height: v.height,
                    bitrateKbps: v.bitrateKbps,
                    canCopy: true,
                }];
            }
            // Source > 480p — fall through to generate multiple transcode renditions
        }

        // Transcode mode (HEVC, ProRes, >480p H.264, etc.) — generate 2-3 renditions
        const renditions: Rendition[] = [];
        const v = videos[0];
        const heights = [480, 360, 240].filter((h) => h <= Math.max(v.height, 240));

        for (const h of heights) {
            const w = Math.round(v.width * h / v.height / 2) * 2;
            renditions.push({
                videoIndex: v.index,
                width: w,
                height: h,
                bitrateKbps: Math.round(h * 2), // rough estimate
                canCopy: false,
                scaleFilter: `${w}:-2`,
            });
        }

        return renditions;
    }

    // -----------------------------------------------------------------------
    // Private: concurrency, keyframe scan, playlists, segment extraction
    // -----------------------------------------------------------------------

    private async acquireSlot(): Promise<void> {
        if (this.activeCount < MAX_CONCURRENT) {
            this.activeCount++;
            return;
        }
        await new Promise<void>((resolve) => this.waitQueue.push(resolve));
        this.activeCount++;
    }

    private releaseSlot(): void {
        this.activeCount--;
        const next = this.waitQueue.shift();
        if (next) next();
    }

    private async scanKeyframes(
        sessionId: string,
        filePath: string,
        videoStreamIndex: number,
    ): Promise<SegmentBoundary[]> {
        // Scratch dir under WORK_DIR, not next to the source — this is rm -rf'd below.
        const tmpDir = join(this.workDir, sessionId, 'kfscan');
        await mkdir(tmpDir, { recursive: true });
        const csvPath = join(tmpDir, 'segments.csv');

        try {
            await execFileAsync('ffmpeg', [
                '-i', filePath,
                '-map', `0:v:${videoStreamIndex}`,
                '-c:v', 'copy', '-an',
                '-f', 'segment',
                '-segment_time', String(SEGMENT_DURATION),
                '-segment_list', csvPath,
                '-segment_list_type', 'csv',
                '-y', join(tmpDir, 'seg%d.ts'),
            ], { timeout: 120_000 });

            const csv = await readFile(csvPath, 'utf8');
            return csv.trim().split('\n')
                .filter((line) => line.length > 0)
                .map((line) => {
                    const parts = line.split(',');
                    return { start: parseFloat(parts[1]), duration: parseFloat(parts[2]) - parseFloat(parts[1]) };
                });
        } catch (e) {
            this.logger.warn(`Keyframe scan failed: ${e}`);
            return [];
        } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    private generateMasterPlaylist(renditions: Rendition[]): string {
        const lines = ['#EXTM3U'];
        for (let i = 0; i < renditions.length; i++) {
            const r = renditions[i];
            const bandwidth = r.bitrateKbps * 1000;
            if (r.audioOnly) {
                lines.push(
                    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="mp4a.40.2"`,
                    `r${i}/playlist.m3u8`,
                );
            } else {
                lines.push(
                    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}`,
                    `r${i}/playlist.m3u8`,
                );
            }
        }
        lines.push('');
        return lines.join('\n');
    }

    private generateMediaPlaylist(
        boundaries: SegmentBoundary[],
        duration: number,
        renditionIndex: number,
    ): string {
        const segCount = boundaries.length > 0
            ? boundaries.length
            : Math.ceil(duration / SEGMENT_DURATION);

        let maxDuration = SEGMENT_DURATION;
        if (boundaries.length > 0) {
            maxDuration = Math.ceil(Math.max(...boundaries.map((b) => b.duration)));
        }

        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${maxDuration}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD',
        ];

        for (let i = 0; i < segCount; i++) {
            if (i > 0) lines.push('#EXT-X-DISCONTINUITY');
            const segDur = boundaries.length > 0
                ? boundaries[i].duration
                : Math.min(SEGMENT_DURATION, duration - i * SEGMENT_DURATION);
            lines.push(`#EXTINF:${segDur.toFixed(3)},`);
            lines.push(`segment${i}.ts`);
        }

        lines.push('#EXT-X-ENDLIST', '');
        return lines.join('\n');
    }

    private generateFilteredMediaPlaylist(
        state: PreviewState,
        renditionIndex: number,
    ): string {
        const trims = state.trimSegments;
        if (!trims?.length) {
            return this.generateMediaPlaylist(state.segmentBoundaries, state.duration, renditionIndex);
        }

        const boundaries = state.segmentBoundaries;
        const segCount = boundaries.length > 0
            ? boundaries.length
            : Math.ceil(state.duration / SEGMENT_DURATION);

        // Find segments that overlap any trim range
        const included: number[] = [];
        for (let i = 0; i < segCount; i++) {
            const segStart = boundaries.length > 0
                ? boundaries[i].start
                : i * SEGMENT_DURATION;
            const segDur = boundaries.length > 0
                ? boundaries[i].duration
                : Math.min(SEGMENT_DURATION, state.duration - i * SEGMENT_DURATION);
            const segEnd = segStart + segDur;

            for (const trim of trims) {
                if (segStart < trim.outSec && segEnd > trim.inSec) {
                    included.push(i);
                    break;
                }
            }
        }

        if (included.length === 0) {
            return this.generateMediaPlaylist(boundaries, state.duration, renditionIndex);
        }

        // Compute max duration for #EXT-X-TARGETDURATION
        let maxDuration = SEGMENT_DURATION;
        for (const idx of included) {
            const dur = boundaries.length > 0
                ? boundaries[idx].duration
                : Math.min(SEGMENT_DURATION, state.duration - idx * SEGMENT_DURATION);
            if (dur > maxDuration) maxDuration = dur;
        }

        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD',
        ];

        for (let j = 0; j < included.length; j++) {
            const idx = included[j];
            // Each preview segment is independently extracted — timestamps are not continuous
            if (j > 0) lines.push('#EXT-X-DISCONTINUITY');
            const segDur = boundaries.length > 0
                ? boundaries[idx].duration
                : Math.min(SEGMENT_DURATION, state.duration - idx * SEGMENT_DURATION);
            lines.push(`#EXTINF:${segDur.toFixed(3)},`);
            lines.push(`segment${idx}.ts`);
        }

        lines.push('#EXT-X-ENDLIST', '');
        return lines.join('\n');
    }

    private buildSegmentArgs(
        filePath: string,
        start: number,
        segDur: number,
        videoMap: string,
        audioMap: string | null,
        rendition: Rendition,
        accelMode: string,
        useGpu: boolean,
    ): string[] {
        const args: string[] = [];

        if (rendition.audioOnly) {
            args.push(
                '-ss', String(start),
                '-t', String(segDur),
                '-i', filePath,
                '-vn',
            );
            if (audioMap) args.push('-map', audioMap);
            args.push('-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts', 'pipe:1');
            return args;
        }

        // HW accel input flags must come before -i.
        //
        // `-hwaccel_output_format` is not optional here: without it CUDA decodes
        // on the GPU and then hands back software frames, while `scale_cuda`
        // below only accepts frames that stayed on the device. FFmpeg cannot
        // bridge the two and refuses to build the filter graph ("Impossible to
        // convert between the formats supported by the filter ... and
        // auto_scale_0"), so every segment failed over to CPU. Copy-mode
        // renditions never reach the filter, which is why this only showed on
        // sources that have to be transcoded — HEVC and the like.
        if (useGpu && accelMode === 'nvidia') {
            args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
        } else if (useGpu && accelMode === 'apple') {
            args.push('-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld');
        }

        args.push(
            '-ss', String(start),
            '-t', String(segDur),
            '-i', filePath,
            '-map', videoMap,
        );
        if (audioMap) args.push('-map', audioMap);

        if (rendition.canCopy) {
            args.push('-c:v', 'copy');
        } else if (useGpu && accelMode === 'nvidia') {
            args.push('-c:v', 'h264_nvenc', '-preset', 'p1');
            if (rendition.scaleFilter) {
                args.push('-vf', `scale_cuda=${rendition.scaleFilter}`);
            }
        } else if (useGpu && accelMode === 'apple') {
            args.push('-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-realtime', '0', '-b:v', '1500k');
            if (rendition.scaleFilter) {
                args.push('-vf', `scale_vt=w=${rendition.scaleFilter.split(':')[0]}:h=-2`);
            }
        } else {
            // CPU fallback
            args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-tune', 'zerolatency');
            if (rendition.scaleFilter) {
                args.push('-vf', `scale=${rendition.scaleFilter}`);
            }
        }

        if (audioMap) args.push('-c:a', 'aac', '-b:a', '128k');
        args.push('-f', 'mpegts', 'pipe:1');

        return args;
    }

    private async extractSegment(
        state: PreviewState,
        renditionIndex: number,
        segmentIndex: number,
        outputPath: string,
        audioTrackIndex?: number,
    ): Promise<string> {
        const rendition = state.renditions[renditionIndex];
        const boundary = state.segmentBoundaries[segmentIndex];
        const start = boundary?.start ?? segmentIndex * SEGMENT_DURATION;
        const segDur = boundary?.duration ?? Math.min(SEGMENT_DURATION, state.duration - start);

        // Ensure output directory exists
        await mkdir(join(outputPath, '..'), { recursive: true });

        const videoMap = rendition.audioOnly ? '' : `0:v:${rendition.videoIndex}`;
        const audioTrack = state.audioTracks[audioTrackIndex ?? 0] ?? null;
        const audioMap = audioTrack ? `0:a:${audioTrack.streamIndex}` : null;

        const accelMode = this.ffmpegService.getAccelMode();
        const useGpu = !rendition.canCopy && !rendition.audioOnly && accelMode !== 'cpu';

        const args = this.buildSegmentArgs(
            state.filePath, start, segDur, videoMap, audioMap,
            rendition, accelMode, useGpu,
        );

        this.logger.debug(`Segment r${renditionIndex}/s${segmentIndex} (${useGpu ? accelMode : rendition.canCopy ? 'copy' : 'cpu'})`);

        // Wait for a concurrency slot
        await this.acquireSlot();

        try {
            const timeout = rendition.canCopy ? 30_000 : 120_000;
            const opts = { timeout, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' as BufferEncoding };

            let result: { stdout: any };
            try {
                result = await execFileAsync('ffmpeg', args, opts);
            } catch (gpuErr: any) {
                if (!useGpu) throw gpuErr;
                // GPU failed (e.g. NVENC session limit) — retry with CPU
                this.logger.warn(`GPU encode failed for r${renditionIndex}/s${segmentIndex}, falling back to CPU: ${gpuErr.message}`);
                const cpuArgs = this.buildSegmentArgs(
                    state.filePath, start, segDur, videoMap, audioMap,
                    rendition, 'cpu', false,
                );
                result = await execFileAsync('ffmpeg', cpuArgs, opts);
            }

            // Write segment data ourselves — guaranteed flushed via writeFile
            await writeFile(outputPath, result.stdout);
        } catch (e: any) {
            this.logger.error(`Segment r${renditionIndex}/s${segmentIndex} failed: ${e.message}`);
            throw e;
        } finally {
            this.releaseSlot();
        }

        return outputPath;
    }
}
