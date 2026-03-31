import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rm, readFile, writeFile, stat } from 'fs/promises';
import type { ReadStream } from 'fs';
import { SessionService } from './session.service.js';
import type { ProbeResult, AudioTrackInfo } from './probe.service.js';

const MAX_AUDIO_BITRATE_KBPS = 150;

export interface PreviewAudioTrack {
    index: number;
    streamIndex: number;
    language?: string;
    name?: string;
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
    /** Type-relative video stream index (for -map 0:v:N) */
    videoIndex: number;
    width: number;
    height: number;
    bitrateKbps: number;
    canCopy: boolean;
    /** Scale filter value for transcode mode (e.g. "480:-2") */
    scaleFilter?: string;
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
}

const MAX_CONCURRENT = 3;

@Injectable()
export class PreviewService {
    private readonly logger = new Logger(PreviewService.name);
    private readonly states = new Map<string, PreviewState>();
    private readonly pending = new Map<string, Promise<string>>();
    // Concurrency limiter for FFmpeg processes
    private activeCount = 0;
    private readonly waitQueue: Array<() => void> = [];

    constructor(private readonly sessionService: SessionService) {}

    async init(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session?.filePath || !session.probeResult) {
            this.logger.warn(`Cannot init preview for ${sessionId}: no file or probe`);
            return;
        }

        const { filePath, probeResult } = session;
        const previewDir = join(filePath, '..', 'preview');
        await mkdir(previewDir, { recursive: true });

        const duration = probeResult.format.duration;
        const audioTracks = this.selectAudioTracks(probeResult);

        // Build renditions from available video tracks
        const renditions = this.buildRenditions(probeResult);
        if (renditions.length === 0) {
            this.logger.warn(`No suitable video renditions for ${sessionId}`);
            return;
        }

        // Keyframe scan for copy-mode renditions (use first copy-mode rendition)
        const copyRendition = renditions.find((r) => r.canCopy);
        const boundaries = copyRendition
            ? await this.scanKeyframes(filePath, copyRendition.videoIndex)
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
            .map((r) => `${r.width}x${r.height}(${r.canCopy ? 'copy' : 'transcode'})`)
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
    // Private
    // -----------------------------------------------------------------------

    /** Select audio tracks for preview: one per language, or treat each as distinct when no language metadata */
    private selectAudioTracks(probe: ProbeResult): PreviewAudioTrack[] {
        const tracks = probe.audioTracks;
        if (tracks.length <= 1) {
            return tracks.map((t, i) => ({
                index: i,
                streamIndex: t.index,
                language: t.language,
                name: t.name,
                isDefault: i === 0,
            }));
        }

        const byLanguage = new Map<string, AudioTrackInfo[]>();
        for (const t of tracks) {
            const lang = t.language ?? 'und';
            if (!byLanguage.has(lang)) byLanguage.set(lang, []);
            byLanguage.get(lang)!.push(t);
        }

        const selected: PreviewAudioTrack[] = [];
        for (const [lang, group] of byLanguage) {
            if (group.length > 1 && lang === 'und') {
                const bitrates = group.map((t) => t.bitrateKbps).filter((b) => b > 0);
                const isQualityTiers = bitrates.length > 1 &&
                    Math.max(...bitrates) / Math.max(Math.min(...bitrates), 1) > 1.5;

                if (!isQualityTiers) {
                    for (const t of group) {
                        selected.push({
                            index: selected.length,
                            streamIndex: t.index,
                            language: t.language,
                            name: t.name ?? `Track ${selected.length + 1}`,
                            isDefault: false,
                        });
                    }
                    continue;
                }
            }

            const eligible = group.filter((t) => t.bitrateKbps <= MAX_AUDIO_BITRATE_KBPS);
            let pick: AudioTrackInfo;
            if (eligible.length > 0) {
                pick = eligible.reduce((a, b) => a.bitrateKbps >= b.bitrateKbps ? a : b);
            } else {
                pick = group.reduce((a, b) => a.bitrateKbps <= b.bitrateKbps ? a : b);
            }
            selected.push({
                index: selected.length,
                streamIndex: pick.index,
                language: pick.language,
                name: pick.name,
                isDefault: false,
            });
        }

        if (selected.length > 0) selected[0].isDefault = true;
        return selected;
    }

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
        filePath: string,
        videoStreamIndex: number,
    ): Promise<SegmentBoundary[]> {
        const tmpDir = join(filePath, '..', 'kfscan');
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
            lines.push(
                `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}`,
                `r${i}/playlist.m3u8`,
            );
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

        const videoMap = `0:v:${rendition.videoIndex}`;
        const audioTrack = state.audioTracks[audioTrackIndex ?? 0] ?? null;
        const audioMap = audioTrack ? `0:a:${audioTrack.streamIndex}` : null;

        const args = [
            '-ss', String(start),
            '-t', String(segDur),
            '-i', state.filePath,
            '-map', videoMap,
        ];
        if (audioMap) args.push('-map', audioMap);

        if (rendition.canCopy) {
            args.push('-c:v', 'copy');
        } else {
            args.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-tune', 'zerolatency',
            );
            if (rendition.scaleFilter) {
                args.push('-vf', `scale=${rendition.scaleFilter}`);
            }
        }

        if (audioMap) args.push('-c:a', 'aac', '-b:a', '128k');
        // Output to stdout (pipe:1) instead of file — avoids race where
        // execFile callback fires before FFmpeg's file write is fsynced
        args.push('-f', 'mpegts', 'pipe:1');

        this.logger.debug(`Segment r${renditionIndex}/s${segmentIndex}`);

        // Wait for a concurrency slot
        await this.acquireSlot();

        try {
            const timeout = rendition.canCopy ? 30_000 : 120_000;
            const { stdout } = await execFileAsync('ffmpeg', args, {
                timeout,
                maxBuffer: 50 * 1024 * 1024,
                encoding: 'buffer' as BufferEncoding,
            });
            // Write segment data ourselves — guaranteed flushed via writeFile
            await writeFile(outputPath, stdout);
        } catch (e: any) {
            this.logger.error(`Segment r${renditionIndex}/s${segmentIndex} failed: ${e.message}`);
            throw e;
        } finally {
            this.releaseSlot();
        }

        return outputPath;
    }
}
