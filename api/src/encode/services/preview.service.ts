import { Injectable, Logger } from '@nestjs/common';
import {
    aacArgs,
    decodeArgs,
    previewVideoArgs,
    USE_YOUR_OWN_FFMPEG,
    type AccelMode,
} from './encoder-selection';
import {
    acquireEncoderSession,
    forgetPreviewSession,
    notePreviewNeedsSession,
} from './encoder-sessions';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, open, readdir, rename, rm, stat } from 'fs/promises';
import type { ReadStream } from 'fs';
import { SessionService } from './session.service.js';
import {
    GOP_SAMPLE_FRAMES,
    type ProbeResult,
    type VideoTrackInfo,
} from './probe.service.js';
import { selectStoryboardTrack } from './thumbnail.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { ffmpegBin, ffprobeBin } from './ffbin.js';
import { displayDimensionsOf, isAnamorphic } from './aspect.js';
import { defaultAngleTracks } from './picture-groups.js';

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
 * The segment cache's folder under `preview/`, renamed whenever what a cached
 * segment *is* changes. Sessions and their caches outlive the app that made
 * them, and `r0/segment3.ts` from a build that transcoded a 480p ladder is not
 * segment 3 of a rendition that is now copied at native size on other
 * boundaries. Anything beside this folder is an older build's and is removed.
 */
const CACHE_VERSION = 'v2';

/** How many segments past the one asked for are made ahead of the player. */
const PREFETCH_SEGMENTS = 3;

/** What the player is told when FFmpeg cannot make this file's preview. */
const PREVIEW_FAILED = 'FFmpeg could not convert this file for the preview.';

/**
 * How much of a copied rendition is kept on disk: about the last minute made,
 * and no more than this many bytes of it.
 *
 * A copied segment is the source's own bitrate, so keeping every one leaves a
 * second copy of the video in the work folder for as long as the session lives.
 * It is also cheap to make again — a remux, about half a second for four of a
 * 1080p file — so only what the player is near is worth holding. Transcoded
 * segments are small and expensive, and are all kept.
 */
const COPY_WINDOW_SEGMENTS = 16;
const COPY_WINDOW_BYTES = 500 * 1024 * 1024;
/** Never evicted: the segment just asked for and the ones prefetched behind it. */
const COPY_WINDOW_MIN_SEGMENTS = PREFETCH_SEGMENTS + 1;

/**
 * How far a rebuilt playlist's segment numbers start past the one it replaces.
 *
 * A playlist the player already holds cannot be taken back, and after a rebuild
 * its segment 12 is not the new playlist's segment 12. Numbering the new one
 * from here on keeps the two apart with nothing else to carry: a request off
 * the old playlist names a segment that no longer exists, and nothing cached
 * under an old number is ever asked for again.
 */
const REBUILD_INDEX_STEP = 1_000_000;

/**
 * The keyframe interval of a track that keeps one, in seconds, or null.
 *
 * From the probe's head sample, which is a few seconds of the file and not the
 * file. Trusted only when the interval was seen at least twice over: a single
 * interval is where two keyframes happened to fall — a scene cut, on an encoder
 * that places them by content — and says nothing about the next one.
 */
export function regularKeyframeInterval(track: VideoTrackInfo): number | null {
    const { gopFrames, gopRegular, frameRate } = track;
    if (!gopRegular || !gopFrames || !(frameRate > 0)) return null;
    if (gopFrames * 2 >= GOP_SAMPLE_FRAMES) return null;
    return gopFrames / frameRate;
}

/**
 * Segment boundaries for a track with a fixed keyframe interval: each segment a
 * whole number of intervals, the fewest that reach {@link SEGMENT_DURATION}.
 *
 * Counted in frames from the first keyframe, never by adding up an interval in
 * seconds: the probe rounds that to the millisecond, and a thousandth of a
 * second per keyframe is seconds by the end of an hour.
 *
 * `end` is where the file ends on the source's own clock, which is not its
 * duration when the container does not start at zero.
 *
 * A tail shorter than half an interval joins the segment before it. The
 * container's end is the longest stream's, and audio that outlasts the picture
 * by a few frames would otherwise get a segment of its own starting on a
 * keyframe that was never written.
 */
