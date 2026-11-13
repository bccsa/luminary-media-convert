import { Injectable, Logger } from '@nestjs/common';
import {
    aacArgs,
    decodeArgs,
    previewVideoArgs,
    USE_YOUR_OWN_FFMPEG,
    type AccelMode,
} from './encoder-selection';
import { tryAcquireEncoderSession } from './encoder-sessions';
import { GpuLoadMonitor, gpuLoadSampler } from './gpu-load';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import type { ReadStream } from 'fs';
import { SessionService } from './session.service.js';
import type { ProbeResult, VideoTrackInfo } from './probe.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { ffmpegBin, ffprobeBin } from './ffbin.js';
import { displayDimensionsOf, isAnamorphic } from './aspect.js';

export interface PreviewAudioTrack {
    index: number;
    streamIndex: number;
    language?: string;
    name?: string;
    bitrateKbps?: number;
    codec?: string;
    isDefault: boolean;
    sampleRate?: number;
    channels?: number;
    /** Where the track begins in the source, which can be well after the picture. */
    startTime?: number;
}

const execFileAsync = promisify(execFile);

/**
 * The audio of a segment the track has not fully reached yet, or null when it
 * has. The player only plays where it holds both picture and sound, so a span
 * with picture alone never plays and a seek into it never lands: the missing
 * part has to be silence rather than nothing.
 */
function lateAudioFilter(
    track: PreviewAudioTrack | undefined,
    start: number,
    segDur: number,
    audioInput: number
): string | null {
    const audioStart = track?.startTime ?? 0;
    if (!track || audioStart - start <= LANDING_TOLERANCE_SECONDS) return null;
    const sampleRate = track.sampleRate ?? 48000;
    if (audioStart >= start + segDur) {
        return (
            `anullsrc=r=${sampleRate}:cl=${track.channels ?? 2}c,` +
            `atrim=duration=${segDur},asetpts=N/SR/TB+${start}/TB[a]`
        );
    }
    const firstPts = Math.round(start * sampleRate);
    return `[${audioInput}:a:${track.streamIndex}]aresample=async=1:first_pts=${firstPts}[a]`;
}

/**
 * Whether a video stream can be remuxed into the preview's MPEG-TS as it is.
 *
 * H.264 only: hls.js demuxes nothing else out of MPEG-TS. And only 8-bit 4:2:0,
 * the one H.264 a browser decodes — High 10 and 4:2:2 are H.264 too. A probe
 * from before the pixel format was reported is taken to be the common case.
 *
 * Never an anamorphic stream, however cheap it would be. A copied preview
 * carries the source's own sample aspect ratio, leaving the picture correct
 * only if the browser honours SAR in MPEG-TS; transcoding it costs a preview
 * and settles the question.
 */
function canCopyToTs(track: VideoTrackInfo): boolean {
    if (track.codec.toLowerCase() !== 'h264') return false;
    if (track.pixFmt && !['yuv420p', 'yuvj420p'].includes(track.pixFmt)) {
        return false;
    }
    return !isAnamorphic(track);
}

const SEGMENT_DURATION = 4;
/**
 * The tallest a converted preview is made. Copied streams keep their own size:
 * remuxing costs the same whatever the size, and the browser scales.
 */
const MAX_PREVIEW_HEIGHT = 720;

/**
 * How long a session's converted preview stays on the CPU after a GPU segment
 * came back slower than real time, ms. The GPU was busy enough to stall the
 * player; asking it again on the very next segment would stall it again.
 */
const SLOW_GPU_COOLDOWN_MS = 30_000;