export function cadenceBoundaries(
    firstKeyframe: number,
    gopFrames: number,
    frameRate: number,
    end: number
): SegmentBoundary[] {
    const interval = gopFrames / frameRate;
    const perSegment = Math.max(
        1,
        Math.ceil(SEGMENT_DURATION / interval - 1e-9)
    );
    const at = (n: number) =>
        firstKeyframe + (n * perSegment * gopFrames) / frameRate;

    const boundaries: SegmentBoundary[] = [];
    for (let n = 0; at(n) < end; n++) {
        const start = at(n);
        if (boundaries.length > 0 && end - start < interval / 2) {
            const last = boundaries[boundaries.length - 1];
            last.duration = end - last.start;
            break;
        }
        boundaries.push({
            start,
            duration: Math.min(at(n + 1), end) - start,
        });
    }
    return boundaries;
}

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
    sessionId: string;
    filePath: string;
    duration: number;
    segmentBoundaries: SegmentBoundary[];
    audioTracks: PreviewAudioTrack[];
    renditions: Rendition[];
    /** `preview/` under the session's work directory: every cache version. */
    previewRoot: string;
    /** The cache of this build's segments, under {@link previewRoot}. */
    previewDir: string;
    masterPlaylist: string;
    mediaPlaylists: string[];
    /** The video stream being previewed; absent for an audio-only source. */
    videoTrack?: VideoTrackInfo;
    /**
     * The boundaries were worked out from the probe's keyframe interval rather
     * than read off the file, so each copied segment is checked for landing on
     * its boundary. False once a scan has supplied them.
     */
    boundariesComputed: boolean;
    /**
     * The number the playlists' first segment carries: 0, then a
     * {@link REBUILD_INDEX_STEP} further on with every rebuild.
     */
    indexBase: number;
    /** A rebuild from a keyframe scan in progress; playlist requests wait for it. */
    rebuild?: Promise<void>;
    /** A segment of this build has been made, so the file does convert. */
    madeSegment?: boolean;
    /**
     * Why no segment of this build can be made: FFmpeg failed the first one
     * outright. Every later request would fail the same way, so none is tried.
     */
    failure?: string;
    /**
     * VideoToolbox could not decode this source (MPEG-2, for one), so its
     * segments decode in software and still encode on VideoToolbox.
     */
    softwareDecode?: boolean;
    /** Median keyframe spacing of the stream's grid, seconds. */
    keyframeStep?: number;
    /** Where the container's own clock starts; see {@link CopyLayout.containerStart}. */
    containerStart: number;
    /**
     * How far past a boundary a copied segment's seek is aimed (on top of the
     * hop), so that the keyframe on the boundary is at or before the target.
     */
    seekAimEpsilon: number;
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

/**
 * Thrown when a copied segment of a computed layout does not start on its
 * boundary: the source is not on the keyframe interval its head showed.
 */
class OffCadence extends Error {}