/** GPU-capable modes: the ones whose preview segments compete with the ladder for the device. */
const GPU_MODES = new Set<AccelMode>(['nvidia', 'apple', 'intel', 'amd']);

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
    /**
     * Until when (a `Date.now()` time) this preview's transcoded segments are
     * made on the CPU, because a GPU segment came back slower than real time.
     */
    cpuUntil: number;
    /** Median keyframe spacing of the scanned stream's grid, seconds. */
    keyframeStep?: number;
    /**
     * Measured seek hop per rendition index — see {@link extractSegment}. A
     * rendition learns its hop on its first extraction and every later
     * segment starts exactly on its boundary, first try.
     */
    seekHops: Map<number, number>;
    /**
     * The in-flight learning for a rendition that has no hop yet.
     *
     * Prefetch starts several segments of one rendition at once, so without
     * this they would all find `seekHops` empty, all probe, and the last write
     * would win — and the writers disagree, because the segment holding the
     * file head lands within tolerance and keeps the aimed hop while a real
     * miss corrects it. One learns; the rest wait for it.
     */
    seekHopLearners: Map<number, Promise<number>>;
}

const MAX_CONCURRENT = 3;

/** Thrown when a measured hop is not trustworthy enough to cache. */
class UnlearnedHop extends Error {}

/** Keeps a seek target strictly past a boundary the landing rule compares ≤. */
const SEEK_AIM_EPSILON_SECONDS = 0.001;

/**
 * How far a measured landing may sit from its boundary and still count as on
 * it. Generous because misses are whole keyframe intervals, and the segment
 * holding the file head is legitimately late by the stream's reorder delay.
 */
const LANDING_TOLERANCE_SECONDS = 0.1;

@Injectable()
export class PreviewService {
    private readonly logger = new Logger(PreviewService.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');
    private readonly states = new Map<string, PreviewState>();
    private readonly pending = new Map<string, Promise<string>>();
    /** Builds in progress, so concurrent requests share one keyframe scan. */
    private readonly building = new Map<string, Promise<void>>();
    // Concurrency limiter for FFmpeg processes
    private activeCount = 0;
    private readonly waitQueue: Array<() => void> = [];
    /** Made on the first transcoded segment, once the encoder is known. */
    private gpuLoad: GpuLoadMonitor | null = null;

    constructor(
        private readonly sessionService: SessionService,
        private readonly ffmpegService: FfmpegService
    ) {}

    async init(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session?.filePath || !session.probeResult) {
            this.logger.warn(
                `Cannot init preview for ${sessionId}: no file or probe`
            );
            return;
        }

        const { filePath, probeResult } = session;
        // Under the session's work directory, never beside the source file:
        // a shared folder like ~/Downloads would share one cache across every
        // session and file previewed from it, serving stale segments by index.
        const previewDir = join(this.workDir, sessionId, 'preview');
        await mkdir(previewDir, { recursive: true });

        const duration = probeResult.format.duration;
        const audioTracks = this.selectAudioTracks(probeResult);

        // Build renditions from available video tracks, or a single
        // audio-only rendition when the source has no video tracks.
        let renditions = this.buildRenditions(probeResult);
        if (renditions.length === 0) {
            if (audioTracks.length === 0) {
                this.logger.warn(
                    `No suitable video renditions for ${sessionId}`
                );
                return;
            }
            renditions = [
                {
                    videoIndex: -1,
                    width: 0,
                    height: 0,
                    bitrateKbps: 128,
                    canCopy: false,
                    audioOnly: true,
                },
            ];
        }

        // Keyframe scan for copy-mode renditions (skipped for audio-only)
        const copyRendition = renditions.find((r) => r.canCopy);
        const scan = copyRendition
            ? await this.scanKeyframes(
                  sessionId,
                  filePath,
                  copyRendition.videoIndex,
                  duration
              )
            : { boundaries: [], keyframeStep: undefined };
        const boundaries = scan.boundaries;

        // Generate playlists
        const mediaPlaylists = renditions.map((_, i) =>
            this.generateMediaPlaylist(boundaries, duration, i)
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
            cpuUntil: 0,
            keyframeStep: scan.keyframeStep,
            seekHops: new Map(),
            seekHopLearners: new Map(),
        });

        const renditionSummary = renditions
            .map((r) =>
                r.audioOnly
                    ? 'audio-only(aac)'
                    : `${r.width}x${r.height}(${r.canCopy ? 'copy' : 'transcode'})`
            )
            .join(', ');
        const audioSummary =
            audioTracks.length > 1
                ? `, ${audioTracks.length} audio track(s) [${audioTracks.map((a) => a.language ?? a.name ?? 'und').join(', ')}]`
                : '';
        this.logger.log(
            `Preview initialized for ${sessionId}: ${renditions.length} rendition(s) [${renditionSummary}]${audioSummary}, ` +
                `${boundaries.length || Math.ceil(duration / SEGMENT_DURATION)} segments`
        );
    }

    isReady(sessionId: string): boolean {
        return this.states.has(sessionId);
    }

    /**
     * Whether the session has a preview, building it first when it can.
     *
     * Built on the first request rather than when the file arrives: most
     * sources play directly in the browser and never ask for one, and the
     * keyframe scan a copied preview needs reads the whole file. The state
     * lives in memory, so a session restored after a restart builds it again
     * the same way, and finds its cached segments where it left them.
     *
     * The preview is always the whole source. Cuts are skipped by the player as
     * it plays, before the encode and during it alike, so nothing here knows of
     * them.
     */
    async ensureReady(sessionId: string): Promise<boolean> {
        if (this.states.has(sessionId)) return true;
        const session = this.sessionService.get(sessionId);
        if (!session?.filePath || !session.probeResult) return false;

        let build = this.building.get(sessionId);
        if (!build) {
            build = this.init(sessionId).finally(() =>
                this.building.delete(sessionId)
            );
            this.building.set(sessionId, build);
        }
        try {
            await build;
        } catch (err) {
            this.logger.warn(
                `Could not rebuild the preview for ${sessionId}: ${(err as Error).message}`
            );
            return false;
        }

        return this.states.has(sessionId);
    }

    /** Get master or media playlist */
    getPlaylist(
        sessionId: string,
        token: string,
        renditionIndex?: number,
        audioTrackIndex?: number
    ): string | null {
        const state = this.states.get(sessionId);
        if (!state) return null;

        let playlist: string;
        if (
            renditionIndex !== undefined &&
            renditionIndex < state.mediaPlaylists.length
        ) {
            playlist = state.mediaPlaylists[renditionIndex];
        } else {
            playlist = state.masterPlaylist;
        }

        // Append token (and audio track for cache isolation) to all URLs
        const audioParam =
            audioTrackIndex !== undefined && state.audioTracks.length > 1
                ? `&audio=${audioTrackIndex}`
                : '';
        return playlist.replace(
            /((?:segment\d+\.ts|r\d+\/playlist\.m3u8))/g,
            `$1?token=${token}${audioParam}`
        );
    }

    /** Get a segment file stream, extracting on demand if not cached */
    async getSegmentStream(
        sessionId: string,
        renditionIndex: number,
        segmentIndex: number,
        audioTrackIndex?: number
    ): Promise<{ stream: ReadStream; size: number } | null> {
        const state = this.states.get(sessionId);
        if (!state) return null;
        if (renditionIndex < 0 || renditionIndex >= state.renditions.length)
            return null;

        const totalSegments =
            state.segmentBoundaries.length > 0
                ? state.segmentBoundaries.length
                : Math.ceil(state.duration / SEGMENT_DURATION);
        if (segmentIndex < 0 || segmentIndex >= totalSegments) return null;

        const ai = audioTrackIndex ?? 0;
        // Cache segments per (rendition, audioTrack) pair when multi-audio
        const cacheDir =
            state.audioTracks.length > 1
                ? `r${renditionIndex}a${ai}`
                : `r${renditionIndex}`;
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
            promise = this.extractSegment(
                state,
                renditionIndex,
                segmentIndex,
                segPath,
                ai
            );
            promise.catch(() => {}); // prevent unhandled rejection if cancelled
            this.pending.set(cacheKey, promise);
            promise
                .finally(() => this.pending.delete(cacheKey))
                .catch(() => {});
        }

        try {
            await promise;
        } catch (e: any) {
            this.logger.warn(
                `Segment ${cacheDir}/s${segmentIndex} extraction error: ${e.message}`
            );
            return null;
        }

        if (existsSync(segPath)) {
            const s = await stat(segPath);
            if (s.size > 0) {
                this.prefetchSegments(
                    sessionId,
                    state,
                    cacheDir,
                    renditionIndex,
                    segmentIndex + 1,
                    3,
                    ai
                );
                return { stream: createReadStream(segPath), size: s.size };
            }
            this.logger.warn(
                `Segment r${renditionIndex}/s${segmentIndex} produced empty file, deleting`
            );
            await rm(segPath, { force: true }).catch(() => {});
        } else {
            this.logger.warn(
                `Segment r${renditionIndex}/s${segmentIndex} file not found after extraction`
            );
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
        audioTrackIndex: number
    ): void {
        const totalSegments =
            state.segmentBoundaries.length > 0
                ? state.segmentBoundaries.length
                : Math.ceil(state.duration / SEGMENT_DURATION);

        for (
            let i = startIndex;
            i < startIndex + count && i < totalSegments;
            i++
        ) {
            const segPath = join(state.previewDir, cacheDir, `segment${i}.ts`);
            const cacheKey = `${sessionId}:${cacheDir}:${i}`;

            if (existsSync(segPath) || this.pending.has(cacheKey)) continue;

            const promise = this.extractSegment(
                state,
                renditionIndex,
                i,
                segPath,
                audioTrackIndex
            );
            promise.catch(() => {});
            this.pending.set(cacheKey, promise);
            promise
                .finally(() => this.pending.delete(cacheKey))
                .catch(() => {});
        }
    }

    async destroy(sessionId: string): Promise<void> {
        const state = this.states.get(sessionId);
        if (!state) return;
        this.states.delete(sessionId);
        await rm(state.previewDir, { recursive: true, force: true }).catch(
            () => {}
        );
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
            sampleRate: t.sampleRate,
            channels: t.channels,
            startTime: t.startTime,
        }));
    }

    // -----------------------------------------------------------------------
    // Private: rendition building
    // -----------------------------------------------------------------------

    /**
     * One rendition of the first video stream: copied when the browser can
     * decode it as it is, transcoded to at most {@link MAX_PREVIEW_HEIGHT}
     * otherwise.
     *
     * One, not a ladder. The preview is played on the machine that makes it, so
     * there is no connection to adapt to — and every extra rung was another
     * segment encoded on the same GPU the encode itself needs. A file's other
     * video streams are not offered: the sources that need this preview at all
     * are ones the browser cannot play, and its first camera is enough to cut by.
     */
    private buildRenditions(probe: ProbeResult): Rendition[] {
        const v = probe.videoTracks[0];
        if (!v) return [];

        if (canCopyToTs(v)) {
            return [
                {
                    videoIndex: v.index,
                    width: v.width,
                    height: v.height,
                    bitrateKbps: v.bitrateKbps,
                    canCopy: true,
                },
            ];
        }

        // Display dimensions: the preview has to show the picture's real shape,
        // and for an anamorphic source its coded size is not it.
        const display = displayDimensionsOf(v);
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
        const h = even(Math.min(MAX_PREVIEW_HEIGHT, display.height));
        const w = even((display.width * h) / display.height);
        return [
            {
                videoIndex: v.index,
                width: w,
                height: h,
                bitrateKbps: Math.round(h * 2), // rough estimate
                canCopy: false,
                // Both dimensions stated, never `-2`: that derives the height
                // from the *input's storage* ratio, so `scale=854:-2` on a
                // 720x576 input gives 683, not 480.
                scaleFilter: `${w}:${h}`,
            },
        ];
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
        duration: number
    ): Promise<{ boundaries: SegmentBoundary[]; keyframeStep?: number }> {
        try {
            const keyframes = await this.ffmpegService.scanKeyframeGrid(
                filePath,
                videoStreamIndex,
                join(this.workDir, sessionId, 'kfscan')
            );
            let keyframeStep: number | undefined;
            if (keyframes.length >= 2) {
                const gaps = keyframes
                    .slice(1)
                    .map((k, i) => k - keyframes[i])
                    .sort((a, b) => a - b);
                keyframeStep = gaps[Math.floor(gaps.length / 2)];
            }
            return {
                boundaries: this.groupKeyframes(keyframes, duration),
                keyframeStep,
            };
        } catch (e) {
            this.logger.warn(`Keyframe scan failed: ${e}`);
            return { boundaries: [] };
        }
    }

    /**
     * Keyframes grouped into preview segments, the way a segment muxer asked
     * for {@link SEGMENT_DURATION} would have cut them: a segment ends at the
     * first keyframe at or past the next whole multiple of the target, so a
     * keyframe that arrives late does not push every later boundary with it.
     *
     * The last segment runs to the source duration — a keyframe grid says
     * where keyframes are, not where the file ends.
     */
    private groupKeyframes(
        keyframes: number[],
        duration: number
    ): SegmentBoundary[] {
        if (keyframes.length === 0) return [];
        const boundaries: SegmentBoundary[] = [];
        let start = keyframes[0];
        for (const keyframe of keyframes.slice(1)) {
            if (keyframe < SEGMENT_DURATION * (boundaries.length + 1)) continue;
            boundaries.push({ start, duration: keyframe - start });
            start = keyframe;
        }
        boundaries.push({ start, duration: Math.max(0, duration - start) });
        return boundaries;
    }

    private generateMasterPlaylist(renditions: Rendition[]): string {
        const lines = ['#EXTM3U'];
        for (let i = 0; i < renditions.length; i++) {
            const r = renditions[i];
            const bandwidth = r.bitrateKbps * 1000;
            if (r.audioOnly) {
                lines.push(
                    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="mp4a.40.2"`,
                    `r${i}/playlist.m3u8`
                );
            } else {
                lines.push(
                    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}`,
                    `r${i}/playlist.m3u8`
                );
            }
        }
        lines.push('');
        return lines.join('\n');
    }

    private generateMediaPlaylist(
        boundaries: SegmentBoundary[],
        duration: number,
        renditionIndex: number
    ): string {
        const segCount =
            boundaries.length > 0
                ? boundaries.length
                : Math.ceil(duration / SEGMENT_DURATION);

        let maxDuration = SEGMENT_DURATION;
        if (boundaries.length > 0) {
            maxDuration = Math.ceil(
                Math.max(...boundaries.map((b) => b.duration))
            );
        }

        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${maxDuration}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD',
        ];

        // No per-segment discontinuities: segments are extracted with -copyts,
        // so consecutive segments share one continuous timestamp domain. A
        // discontinuity here would make the player stitch by EXTINF instead
        // and replay each segment's seek lead-in at every boundary.
        for (let i = 0; i < segCount; i++) {
            const segDur =
                boundaries.length > 0
                    ? boundaries[i].duration
                    : Math.min(
                          SEGMENT_DURATION,
                          duration - i * SEGMENT_DURATION
                      );
            lines.push(`#EXTINF:${segDur.toFixed(3)},`);
            lines.push(`segment${i}.ts`);
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
        accelMode: AccelMode,
        useGpu: boolean,
        /**
         * Where the copy path asks the demuxer to seek — ahead of `start` by
         * the rendition's seek hop, so the landing IS the boundary. See
         * {@link extractSegment}; ignored by the transcode and audio paths,
         * whose accurate seek has no hop.
         */
        copySeekStart = start,
        audioTrack?: PreviewAudioTrack,
        /** Where the segment goes: a file, or `pipe:1`. */
        output = 'pipe:1'
    ): string[] {
        const args: string[] = [];

        // Every segment keeps the source's own timestamps (-copyts, with the
        // mpegts muxer's fixed 1.4 s preload/delay offset zeroed). The media
        // playlists declare no per-segment discontinuities, so this is what
        // stitches independently extracted segments together: content is
        // placed by timestamp, and a segment that starts exactly on its
        // boundary needs no placing at all.
        const TS_OUTPUT = [
            '-copyts',
            '-muxdelay',
            '0',
            '-muxpreload',
            '0',
            '-f',
            'mpegts',
            ...(output === 'pipe:1' ? [] : ['-y']),
            output,
        ];

        if (rendition.audioOnly) {
            args.push(
                '-ss',
                String(start),
                '-t',
                String(segDur),
                '-i',
                filePath,
                '-vn'
            );
            if (audioMap) args.push('-map', audioMap);
            args.push(...aacArgs(), '-b:a', '128k', ...TS_OUTPUT);
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
        args.push(...decodeArgs(accelMode, 'preview', useGpu));

        if (rendition.canCopy) {
            // The demuxer lands on the largest keyframe at or before the seek
            // target minus the stream's hop, so the copy path aims past the
            // boundary by that hop, and `-to` (absolute under -copyts) ends
            // the segment exactly where the playlist says it does — the aim
            // must not stretch the tail the way `-t` from the target would.
            //
            // Audio gets the same file as a second input, seeked to the
            // boundary itself: it is transcoded, and a transcode's accurate
            // seek drops everything before its target — fed the video's
            // aimed seek it would start a whole keyframe interval late, an
            // audio hole at the head of every segment that plays as a stall.
            args.push(
                '-ss',
                String(copySeekStart),
                '-i',
                filePath,
                ...(audioMap ? ['-ss', String(start), '-i', filePath] : [])
            );
            const lateAudio = lateAudioFilter(audioTrack, start, segDur, 1);
            if (lateAudio) args.push('-filter_complex', lateAudio);
            args.push('-map', videoMap);
            if (lateAudio) args.push('-map', '[a]');
            else if (audioMap)
                args.push('-map', audioMap.replace(/^0:/, '1:'));
            args.push('-c:v', 'copy', '-to', String(start + segDur));
            if (audioMap) args.push(...aacArgs(), '-b:a', '128k');
            args.push(...TS_OUTPUT);
            return args;
        }

        args.push(
            '-ss',
            String(start),
            '-t',
            String(segDur),
            '-i',
            filePath
        );
        const lateAudio = lateAudioFilter(audioTrack, start, segDur, 0);
        if (lateAudio) args.push('-filter_complex', lateAudio);
        args.push('-map', videoMap);
        if (lateAudio) args.push('-map', '[a]');
        else if (audioMap) args.push('-map', audioMap);

        args.push(
            ...previewVideoArgs(accelMode, useGpu, rendition.scaleFilter)
        );

        if (audioMap) args.push(...aacArgs(), '-b:a', '128k');
        args.push(...TS_OUTPUT);

        return args;
    }

    private async extractSegment(
        state: PreviewState,
        renditionIndex: number,
        segmentIndex: number,
        outputPath: string,
        audioTrackIndex?: number
    ): Promise<string> {
        const rendition = state.renditions[renditionIndex];
        const boundary = state.segmentBoundaries[segmentIndex];
        const start = boundary?.start ?? segmentIndex * SEGMENT_DURATION;
        const segDur =
            boundary?.duration ??
            Math.min(SEGMENT_DURATION, state.duration - start);

        // Ensure output directory exists
        await mkdir(join(outputPath, '..'), { recursive: true });

        const videoMap = rendition.audioOnly
            ? ''
            : `0:v:${rendition.videoIndex}`;
        const audioTrack = state.audioTracks[audioTrackIndex ?? 0] ?? null;
        const audioMap = audioTrack ? `0:a:${audioTrack.streamIndex}` : null;

        const accelMode = this.ffmpegService.getAccelMode();
        const transcodes = !rendition.canCopy && !rendition.audioOnly;
        // Decided below, once a process slot is held: the GPU's state is read
        // as close to the encode as it can be.
        let useGpu = false;
        const partPath = `${outputPath}.part`;

        const runOnce = async (copySeekStart: number): Promise<void> => {
            const args = this.buildSegmentArgs(
                state.filePath,
                start,
                segDur,
                videoMap,
                audioMap,
                rendition,
                accelMode,
                useGpu,
                copySeekStart,
                audioTrack ?? undefined,
                partPath
            );
            const timeout = rendition.canCopy ? 30_000 : 120_000;

            // Straight to a file, not through a buffer: a copied segment is the
            // source's own bitrate, and a 4K one outgrows any buffer worth
            // holding. Written aside and renamed into place, so a process killed
            // half-way leaves nothing a later request would serve as a segment.
            //
            // No retry on the CPU after a GPU failure: the GPU's own error is
            // the one worth reporting, and a starved GPU is steered around
            // before the segment starts rather than after it fails.
            await execFileAsync(ffmpegBin(), args, {
                timeout,
                maxBuffer: 4 * 1024 * 1024,
            }).catch(async (err: any) => {
                await rm(partPath, { force: true }).catch(() => {});
                const via = useGpu
                    ? accelMode
                    : rendition.canCopy
                      ? 'stream copy'
                      : 'cpu';
                // The substitution hint belongs to encoder failures: a copied
                // segment never opened an encoder, so a different FFmpeg is not
                // the remedy for whatever stopped it.
                const hint = rendition.canCopy
                    ? ''
                    : `\n\n${USE_YOUR_OWN_FFMPEG}`;
                throw new Error(
                    `Preview segment r${renditionIndex}/s${segmentIndex} failed on ` +
                        `${via}: ${err.message}${hint}`
                );
            });

            await rename(partPath, outputPath);
        };

        // Wait for a concurrency slot
        await this.acquireSlot();

        let releaseEncoderSession: () => void = () => {};

        try {
            if (transcodes) {
                const gpu = this.claimGpu(state, accelMode);
                useGpu = gpu.useGpu;
                releaseEncoderSession = gpu.release;
                this.logger.debug(
                    `Segment r${renditionIndex}/s${segmentIndex} (${useGpu ? accelMode : `cpu: ${gpu.why}`})`
                );
            }

            if (!rendition.canCopy || !state.keyframeStep) {
                const startedAt = Date.now();
                await runOnce(start);
                if (useGpu) this.noteGpuSegmentTime(state, startedAt);
                return outputPath;
            }

            // The copy path aims past the boundary by the rendition's seek
            // hop — the demuxer lands on the largest keyframe at or before
            // target minus hop, one keyframe interval for streams other than
            // the file's default and zero for it. A segment that starts a
            // whole GOP before its boundary played as a jump-back at every
            // boundary once the overlap grew past what the player's
            // timestamp handling absorbs. The hop is learned from the first
            // extraction of each rendition and every later segment starts on
            // its boundary, first try.
            const known = state.seekHops.get(renditionIndex);
            if (known !== undefined) {
                await runOnce(start + known + SEEK_AIM_EPSILON_SECONDS);
                return outputPath;
            }

            const learning = state.seekHopLearners.get(renditionIndex);
            if (learning) {
                // Another segment of this rendition is measuring the hop.
                // Waiting costs a slot but saves a probe and a re-extraction,
                // and avoids two learners writing different answers.
                const learned = await learning;
                await runOnce(start + learned + SEEK_AIM_EPSILON_SECONDS);
                return outputPath;
            }

            const learn = (async (): Promise<number> => {
                let hop = state.keyframeStep as number;
                await runOnce(start + hop + SEEK_AIM_EPSILON_SECONDS);

                // No video packet is a miss too: when a segment is one GOP
                // long, landing a GOP late leaves nothing before `-to`, and a
                // hop cached from that ships every segment without a picture.
                const landed = await this.probeFirstVideoPts(outputPath);
                if (
                    landed === null ||
                    Math.abs(landed - start) > LANDING_TOLERANCE_SECONDS
                ) {
                    const corrected =
                        landed === null
                            ? 0
                            : Math.max(0, hop + (start - landed));
                    this.logger.warn(
                        `Segment r${renditionIndex}/s${segmentIndex} ` +
                            (landed === null
                                ? 'has no video'
                                : `landed at ${landed.toFixed(3)}s`) +
                            ` for ${start.toFixed(3)}s — ` +
                            `re-extracting with a ${corrected.toFixed(3)}s seek hop`
                    );
                    await runOnce(start + corrected + SEEK_AIM_EPSILON_SECONDS);
                    hop = corrected;

                    // The correction is checked rather than assumed: a hop is
                    // cached for the session's remaining segments, and one that
                    // is wrong mis-starts every one of them with no further
                    // probe to notice.
                    const after = await this.probeFirstVideoPts(outputPath);
                    if (
                        after === null ||
                        Math.abs(after - start) > LANDING_TOLERANCE_SECONDS
                    ) {
                        this.logger.warn(
                            `Segment r${renditionIndex}/s${segmentIndex} still ` +
                                (after === null
                                    ? 'has no video'
                                    : `landed at ${after.toFixed(3)}s`) +
                                ' — leaving the hop unlearned so the next ' +
                                'segment measures again'
                        );
                        throw new UnlearnedHop();
                    }
                }
                state.seekHops.set(renditionIndex, hop);
                return hop;
            })();

            state.seekHopLearners.set(renditionIndex, learn);
            try {
                await learn;
            } catch (e) {
                // An unlearned hop is not a failed segment: the extraction ran
                // and its output is on disk, just not from a hop worth caching.
                if (!(e instanceof UnlearnedHop)) throw e;
            } finally {
                state.seekHopLearners.delete(renditionIndex);
            }
        } catch (e: any) {
            this.logger.error(
                `Segment r${renditionIndex}/s${segmentIndex} failed: ${e.message}`
            );
            throw e;
        } finally {
            releaseEncoderSession();
            this.releaseSlot();
        }

        return outputPath;
    }

    /**
     * Whether a transcoded segment is made on the GPU or the CPU, and the
     * encoder session it holds if the GPU.
     *
     * The GPU when it can take the segment now; the operating system's software
     * encoder when it cannot. "Cannot" is any of three things, each cheap to
     * know: every encoder session is held (the ladder's waves take them all),
     * the GPU reads as saturated, or its last segment for this preview came back
     * slower than real time. Waiting for the GPU instead is what made the
     * preview stall the moment an encode started.
     *
     * Two separate limits meet here. The process slot already held bounds this
     * service's own ffmpeg processes; the encoder session bounds hardware
     * encode sessions, whose cap belongs to the graphics driver and is shared
     * with the ladder. Only a GPU segment takes a session — a CPU one, a copy
     * and an audio-only segment open no hardware encoder.
     */
    private claimGpu(
        state: PreviewState,
        accelMode: AccelMode
    ): { useGpu: boolean; release: () => void; why?: string } {
        const cpu = (why: string) => ({ useGpu: false, release: () => {}, why });
        if (!GPU_MODES.has(accelMode)) return cpu('no GPU encoder');

        this.gpuLoad ??= new GpuLoadMonitor(gpuLoadSampler(accelMode));
        this.gpuLoad.noteDemand();

        if (Date.now() < state.cpuUntil) return cpu('the GPU was slow');
        if (this.gpuLoad.isStarved()) {
            return cpu(`the GPU is at ${this.gpuLoad.utilisation}%`);
        }
        const release = tryAcquireEncoderSession();
        if (!release) return cpu('every encoder session is in use');
        return { useGpu: true, release };
    }

    /** A GPU segment slower than real time puts the preview on the CPU for a while. */
    private noteGpuSegmentTime(state: PreviewState, startedAt: number): void {
        const took = Date.now() - startedAt;
        if (took <= SEGMENT_DURATION * 1000) return;
        state.cpuUntil = Date.now() + SLOW_GPU_COOLDOWN_MS;
        this.logger.log(
            `Preview segment took ${(took / 1000).toFixed(1)}s on the GPU; ` +
                `making this preview on the CPU for ${SLOW_GPU_COOLDOWN_MS / 1000}s`
        );
    }

    /** First video packet presentation time of a segment, or null. */
    private async probeFirstVideoPts(path: string): Promise<number | null> {
        try {
            const { stdout } = await execFileAsync(ffprobeBin(), [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'packet=pts_time',
                '-of',
                'csv=p=0',
                '-read_intervals',
                '%+#1',
                path,
            ]);
            const value = parseFloat(String(stdout).trim().split(',')[0]);
            return Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    }
}