/** Where a copied rendition's segments are cut, and how that was established. */
interface CopyLayout {
    boundaries: SegmentBoundary[];
    keyframeStep?: number;
    /** Worked out from the probe (true) or read off the file by a scan. */
    computed: boolean;
    seekAimEpsilon: number;
    /**
     * The timestamp the container starts at, seconds: zero for most files,
     * never for a transport stream.
     *
     * Boundaries are on the source's own clock, and so is everything written
     * (`-copyts`). A seek is not: ffmpeg counts `-ss` from the start of the
     * file and adds this to it. Asked to seek to a boundary as it is, it lands
     * this much late — on a later keyframe, or past the end of the file for a
     * broadcast recording whose clock starts hours in — so every seek on the
     * copy path has this taken off first.
     */
    containerStart: number;
}

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
    /** Sessions deleted while their preview was being built, which then stores nothing. */
    private readonly cancelled = new Set<string>();
    // Concurrency limiter for FFmpeg processes
    private activeCount = 0;
    private readonly waitQueue: Array<() => void> = [];

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
        const previewRoot = join(this.workDir, sessionId, 'preview');
        await mkdir(previewRoot, { recursive: true });
        const previewDir = join(previewRoot, CACHE_VERSION);
        await this.removeOlderCaches(previewRoot);

        const duration = probeResult.format.duration;
        const audioTracks = this.selectAudioTracks(probeResult);
        const videoTrack = this.selectVideoTrack(probeResult);

        // One rendition of the chosen video stream, or a single audio-only
        // rendition when the source has no video.
        let renditions = videoTrack ? [this.buildRendition(videoTrack)] : [];
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

        // A copied rendition is cut on keyframes, so it needs to know where
        // they are. A transcoded or audio-only one is cut wherever it is told.
        let layout: CopyLayout = {
            boundaries: [],
            computed: false,
            seekAimEpsilon: SEEK_AIM_EPSILON_SECONDS,
            containerStart: 0,
        };
        if (videoTrack && renditions[0].canCopy) {
            const found = await this.layoutCopy(
                sessionId,
                filePath,
                videoTrack,
                duration
            );
            if (found) {
                layout = found;
            } else {
                // Copied anyway, it would be cut on a grid its keyframes are
                // not on: every segment starting a keyframe interval early,
                // which plays as a jump back at each one.
                this.logger.warn(
                    `Preview of ${sessionId}: its keyframes could not be read, so it is transcoded instead of copied`
                );
                renditions = [this.transcodedRendition(videoTrack)];
            }
        }
        const boundaries = layout.boundaries;

        // The build can take as long as reading the whole file, and the session
        // can be deleted meanwhile. Stored then, the state would outlive it.
        if (
            this.cancelled.delete(sessionId) ||
            !this.sessionService.get(sessionId)
        ) {
            this.logger.log(
                `Preview of ${sessionId} dropped: the session was deleted while it was being built`
            );
            return;
        }

        // Generate playlists
        const mediaPlaylists = renditions.map((_, i) =>
            this.generateMediaPlaylist(boundaries, duration, i)
        );
        const masterPlaylist = this.generateMasterPlaylist(renditions);

        this.states.set(sessionId, {
            sessionId,
            filePath,
            duration,
            segmentBoundaries: boundaries,
            audioTracks,
            renditions,
            previewRoot,
            previewDir,
            masterPlaylist,
            mediaPlaylists,
            videoTrack,
            boundariesComputed: layout.computed,
            indexBase: 0,
            keyframeStep: layout.keyframeStep,
            containerStart: layout.containerStart,
            seekAimEpsilon: layout.seekAimEpsilon,
            seekHops: new Map(),
            seekHopLearners: new Map(),
        });
        if (renditions.some((r) => !r.canCopy && !r.audioOnly)) {
            notePreviewNeedsSession(sessionId);
        }

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
        const boundarySummary = !renditions[0].canCopy
            ? ''
            : layout.computed
              ? ', boundaries from the probe'
              : ', boundaries from a keyframe scan';
        this.logger.log(
            `Preview initialized for ${sessionId}: ${renditions.length} rendition(s) [${renditionSummary}]${audioSummary}, ` +
                `${boundaries.length || Math.ceil(duration / SEGMENT_DURATION)} segments${boundarySummary}`
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
     *
     * A rebuild in progress is waited for, so the playlists a caller reads next
     * are the rebuilt ones.
     */
    async ensureReady(sessionId: string): Promise<boolean> {
        const existing = this.states.get(sessionId);
        if (existing) {
            // A playlist read during a rebuild would be the one being replaced.
            if (existing.rebuild) await existing.rebuild.catch(() => {});
            return this.states.has(sessionId);
        }
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

        // The number in the URL counts from the playlist's base; one off a
        // playlist since rebuilt falls outside the range and is refused.
        const localIndex = segmentIndex - state.indexBase;
        if (localIndex < 0 || localIndex >= this.segmentCount(state)) {
            return null;
        }

        if (state.failure) return null;

        const ai = audioTrackIndex ?? 0;
        // Cache segments per (rendition, audioTrack) pair when multi-audio
        const cacheDir =
            state.audioTracks.length > 1
                ? `r${renditionIndex}a${ai}`
                : `r${renditionIndex}`;
        const segDir = join(state.previewDir, cacheDir);
        const segPath = join(segDir, `segment${segmentIndex}.ts`);

        // A segment evicted from the copy window is made again like any
        // other miss.
        const cached = await this.openSegment(segPath);
        if (cached) {
            state.madeSegment = true;
            return cached;
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
                localIndex,
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
            // FFmpeg that ran and refused before any segment was made would
            // refuse every one; one stopped (a timeout, a cancel) might not.
            if (e?.ffmpegFailed && !state.madeSegment && !state.failure) {
                state.failure = PREVIEW_FAILED;
                this.logger.error(
                    `Preview for session ${sessionId} given up: FFmpeg could not make its first segment`
                );
            }
            return null;
        }

        const made = await this.openSegment(segPath);
        if (made) state.madeSegment = true;
        if (!made) {
            this.logger.warn(
                `Segment r${renditionIndex}/s${segmentIndex} missing or empty after extraction`
            );
            return null;
        }
        this.prefetchSegments(
            sessionId,
            state,
            cacheDir,
            renditionIndex,
            localIndex + 1,
            PREFETCH_SEGMENTS,
            ai
        );
        return made;
    }

    /** Why this session's preview cannot be made, once that is known. */
    previewFailure(sessionId: string): string | undefined {
        return this.states.get(sessionId)?.failure;
    }

    /**
     * A segment opened for reading, or null when it is missing or empty.
     *
     * Opened here rather than by whoever reads it: the copy window can evict
     * the file at any moment, and an open file survives being unlinked where
     * a path does not. An empty file is left by an FFmpeg killed before it
     * wrote anything, and is cleared so the segment is made again.
     */
    private async openSegment(
        path: string
    ): Promise<{ stream: ReadStream; size: number } | null> {
        const handle = await open(path, 'r').catch(() => null);
        if (!handle) return null;
        const s = await handle.stat().catch(() => null);
        if (!s || s.size === 0) {
            await handle.close().catch(() => {});
            if (s) await rm(path, { force: true }).catch(() => {});
            return null;
        }
        return { stream: handle.createReadStream(), size: s.size };
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
        const totalSegments = this.segmentCount(state);

        for (
            let i = startIndex;
            i < startIndex + count && i < totalSegments;
            i++
        ) {
            const number = state.indexBase + i;
            const segPath = join(
                state.previewDir,
                cacheDir,
                `segment${number}.ts`
            );
            const cacheKey = `${sessionId}:${cacheDir}:${number}`;

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

    private segmentCount(state: PreviewState): number {
        return state.segmentBoundaries.length > 0
            ? state.segmentBoundaries.length
            : Math.ceil(state.duration / SEGMENT_DURATION);
    }

    async destroy(sessionId: string): Promise<void> {
        forgetPreviewSession(sessionId);
        // A build still running would store its state after this returns.
        if (this.building.has(sessionId)) this.cancelled.add(sessionId);
        const state = this.states.get(sessionId);
        if (!state) return;
        this.states.delete(sessionId);
        await rm(state.previewRoot, { recursive: true, force: true }).catch(
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
     * The video stream the preview shows: the one the storyboard samples.
     *
     * Not simply the first. On a multi-angle file the first stream can be a
     * postage-stamp proxy, and the filmstrip under the player is drawn from
     * {@link selectStoryboardTrack}'s pick — a preview of another stream would
     * show one camera over a timeline of a different one.
     */
    private selectVideoTrack(probe: ProbeResult): VideoTrackInfo | undefined {
        const tracks = probe.videoTracks;
        // The storyboard is drawn from the default angle's tracks. Of those,
        // only the ones on the first track's keyframe grid (the same keyframes,
        // the same length) can stand in for the video: a shorter one would end
        // the preview early.
        const angle = defaultAngleTracks(probe);
        const grid = angle[0]?.keyframeGrid;
        const picked = selectStoryboardTrack(
            grid === undefined
                ? angle
                : angle.filter((t) => t.keyframeGrid === grid)
        );
        return (
            (picked && tracks.find((t) => t.index === picked.index)) ??
            tracks[0]
        );
    }

    /**
     * One rendition of the chosen video stream: copied when the browser can
     * decode it as it is, transcoded to at most {@link MAX_PREVIEW_HEIGHT}
     * otherwise.
     *
     * One, not a ladder. The preview is played on the machine that makes it, so
     * there is no connection to adapt to — and every extra rung was another
     * segment encoded on the same GPU the encode itself needs. A file's other
     * video streams are not offered: the sources that need this preview at all
     * are ones the browser cannot play, and one camera is enough to cut by.
     */
    private buildRendition(v: VideoTrackInfo): Rendition {
        if (!canCopyToTs(v)) return this.transcodedRendition(v);
        return {
            videoIndex: v.index,
            width: v.width,
            height: v.height,
            bitrateKbps: v.bitrateKbps,
            canCopy: true,
        };
    }

    private transcodedRendition(v: VideoTrackInfo): Rendition {
        // Display dimensions: the preview has to show the picture's real shape,
        // and for an anamorphic source its coded size is not it.
        const display = displayDimensionsOf(v);
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
        const h = even(Math.min(MAX_PREVIEW_HEIGHT, display.height));
        const w = even((display.width * h) / display.height);
        return {
            videoIndex: v.index,
            width: w,
            height: h,
            bitrateKbps: Math.round(h * 2), // rough estimate
            canCopy: false,
            // Both dimensions stated, never `-2`: that derives the height
            // from the *input's storage* ratio, so `scale=854:-2` on a
            // 720x576 input gives 683, not 480.
            scaleFilter: `${w}:${h}`,
        };
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

    /** An older build's segment caches, beside this one's, are removed. */
    private async removeOlderCaches(previewRoot: string): Promise<void> {
        try {
            for (const name of await readdir(previewRoot)) {
                if (name === CACHE_VERSION) continue;
                await rm(join(previewRoot, name), {
                    recursive: true,
                    force: true,
                });
            }
        } catch {
            // Nothing to clear, or nothing that can be: a stale folder nobody
            // reads costs disk, not correctness.
        }
    }

    /**
     * Where a copied rendition's segments begin and end, or null when that
     * cannot be established and the stream should not be copied at all.
     *
     * A track that keeps a fixed keyframe interval has its boundaries worked
     * out from the probe, at once. Any other is scanned, which reads the whole
     * file — the wait a preview used to open with for every copied source.
     */
    private async layoutCopy(
        sessionId: string,
        filePath: string,
        track: VideoTrackInfo,
        duration: number
    ): Promise<CopyLayout | null> {
        const interval = regularKeyframeInterval(track);
        if (interval !== null) {
            const containerStart = await this.probeContainerStart(filePath);
            const first =
                (await this.probeFirstVideoPts(filePath, track.index)) ??
                track.startTime ??
                containerStart;
            const boundaries = cadenceBoundaries(
                first,
                track.gopFrames as number,
                track.frameRate,
                // Where the file ends on its own clock; its duration is a
                // length.
                containerStart + duration
            );
            if (boundaries.length > 0) {
                return {
                    boundaries,
                    containerStart,
                    keyframeStep: interval,
                    computed: true,
                    // A computed boundary can sit a hair before its keyframe:
                    // containers round timestamps, and a frame rate is rarely
                    // the fraction it is written as. Half a frame is past any
                    // such rounding and short of the frame after.
                    seekAimEpsilon: 0.5 / track.frameRate,
                };
            }
        }

        const scan = await this.scanKeyframes(
            sessionId,
            filePath,
            track.index
        );
        if (scan.keyframes.length === 0) return null;
        const containerStart = await this.probeContainerStart(filePath);
        return {
            boundaries: this.groupKeyframes(
                scan.keyframes,
                containerStart + duration
            ),
            containerStart,
            keyframeStep: scan.keyframeStep,
            computed: false,
            seekAimEpsilon: SEEK_AIM_EPSILON_SECONDS,
        };
    }

    /**
     * A copied segment of a computed layout did not start on its boundary: the
     * source does not keep the interval its head promised. Read the keyframes
     * off the file after all, and lay the playlists out again from them.
     *
     * The player still holds the playlist this replaces. Its next request names
     * a segment number that no longer exists and is refused, which the player
     * reports as a failure; the app answers that by loading the preview again,
     * and that load waits here for the new playlists.
     */
    private rebuildFromScan(state: PreviewState, why: string): Promise<void> {
        state.rebuild ??= (async () => {
            const { sessionId } = state;
            this.logger.warn(
                `Preview of ${sessionId}: ${why} — reading its keyframes and laying the playlist out again`
            );
            const track = state.videoTrack;
            const layout = track
                ? await this.layoutCopy(sessionId, state.filePath, {
                      // The interval was just disproved; do not compute again.
                      ...track,
                      gopRegular: false,
                  }, state.duration)
                : null;
            // Deleted meanwhile: there is nothing left to rebuild.
            if (this.states.get(sessionId) !== state) return;

            if (!layout && track) {
                this.logger.warn(
                    `Preview of ${sessionId}: its keyframes could not be read, so it is transcoded instead of copied`
                );
                state.renditions = [this.transcodedRendition(track)];
                notePreviewNeedsSession(sessionId);
            }
            state.segmentBoundaries = layout?.boundaries ?? [];
            state.containerStart = layout?.containerStart ?? 0;
            state.keyframeStep = layout?.keyframeStep;
            state.seekAimEpsilon = SEEK_AIM_EPSILON_SECONDS;
            state.boundariesComputed = false;
            state.seekHops.clear();
            state.indexBase += REBUILD_INDEX_STEP;
            state.mediaPlaylists = state.renditions.map((_, i) =>
                this.generateMediaPlaylist(
                    state.segmentBoundaries,
                    state.duration,
                    i,
                    state.indexBase
                )
            );
            state.masterPlaylist = this.generateMasterPlaylist(
                state.renditions
            );
        })().finally(() => {
            state.rebuild = undefined;
        });
        return state.rebuild;
    }

    /**
     * Keep a copied rendition's cache to its window: the newest
     * {@link COPY_WINDOW_SEGMENTS} segments, within {@link COPY_WINDOW_BYTES}.
     *
     * Run after each segment is written. Newest by when it was made, which is
     * the order playback makes them in; a seek back to an evicted stretch makes
     * those segments again. A file still being read is unlinked safely where
     * the system allows it, and where it does not (Windows) the failure is
     * ignored and the next write tries again.
     */
    private async trimCopyCache(dir: string): Promise<void> {
        try {
            const names = (await readdir(dir)).filter((name) =>
                /^segment\d+\.ts$/.test(name)
            );
            if (names.length <= COPY_WINDOW_MIN_SEGMENTS) return;

            const files: { path: string; size: number; mtimeMs: number }[] =
                [];
            for (const name of names) {
                const path = join(dir, name);
                const s = await stat(path).catch(() => null);
                if (s) files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
            }
            files.sort((a, b) => b.mtimeMs - a.mtimeMs);

            let bytes = 0;
            for (const [i, file] of files.entries()) {
                bytes += file.size;
                const keep =
                    i < COPY_WINDOW_MIN_SEGMENTS ||
                    (i < COPY_WINDOW_SEGMENTS && bytes <= COPY_WINDOW_BYTES);
                if (!keep) await rm(file.path, { force: true }).catch(() => {});
            }
        } catch {
            // The cache is a convenience: a folder that cannot be listed is
            // left as it is.
        }
    }

    /** Every keyframe of the stream, read off the file; none when that failed. */
    private async scanKeyframes(
        sessionId: string,
        filePath: string,
        videoStreamIndex: number
    ): Promise<{ keyframes: number[]; keyframeStep?: number }> {
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
            return { keyframes, keyframeStep };
        } catch (e) {
            this.logger.warn(`Keyframe scan failed: ${e}`);
            return { keyframes: [] };
        }
    }

    /**
     * Keyframes grouped into preview segments, the way a segment muxer asked
     * for {@link SEGMENT_DURATION} would have cut them: a segment ends at the
     * first keyframe at or past the next whole multiple of the target, so a
     * keyframe that arrives late does not push every later boundary with it.
     *
     * The last segment runs to the end of the source — a keyframe grid says
     * where keyframes are, not where the file ends.
     */
    private groupKeyframes(
        keyframes: number[],
        end: number
    ): SegmentBoundary[] {
        if (keyframes.length === 0) return [];
        const boundaries: SegmentBoundary[] = [];
        let start = keyframes[0];
        for (const keyframe of keyframes.slice(1)) {
            if (keyframe < SEGMENT_DURATION * (boundaries.length + 1)) continue;
            boundaries.push({ start, duration: keyframe - start });
            start = keyframe;
        }
        boundaries.push({ start, duration: Math.max(0, end - start) });
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
        renditionIndex: number,
        /** The number its first segment carries; see {@link REBUILD_INDEX_STEP}. */
        indexBase = 0
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
            lines.push(`segment${indexBase + i}.ts`);
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
        audioTrack: PreviewAudioTrack | undefined,
        /** The file the segment is written to. */
        output: string,
        /** {@link CopyLayout.containerStart}: taken off every seek on the copy path. */
        containerStart = 0,
        /** Decode in software; see {@link PreviewState.softwareDecode}. */
        softwareDecode = false
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
            '-y',
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
        args.push(
            ...decodeArgs(accelMode, 'preview', useGpu && !softwareDecode)
        );

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
            //
            // Both seeks are counted from the start of the file, which is how
            // ffmpeg reads `-ss`; the boundary itself, and `-to`, stay on the
            // source's clock.
            const fromFileStart = (t: number) =>
                String(Math.max(0, t - containerStart));
            args.push(
                '-ss',
                fromFileStart(copySeekStart),
                '-i',
                filePath,
                ...(audioMap
                    ? ['-ss', fromFileStart(start), '-i', filePath]
                    : [])
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
            ...previewVideoArgs(
                accelMode,
                useGpu,
                rendition.scaleFilter,
                softwareDecode
            )
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
        const useGpu =
            transcodes && accelMode !== 'cpu' && accelMode !== 'none';
        const partPath = `${outputPath}.part`;

        this.logger.debug(
            `Segment r${renditionIndex}/s${segmentIndex} (${useGpu ? accelMode : rendition.canCopy ? 'copy' : 'cpu'})`
        );

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
                partPath,
                state.containerStart,
                state.softwareDecode
            );
            const timeout = rendition.canCopy ? 30_000 : 120_000;

            // Straight to a file, not through a buffer: a copied segment is the
            // source's own bitrate, and a 4K one outgrows any buffer worth
            // holding. Written aside and renamed into place, so a process killed
            // half-way leaves nothing a later request would serve as a segment.
            //
            // No CPU retry: this FFmpeg has no software H.264 encoder to retry
            // with, so one would fail on a missing encoder and report that
            // instead of the hardware error that actually stopped the preview.
            await execFileAsync(ffmpegBin(), args, {
                timeout,
                maxBuffer: 4 * 1024 * 1024,
            }).catch(async (err: any) => {
                await rm(partPath, { force: true }).catch(() => {});
                const via = useGpu
                    ? state.softwareDecode
                        ? `${accelMode} (software decode)`
                        : accelMode
                    : rendition.canCopy
                      ? 'stream copy'
                      : 'cpu';
                // The substitution hint belongs to encoder failures: a copied
                // segment never opened an encoder, so a different FFmpeg is not
                // the remedy for whatever stopped it.
                const hint = rendition.canCopy
                    ? ''
                    : `\n\n${USE_YOUR_OWN_FFMPEG}`;
                throw Object.assign(
                    new Error(
                        `Preview segment r${renditionIndex}/s${segmentIndex} failed on ` +
                            `${via}: ${err.message}${hint}`
                    ),
                    // It ran to an exit code: not killed by a timeout or a cancel.
                    {
                        ffmpegFailed:
                            !err.killed && typeof err.code === 'number',
                    }
                );
            });

            await rename(partPath, outputPath);
        };

        // A copied segment of a computed layout has to be seen to start on its
        // boundary: the layout is a prediction from the head of the file. The
        // last segment may hold no picture at all, where the sound outlasts it.
        const lastSegment = segmentIndex === this.segmentCount(state) - 1;
        const onBoundary = (landed: number | null): boolean =>
            landed === null
                ? lastSegment
                : Math.abs(landed - start) <= LANDING_TOLERANCE_SECONDS;
        const verifyLanding = async (): Promise<void> => {
            if (!state.boundariesComputed) return;
            const landed = await this.probeFirstVideoPts(outputPath);
            if (onBoundary(landed)) return;
            throw new OffCadence(
                landed === null
                    ? `segment ${segmentIndex} has no picture`
                    : `segment ${segmentIndex} starts at ${landed.toFixed(3)}s, not ${start.toFixed(3)}s`
            );
        };
        const aim = (hop: number) => start + hop + state.seekAimEpsilon;

        // Wait for a concurrency slot
        await this.acquireSlot();

        // Two separate limits. The slot above bounds ffmpeg *processes*, which
        // is about this service's own load. This one bounds hardware encode
        // *sessions*, whose cap belongs to the graphics driver and is shared
        // with the ladder — which leaves one free while a transcoded preview
        // is in use (`ladderSessionCap`), so the wait here is for this
        // preview's own segments and not for a wave of the encode.
        //
        // Only a transcoding segment opens an encoder. A copy hands bytes to
        // the muxer, and an audio-only segment encodes no picture.
        let releaseEncoderSession: () => void = () => {};

        try {
            if (transcodes) {
                notePreviewNeedsSession(state.sessionId);
                releaseEncoderSession = await acquireEncoderSession();
            }

            if (!rendition.canCopy || !state.keyframeStep) {
                try {
                    await runOnce(start);
                } catch (e: any) {
                    // VideoToolbox does not decode every codec. FFmpeg then
                    // hands over software frames, which `scale_vt` refuses,
                    // while the VideoToolbox encoder takes them: so the source
                    // decodes in software from here on, and only the decode
                    // moves off the GPU.
                    if (
                        !useGpu ||
                        accelMode !== 'apple' ||
                        state.softwareDecode ||
                        !e?.ffmpegFailed
                    )
                        throw e;
                    this.logger.warn(
                        `Preview for session ${state.sessionId}: VideoToolbox could not decode the source, decoding in software`
                    );
                    state.softwareDecode = true;
                    await runOnce(start);
                }
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
                await runOnce(aim(known));
                await verifyLanding();
                void this.trimCopyCache(join(outputPath, '..'));
                return outputPath;
            }

            const learning = state.seekHopLearners.get(renditionIndex);
            if (learning) {
                // Another segment of this rendition is measuring the hop.
                // Waiting costs a slot but saves a probe and a re-extraction,
                // and avoids two learners writing different answers.
                const learned = await learning;
                await runOnce(aim(learned));
                await verifyLanding();
                void this.trimCopyCache(join(outputPath, '..'));
                return outputPath;
            }

            const learn = (async (): Promise<number> => {
                let hop = state.keyframeStep as number;
                await runOnce(aim(hop));

                // No video packet is a miss too: when a segment is one GOP
                // long, landing a GOP late leaves nothing before `-to`, and a
                // hop cached from that ships every segment without a picture.
                const landed = await this.probeFirstVideoPts(outputPath);
                if (
                    landed === null ||
                    Math.abs(landed - start) > LANDING_TOLERANCE_SECONDS
                ) {
                    // Nothing to correct towards: the picture ended before
                    // this segment, and its sound is all there is to it.
                    if (landed === null && state.boundariesComputed && lastSegment) {
                        throw new UnlearnedHop();
                    }
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
                    await runOnce(aim(corrected));
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
                // On a computed layout it may be worse than that: no seek at
                // all puts this segment on its boundary.
                await verifyLanding();
            } finally {
                state.seekHopLearners.delete(renditionIndex);
            }
            void this.trimCopyCache(join(outputPath, '..'));
        } catch (e: any) {
            if (e instanceof OffCadence) {
                // What was written is cut in the wrong place and must not be
                // served. The request fails; the rebuild is what follows it.
                await rm(outputPath, { force: true }).catch(() => {});
                void this.rebuildFromScan(state, e.message);
            }
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

    /** {@link CopyLayout.containerStart}, or zero when the file does not say. */
    private async probeContainerStart(path: string): Promise<number> {
        try {
            const { stdout } = await execFileAsync(ffprobeBin(), [
                '-v',
                'error',
                '-show_entries',
                'format=start_time',
                '-of',
                'csv=p=0',
                path,
            ]);
            const value = parseFloat(String(stdout).trim());
            return Number.isFinite(value) ? value : 0;
        } catch {
            return 0;
        }
    }

    /**
     * First packet presentation time of a video stream, or null: of a
     * segment's only one, or of stream `videoIndex` of the source.
     */
    private async probeFirstVideoPts(
        path: string,
        videoIndex = 0
    ): Promise<number | null> {
        try {
            const { stdout } = await execFileAsync(ffprobeBin(), [
                '-v',
                'error',
                '-select_streams',
                `v:${videoIndex}`,
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
