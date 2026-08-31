/**
 * Quick trim (smart cut) job runner — the executable half of
 * {@link ./quick-trim-plan.js}.
 *
 * A quick-trimmed stream is produced by ffmpeg jobs writing into that stream's
 * `stream_<name>/` directory, so `SegmentPipelineService` picks the segments up
 * exactly as it does for a normal encode. Chain membership, directory names and
 * segment naming are the ordinary conventions; only the numbering differs
 * (`-start_number` per part, `%07d`, stride {@link PART_NUMBER_STRIDE}) so
 * parts cannot collide in one directory.
 *
 * **A job is not a part.** What a quick trim costs is the *number of ffmpeg
 * runs*, not the content they touch: on the reference source (22 streams, two
 * kept ranges) 132 sequential jobs took 32.9 s, of which 3165 s of copied
 * content accounted for 11.9 s and 28 bridges of ~0.3 s each for 20.6 s. So
 * every copy part of one kept range is produced by **one** job spanning the
 * whole copy span ({@link buildQuickTrimJobs}), and the jobs run through a pool
 * of {@link QUICK_TRIM_JOB_CONCURRENCY}.
 *
 * When every job of a stream is done the `part_<n>.m3u8` intermediates are read
 * back for the filenames the muxer actually wrote, spliced into one
 * `playlist.m3u8` with `#EXT-X-DISCONTINUITY` between parts, and deleted.
 *
 * The recipes below are measured, not derived — see the plan's "Empirical
 * findings". The three that matter:
 *
 * - **Video copy parts** seek on the input, which lands on a keyframe chosen by
 *   the file's default stream's DTS: on the reference file a request for
 *   20.56 s produced a first packet at 19.62 s, a whole GOP early. So every
 *   video copy part is measured after it runs and retried once with the seek
 *   bumped by the deficit. A second miss is a `QuickTrimRunError` — the caller
 *   falls back to the precise path rather than ship a mis-cut.
 * - **Audio copy parts** need no such loop: an output-side `-ss` cuts exactly on
 *   the AAC frame grid (measured 10.387 for 10.37, 20.563 for 20.56 — inside one
 *   frame), and `-output_ts_offset` puts back the source clock that output
 *   trimming zeroes.
 * - **Bridges** seek two seconds early and cut with the `trim` filter, which is
 *   frame-exact (plain input `-ss` is not: its accurate-seek threshold works in
 *   the input-normalised clock and lands short by the source's start time).
 *
 * Measurement is always taken from `init_<n>.mp4` concatenated with the part's
 * first segment. The HLS fMP4 muxer writes each fragment's `tfdt` zero-based and
 * records the part's absolute start in the init's edit list, so a bare `.m4s`
 * reads as starting at 0 no matter where it was cut.
 *
 * That last sentence is also why {@link retimeJobToOutputTimeline} exists.
 * Zero-based fragment timelines are fine for one run and wrong for a spliced
 * output: the players this pipeline targets place samples by `tfdt` and ignore
 * the edit list, so every part of every stream would claim to start at 0 and a
 * boundary that fell one keyframe later on video than on audio would land
 * straight on the audio's placement (measured: audio fully out of sync, wrong
 * duration, unplayable tail). So once a stream's jobs are done and *after* the
 * copy measurements that depend on the original edit lists, every segment is
 * shifted onto the continuous output timeline and every init's edit list is
 * neutralised — see {@link ./fmp4-timeline.js}.
 */

import { execFile } from 'child_process';
import { bridgeVideoArgs } from './encoder-selection';
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';
import {
    buildSplicedMediaPlaylist,
    type SplicedPart,
    parseMediaPlaylist,
} from '@luminary-media-converter/hls-core';
import type {
    AudioGroupDto,
    EncodeConfigDto,
    TrimSegmentDto,
    VideoRenditionDto,
} from '../dto/encode-config.dto.js';
import { ffprobeBin } from './ffbin.js';
import {
    neutralizeEditList,
    readTrackTimescale,
    shiftBaseMediaDecodeTime,
} from './fmp4-timeline.js';
import {
    PART_NUMBER_STRIDE,
    type QuickTrimPart,
    type QuickTrimPlan,
    type QuickTrimStreamPlan,
} from './quick-trim-plan.js';
import type {
    AccelMode,
    EncodeOptions,
    EncodeResult,
} from './ffmpeg.service.js';

const execFileAsync = promisify(execFile);

/**
 * How many ffmpeg jobs a quick trim runs at once.
 *
 * A quick trim is dominated by per-process overhead — every job spends its
 * first moments opening and indexing a multi-stream source before it copies a
 * byte — so the run is neither CPU- nor disk-bound at one job at a time. Four
 * is the point past which the bridges (the only jobs that actually encode)
 * start competing for the same cores.
 */
const QUICK_TRIM_JOB_CONCURRENCY = 4;

/** How far before a bridge's cut the decode starts, seconds. */
const BRIDGE_PREROLL_SECONDS = 2;
/**
 * A bridge is a couple of GOPs of decode and under a second of encode; wall
 * time past this means the job read beyond its part (the regression this
 * guards is the trim filter discarding to end-of-file with nothing stopping
 * the input). Measured against a bridge sharing the machine with
 * {@link QUICK_TRIM_JOB_CONCURRENCY} - 1 others, so the threshold has to clear
 * that contention as well as the bridge itself.
 */
const BRIDGE_WALL_WARN_MS = 5000;

/**
 * How far before an audio copy part's cut the demuxer seeks. The cut itself is
 * made on the output side; this only has to land before it.
 */
const AUDIO_PREROLL_SECONDS = 2;

/**
 * `-hls_time` for a bridge: a bridge is one closed GOP shorter than any real
 * target duration, and this keeps the muxer from splitting it in two.
 */
const BRIDGE_SEGMENT_SECONDS = 3600;

/** `-g` for a bridge — one keyframe, at the start, and no others. */
const BRIDGE_GOP_FRAMES = 9999;

/** Frame rate assumed when the source will not say, for the seek tolerance. */
const FALLBACK_FRAME_RATE = 30;

/** Keeps a seek target strictly past a boundary the landing rule compares ≤. */
const EPSILON_SECONDS = 0.001;

/**
 * Emit an `#EXT-X-MAP` for every part rather than only for parts the planner
 * marked `ownInit`.
 *
 * A part's absolute start lives in its init's edit list, so a copy-split part
 * that inherits its neighbour's init inherits that neighbour's start offset —
 * which a player honouring edit lists (Safari native) reads as the wrong
 * timeline position. Whether that matters in practice is settled by the browser
 * A/B in the player harness; this constant is the single switch that flips the
 * output to per-part inits everywhere, and the unreferenced-init cleanup below
 * is gated on the same value.
 */
const MAP_EVERY_PART = false;

/**
 * Smallest `#EXTINF` the assembler will author. Reached only when a part's
 * muxer segments already sum past the planned span, which means the final
 * segment is pure spill.
 */
const MIN_AUTHORED_EXTINF = 0.001;

/**
 * A quick trim that cannot be completed as planned. The caller's answer is the
 * precise (full re-encode) path — never a failed session.
 */
export class QuickTrimRunError extends Error {
    constructor(
        message: string,
        readonly streamDir: string,
        readonly partIndex: number
    ) {
        super(message);
        this.name = 'QuickTrimRunError';
    }
}

/**
 * The run was cancelled — the active ffmpeg process was killed. Distinct from
 * {@link QuickTrimRunError} because falling back to a full re-encode is the
 * last thing a user who just pressed cancel wants.
 */
export class QuickTrimCancelledError extends Error {
    constructor() {
        super('Quick trim cancelled');
        this.name = 'QuickTrimCancelledError';
    }
}

/** One output stream: the directory it writes and what it is made of. */
export interface QuickTrimStreamTarget {
    /** `stream_<name>`, matching the plan's `streamDir`. */
    streamDir: string;
    kind: 'video' | 'audio';
    /** Track index within its own type, i.e. the `N` of `0:v:N` / `0:a:N`. */
    sourceTrackIndex: number;
    /** Set for `kind: 'video'` — what a bridge rate-matches against. */
    rendition?: VideoRenditionDto;
    /** Set for `kind: 'audio'`. */
    group?: AudioGroupDto;
}

export interface QuickTrimLogger {
    log(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
    error(message: string): void;
}

export interface QuickTrimRunnerDeps {
    accelMode: AccelMode;
    /** Every output stream, in the order the master should list them. */
    targets: readonly QuickTrimStreamTarget[];
    /**
     * Run one ffmpeg job to completion through the host's single process slot.
     * `onTime` receives `out_time` in seconds as the job reports it.
     */
    runJob(
        args: string[],
        onTime: (seconds: number) => void,
        label: string
    ): Promise<void>;
    /** True once the host killed the active process. Checked between jobs. */
    isCancelled(): boolean;
    /**
     * Kill every quick-trim child running now, *without* marking the run
     * cancelled — how the pool stops the jobs still running beside one that
     * failed. Their output is already being thrown away; the answer to a
     * failure is the precise path, not a cancelled session.
     */
    killRunningJobs?(): void;
    logger: QuickTrimLogger;
    /** See {@link MAP_EVERY_PART}; defaults to it. */
    mapEveryPart?: boolean;
    /** See {@link QUICK_TRIM_JOB_CONCURRENCY}; defaults to it. */
    concurrency?: number;
}

/**
 * One ffmpeg run and the planned parts it produces.
 *
 * A bridge is always one part. Every copy part of one kept range is normally
 * one run covering the whole copy span: a copy split inside a range exists only
 * so the discontinuity *count* matches across the output's playlists (locked
 * decision 3), never because the two sides need cutting apart — the content is
 * continuous across the junction.
 */
export interface QuickTrimJob {
    kind: 'bridge' | 'copy';
    /** Contiguous, in order. `parts[0]` names the init, playlist and numbering. */
    parts: QuickTrimPart[];
    /** `parts[0].start` and the last part's end — what the job is asked for. */
    start: number;
    end: number;
}

function makeJob(parts: QuickTrimPart[]): QuickTrimJob {
    return {
        kind: parts[0].kind,
        parts,
        start: parts[0].start,
        end: parts[parts.length - 1].end,
    };
}

/**
 * Group a stream's parts into the ffmpeg runs that produce them.
 *
 * Bridges stand alone. Copy parts collapse per kept range — `rangeIndex` is
 * what separates a copy split inside a range (same run) from one range's tail
 * meeting the next range's head (two runs, seeking to different places).
 *
 * A collapsed run has to give every part it covers at least one segment, and
 * the muxer only makes as many segments as the span affords. Where it cannot,
 * the parts are run one at a time — the shape this collapse replaced, reached
 * only by a kept range shorter than a few target durations.
 */
export function buildQuickTrimJobs(
    parts: readonly QuickTrimPart[],
    segmentDuration: number
): QuickTrimJob[] {
    const jobs: QuickTrimJob[] = [];
    let run: QuickTrimPart[] = [];

    const flush = (): void => {
        if (run.length === 0) return;
        const span = run[run.length - 1].end - run[0].start;
        const affordable = Math.ceil(span / segmentDuration) >= run.length;
        if (affordable) jobs.push(makeJob(run));
        else for (const part of run) jobs.push(makeJob([part]));
        run = [];
    };

    for (const part of parts) {
        if (part.kind === 'bridge') {
            flush();
            jobs.push(makeJob([part]));
            continue;
        }
        if (
            run.length > 0 &&
            run[run.length - 1].rangeIndex !== part.rangeIndex
        )
            flush();
        run.push(part);
    }
    flush();

    return jobs;
}

/** What a bridge has to match so its segment decodes beside the copied ones. */
interface SourceVideoParams {
    pixFmt?: string;
    profile?: string;
    frameRate: number;
}

function partPlaylistName(part: QuickTrimPart): string {
    return `part_${part.partIndex}.m3u8`;
}

function partInitName(part: QuickTrimPart): string {
    return `init_${part.partIndex}.mp4`;
}

/**
 * The HLS output half of a part's job — identical for copy parts and bridges
 * apart from the target duration.
 */
function hlsOutputArgs(
    streamDirPath: string,
    part: QuickTrimPart,
    segmentDuration: number
): string[] {
    return [
        '-f',
        'hls',
        '-hls_time',
        String(segmentDuration),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_type',
        'fmp4',
        // Mirrors the main encode's muxer flags. negative_cts_offsets is
        // load-bearing at file start: a B-frame stream's first IDR has
        // pts 0 / dts −(reorder delay), and without it the muxer shifts the
        // whole part by that delay — the copy-0 measurement then reads
        // 0.040s for a 0.000s target and the run falls back for nothing.
        '-movflags',
        '+negative_cts_offsets+default_base_moof',
        '-hls_fmp4_init_filename',
        partInitName(part),
        '-start_number',
        String(part.startNumber),
        '-hls_segment_filename',
        join(streamDirPath, 'segment_%07d.m4s'),
        '-y',
        join(streamDirPath, partPlaylistName(part)),
    ];
}

const PROGRESS_ARGS = ['-progress', 'pipe:2', '-stats_period', '1'];

export interface CopyPartArgsInput {
    inputPath: string;
    streamDirPath: string;
    kind: 'video' | 'audio';
    sourceTrackIndex: number;
    /** The job's first part: its start, its init, its playlist, its numbering. */
    part: QuickTrimPart;
    /**
     * Where the job stops — the last part it covers ends here. Defaults to
     * `part.end`, which is the same thing for a job of one part.
     */
    end?: number;
    /** Where the demuxer is asked to seek — the retry moves this, not the part. */
    seekStart: number;
    segmentDuration: number;
}

export function buildCopyPartArgs(input: CopyPartArgsInput): string[] {
    const { part, sourceTrackIndex, seekStart } = input;
    const end = input.end ?? part.end;

    if (input.kind === 'audio') {
        // Two seeks by design: the input one is coarse (it only has to land
        // before the cut) and the output one is exact, cutting on the AAC frame
        // grid. `-output_ts_offset` restores the source clock, which output
        // trimming would otherwise rebase to zero.
        return [
            '-ss',
            String(Math.max(0, part.start - AUDIO_PREROLL_SECONDS)),
            '-i',
            input.inputPath,
            ...PROGRESS_ARGS,
            '-map',
            `0:a:${sourceTrackIndex}`,
            '-c:a',
            'copy',
            '-copyts',
            '-ss',
            String(part.start),
            '-to',
            String(end),
            '-output_ts_offset',
            String(part.start),
            ...hlsOutputArgs(input.streamDirPath, part, input.segmentDuration),
        ];
    }

    // Video: an input seek, because a stream copy can only start on a keyframe
    // and only the demuxer can find one. Where it lands is measured afterwards.
    return [
        '-ss',
        String(seekStart),
        '-i',
        input.inputPath,
        ...PROGRESS_ARGS,
        '-map',
        `0:v:${sourceTrackIndex}`,
        '-c:v',
        'copy',
        '-copyts',
        '-to',
        String(end),
        ...hlsOutputArgs(input.streamDirPath, part, input.segmentDuration),
    ];
}

/**
 * H.264 profiles the encoders take, keyed by what ffprobe reports. Anything
 * else (High 10, 4:2:2, a codec that is not H.264) is left unpinned rather than
 * guessed at.
 */
const PROFILE_BY_PROBE: Record<string, string> = {
    baseline: 'baseline',
    'constrained baseline': 'baseline',
    main: 'main',
    high: 'high',
};

function bridgeEncoderArgs(
    rendition: VideoRenditionDto | undefined,
    params: SourceVideoParams | null,
    accelMode: AccelMode,
    useGpu: boolean
): string[] {
    const bitrate = rendition?.videoBitrateKbps ?? 2000;
    const rate = [
        '-b:v',
        `${bitrate}k`,
        '-maxrate',
        `${Math.round(bitrate * 1.07)}k`,
        '-bufsize',
        `${Math.round(bitrate * 1.5)}k`,
    ];
    const profile = params?.profile
        ? PROFILE_BY_PROBE[params.profile.toLowerCase()]
        : undefined;
    const profileArgs = profile ? ['-profile:v', profile] : [];
    // One keyframe, at the start: a bridge is a single closed GOP.
    const gop = ['-g', String(BRIDGE_GOP_FRAMES)];

    const { head, tail } = bridgeVideoArgs(accelMode, useGpu, {
        pixFmt: params?.pixFmt,
        gopFrames: BRIDGE_GOP_FRAMES,
    });
    return [...head, ...profileArgs, ...rate, ...gop, ...tail];
}

export interface BridgeArgsInput {
    inputPath: string;
    streamDirPath: string;
    sourceTrackIndex: number;
    part: QuickTrimPart;
    rendition?: VideoRenditionDto;
    params: SourceVideoParams | null;
    accelMode: AccelMode;
    useGpu: boolean;
}

export function buildBridgeArgs(input: BridgeArgsInput): string[] {
    const { part, accelMode, useGpu } = input;
    const args: string[] = [];

    // Decoding onto the GPU is asked for without `-hwaccel_output_format`, so
    // the frames arrive in system memory: `trim` below is metadata-only and
    // would pass hardware frames straight through, but every other filter and
    // format negotiation in the graph then has to agree with them. A bridge is
    // under a GOP, so the upload the encoder does instead costs nothing worth
    // the complication.
    if (useGpu && accelMode === 'nvidia') args.push('-hwaccel', 'cuda');
    else if (useGpu && accelMode === 'apple')
        args.push('-hwaccel', 'videotoolbox');
    else if (useGpu && accelMode === 'intel') args.push('-hwaccel', 'qsv');

    args.push(
        '-ss',
        String(Math.max(0, part.start - BRIDGE_PREROLL_SECONDS)),
        '-copyts',
        '-i',
        input.inputPath,
        ...PROGRESS_ARGS,
        '-map',
        `0:v:${input.sourceTrackIndex}`,
        // Frame-exact, unlike an input seek: the filter cuts in the same clock
        // `-copyts` keeps the packets in.
        '-vf',
        `trim=start=${part.start}:end=${part.end}`,
        // The filter only DISCARDS frames past the end — without a stop the
        // decode runs to end-of-file and a head bridge pays for the whole
        // remaining track. `-to` is absolute under -copyts and ends the run
        // at the bridge, exactly as the copy jobs stop.
        '-to',
        String(part.end),
        ...bridgeEncoderArgs(input.rendition, input.params, accelMode, useGpu),
        ...hlsOutputArgs(input.streamDirPath, part, BRIDGE_SEGMENT_SECONDS)
    );

    return args;
}

async function probeVideoParams(
    inputPath: string,
    trackIndex: number
): Promise<SourceVideoParams | null> {
    try {
        const { stdout } = await execFileAsync(ffprobeBin(), [
            '-v',
            'error',
            '-select_streams',
            `v:${trackIndex}`,
            '-show_entries',
            'stream=pix_fmt,profile,r_frame_rate',
            '-of',
            'json',
            inputPath,
        ]);
        const stream = JSON.parse(String(stdout)).streams?.[0];
        if (!stream) return null;
        const [num, den] = String(stream.r_frame_rate ?? '').split('/');
        const frameRate =
            Number(num) > 0 && Number(den) > 0
                ? Number(num) / Number(den)
                : FALLBACK_FRAME_RATE;
        return {
            pixFmt: stream.pix_fmt,
            profile: stream.profile,
            frameRate,
        };
    } catch {
        return null;
    }
}

/** Segment filenames a part wrote, in playlist order. */
async function partSegmentNames(
    streamDirPath: string,
    part: QuickTrimPart
): Promise<string[]> {
    const text = await readFile(
        join(streamDirPath, partPlaylistName(part)),
        'utf-8'
    );
    return parseMediaPlaylist(text).segments.map((s) => s.uri);
}

/**
 * Where a part's first packet actually landed, in source seconds.
 *
 * Probed from the init concatenated with the first segment: the muxer writes
 * fragment timestamps zero-based and puts the part's absolute start in the
 * init's edit list, which ffprobe applies — a bare segment reads as 0. Still
 * true when this runs: {@link retimeJobToOutputTimeline} removes that edit list
 * at assembly, which is after every measurement.
 */
async function measureFirstPts(
    streamDirPath: string,
    part: QuickTrimPart,
    kind: 'video' | 'audio'
): Promise<number | null> {
    let segmentName: string;
    try {
        segmentName = (await partSegmentNames(streamDirPath, part))[0];
    } catch {
        return null;
    }
    if (!segmentName) return null;

    const probePath = join(streamDirPath, `measure_${part.partIndex}.tmp.mp4`);
    try {
        const init = await readFile(join(streamDirPath, partInitName(part)));
        const segment = await readFile(join(streamDirPath, segmentName));
        await writeFile(probePath, Buffer.concat([init, segment]));

        const { stdout } = await execFileAsync(ffprobeBin(), [
            '-v',
            'error',
            '-select_streams',
            kind === 'video' ? 'v:0' : 'a:0',
            '-show_entries',
            'packet=pts_time',
            '-of',
            'csv=p=0',
            '-read_intervals',
            '%+#1',
            probePath,
        ]);
        const value = parseFloat(String(stdout).trim().split('\n')[0]);
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    } finally {
        await unlink(probePath).catch(() => {});
    }
}

/**
 * Everything a job wrote, so a retry starts from nothing. Takes the job's first
 * part, which is what named its files and where its numbering began; a
 * collapsed job's segments stay inside that part's stride, since no part of any
 * plannable range writes {@link PART_NUMBER_STRIDE} segments.
 */
async function deletePartOutput(
    streamDirPath: string,
    part: QuickTrimPart
): Promise<void> {
    const first = part.startNumber;
    const last = first + PART_NUMBER_STRIDE;
    let entries: string[] = [];
    try {
        entries = await readdir(streamDirPath);
    } catch {
        return;
    }
    for (const name of entries) {
        const match = name.match(/^segment_(\d+)\.m4s$/);
        if (match) {
            const number = parseInt(match[1], 10);
            if (number >= first && number < last) {
                await unlink(join(streamDirPath, name)).catch(() => {});
            }
            continue;
        }
        if (name === partInitName(part) || name === partPlaylistName(part)) {
            await unlink(join(streamDirPath, name)).catch(() => {});
        }
    }
}

/**
 * The kept ranges as an ffconcat list, written for the waveform's trimmed path
 * — which reads `concat.txt` to learn what the output covers and would
 * otherwise describe the whole source.
 *
 * No alignment offset is folded in the way `FfmpegService.buildConcatFile` does:
 * a quick trim seeks each stream to its own planned start, so there is no
 * shared head to skip.
 */
export async function writeQuickTrimConcatFile(
    inputPath: string,
    ranges: readonly TrimSegmentDto[],
    outputDir: string
): Promise<string> {
    const lines = ['ffconcat version 1.0'];
    // Absolute, and single quotes doubled the ffconcat way — the demuxer
    // resolves relative entries against the list file's own directory. Same
    // rule as FfmpegService.buildConcatFile.
    const absoluteInput = resolve(inputPath).replace(/'/g, "'\\''");
    for (const range of ranges) {
        lines.push(`file '${absoluteInput}'`);
        lines.push(`inpoint ${range.inSec}`);
        lines.push(`outpoint ${range.outSec}`);
    }
    const concatPath = join(outputDir, 'concat.txt');
    await writeFile(concatPath, lines.join('\n'), 'utf-8');
    return concatPath;
}

function sanitizeGroupId(value: string): string {
    return (
        value
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'angle'
    );
}

function audioDisplayName(
    group: AudioGroupDto,
    singleLanguage: boolean
): string {
    return singleLanguage
        ? (group.language ?? 'Audio')
        : (group.label ?? group.language ?? 'Audio');
}

/**
 * The master playlist, authored from the config rather than fixed up after the
 * muxer — a quick trim runs one muxer per part, so no muxer ever sees the whole
 * output and none of them writes a master at all.
 *
 * `CODECS` is deliberately absent. It can only be derived from the bitstream
 * (profile, level and the audio object type as they were actually written), and
 * a wrong value is worse than none: hls.js and Safari both probe the init
 * segment when the attribute is missing. Revisit if the player pass finds a
 * client that insists on it.
 */
export function buildQuickTrimMasterContent(
    encodeConfig: EncodeConfigDto,
    targets: readonly QuickTrimStreamTarget[]
): string {
    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7'];
    const audioTargets = targets.filter((t) => t.kind === 'audio');
    const videoTargets = targets.filter((t) => t.kind === 'video');

    // Same rule the muxer-written master is fixed up with: groups sharing one
    // language are quality tiers, not selectable tracks, so they share a NAME.
    const singleLanguage =
        new Set(audioTargets.map((t) => t.group?.language ?? '')).size <= 1;

    const defaulted = new Set<string>();
    for (const target of audioTargets) {
        const group = target.group!;
        const isDefault = !defaulted.has(group.id);
        if (isDefault) defaulted.add(group.id);
        const language = group.language
            ? `,LANGUAGE="${group.language.toLowerCase()}"`
            : '';
        lines.push(
            `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group.id}",` +
                `NAME="${audioDisplayName(group, singleLanguage)}",` +
                `DEFAULT=${isDefault ? 'YES' : 'NO'}${language},` +
                `URI="${target.streamDir}/playlist.m3u8"`
        );
    }

    if (videoTargets.length === 0) {
        // Audio-only output: one variant per group, pointing at its own stream.
        lines.push('');
        for (const target of audioTargets) {
            const group = target.group!;
            lines.push(
                `#EXT-X-STREAM-INF:BANDWIDTH=${group.audioBitrateKbps * 1000},` +
                    `AUDIO="${group.id}"`,
                `${target.streamDir}/playlist.m3u8`
            );
        }
        return lines.join('\n') + '\n';
    }

    // Angles become VIDEO rendition groups, exactly as the muxer-written master
    // is rewritten to carry them — one master, narrowed client-side.
    const angleTracks = new Set(videoTargets.map((t) => t.sourceTrackIndex));
    const multiAngle = angleTracks.size > 1;
    const angleNames = new Map<number, string>();
    for (const named of encodeConfig.videoTrackNames ?? []) {
        angleNames.set(named.index, named.name ?? `Angle ${named.index}`);
    }
    for (const index of angleTracks) {
        if (!angleNames.has(index)) angleNames.set(index, `Angle ${index}`);
    }

    if (multiAngle) {
        const emitted = new Set<string>();
        for (const [, name] of angleNames) {
            const groupId = sanitizeGroupId(name);
            if (emitted.has(groupId)) continue;
            emitted.add(groupId);
            lines.push(
                `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${groupId}",` +
                    `NAME="${name}",DEFAULT=${emitted.size === 1 ? 'YES' : 'NO'}`
            );
        }
    }

    const audioBitrateByGroup = new Map<string, number>();
    for (const target of audioTargets) {
        const group = target.group!;
        audioBitrateByGroup.set(
            group.id,
            Math.max(
                audioBitrateByGroup.get(group.id) ?? 0,
                group.audioBitrateKbps
            )
        );
    }

    lines.push('');
    for (const target of videoTargets) {
        const rendition = target.rendition!;
        const bandwidth =
            rendition.videoBitrateKbps * 1000 +
            (audioBitrateByGroup.get(rendition.audioGroupId) ?? 0) * 1000;
        const video = multiAngle
            ? `,VIDEO="${sanitizeGroupId(
                  angleNames.get(target.sourceTrackIndex) ?? 'angle'
              )}"`
            : '';
        const audio = audioTargets.length
            ? `,AUDIO="${rendition.audioGroupId}"`
            : '';
        lines.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},` +
                `RESOLUTION=${rendition.width}x${rendition.height}` +
                `${video}${audio}`,
            `${target.streamDir}/playlist.m3u8`
        );
    }

    return lines.join('\n') + '\n';
}

/**
 * Which segment of a collapsed copy job each planned junction falls on, as
 * slice boundaries into the job's segment list — `[0, …, segments.length]`,
 * one entry more than the job has parts.
 *
 * The junction between two copy parts of one kept range is arbitrary by
 * construction. The content is continuous across it; the split exists only so
 * that the *count* of discontinuities matches in every playlist of the output
 * (hls.js keys its timestamp alignment to the discontinuity counter, not to
 * where the counter advanced). So a junction snaps to the nearest boundary
 * between segments the muxer actually wrote, and the parts either side keep
 * their exact planned outer edges.
 *
 * Junctions may therefore sit up to half a target duration from where the plan
 * put them, and differ by that much between streams. That is harmless because
 * every timestamp in the output is the source's own (`-copyts`): a player reads
 * position from the timeline, never from where a discontinuity was placed.
 */
function snapJunctions(job: QuickTrimJob, durations: number[]): number[] {
    const cumulative = [0];
    for (const duration of durations) {
        cumulative.push(cumulative[cumulative.length - 1] + duration);
    }

    const boundaries = [0];
    let lowest = 1;
    for (let i = 1; i < job.parts.length; i++) {
        const target = job.parts[i].start - job.start;
        // Every part still to come needs a segment of its own, so the search
        // stops that many short of the end.
        const highest = durations.length - (job.parts.length - i);
        let best = lowest;
        for (let index = lowest; index <= highest; index++) {
            if (
                Math.abs(cumulative[index] - target) <
                Math.abs(cumulative[best] - target)
            ) {
                best = index;
            }
        }
        boundaries.push(best);
        lowest = best + 1;
    }
    boundaries.push(durations.length);

    return boundaries;
}

/**
 * Move one job's output onto the continuous output timeline.
 *
 * Every job is muxed on its own, so the HLS muxer gives each one a zero-based
 * fragment timeline and records where it really started in the init's edit list.
 * The players this output is for read `tfdt` and ignore `elst`, and they key
 * their timestamp alignment to the discontinuity counter with the audio track
 * borrowing the video track's anchor — so a zero-based part is read as starting
 * wherever its *neighbouring stream's* part started, and the difference (a
 * keyframe here, an AAC frame there — every stream splices on its own grid, by
 * design) becomes A/V desync outright.
 *
 * So each segment's `baseMediaDecodeTime` gains the job's position in the
 * finished playlist, which is the sum of the planned spans of every part before
 * it, and the init's edit list is neutralised so nothing adds the source-
 * relative shift on top. The job is the unit rather than the part because a
 * collapsed copy job's parts share one muxer run: their fragments are already
 * continuous with each other, and only the run as a whole has to be placed.
 *
 * Runs at assembly, which is after the copy measurements (which read the edit
 * list this removes) and before the segment pipeline is started by the caller.
 */
async function retimeJobToOutputTimeline(
    streamDirPath: string,
    initName: string,
    segmentUris: readonly string[],
    outputStart: number
): Promise<void> {
    const initPath = join(streamDirPath, initName);
    const init = await readFile(initPath);
    const timescale = readTrackTimescale(init);
    const offsetTicks = Math.round(outputStart * timescale);

    for (const uri of segmentUris) {
        const segmentPath = join(streamDirPath, uri);
        const segment = await readFile(segmentPath);
        shiftBaseMediaDecodeTime(segment, offsetTicks);
        await writeFile(segmentPath, segment);
    }

    // Last: a failed shift above leaves the edit list in place, which is the
    // state the measurement code and a re-run both expect.
    await writeFile(initPath, neutralizeEditList(init));
}

/**
 * Splice one stream's finished jobs into its `playlist.m3u8`.
 *
 * Segment filenames come from each job's own playlist — never from a directory
 * listing, whose order is the filesystem's business. Durations come from the
 * plan: only the last segment of a *job* is adjusted, because the muxer's
 * segments are as long as it made them and only the tail is free to absorb the
 * spill past `-to` (a stream copy stops on DTS, so it overshoots by a few
 * frames by construction). Clamping the job rather than each part is what keeps
 * a collapsed job's authored durations summing to exactly the span its parts
 * were planned to cover, wherever {@link snapJunctions} put the junctions
 * inside it.
 */
async function assembleStreamPlaylist(
    streamDirPath: string,
    streamPlan: QuickTrimStreamPlan,
    jobs: readonly QuickTrimJob[],
    mapEveryPart: boolean,
    logger: QuickTrimLogger
): Promise<void> {
    const parts: SplicedPart[] = [];
    /** Where the job about to be read starts in the finished playlist. */
    let outputStart = 0;

    for (const job of jobs) {
        const first = job.parts[0];
        let parsed;
        try {
            parsed = parseMediaPlaylist(
                await readFile(
                    join(streamDirPath, partPlaylistName(first)),
                    'utf-8'
                )
            );
        } catch (err) {
            throw new QuickTrimRunError(
                `Part ${first.partIndex} of ${streamPlan.streamDir} wrote no ` +
                    `playlist: ${(err as Error).message}`,
                streamPlan.streamDir,
                first.partIndex
            );
        }
        if (parsed.segments.length === 0) {
            throw new QuickTrimRunError(
                `Part ${first.partIndex} of ${streamPlan.streamDir} produced ` +
                    `no segments`,
                streamPlan.streamDir,
                first.partIndex
            );
        }
        if (parsed.segments.length < job.parts.length) {
            throw new QuickTrimRunError(
                `Part ${first.partIndex} of ${streamPlan.streamDir} produced ` +
                    `${parsed.segments.length} segment(s) for ` +
                    `${job.parts.length} planned part(s) — the discontinuity ` +
                    `structure cannot be authored from them`,
                streamPlan.streamDir,
                first.partIndex
            );
        }

        try {
            await retimeJobToOutputTimeline(
                streamDirPath,
                partInitName(first),
                parsed.segments.map((segment) => segment.uri),
                outputStart
            );
        } catch (err) {
            throw new QuickTrimRunError(
                `Part ${first.partIndex} of ${streamPlan.streamDir} could ` +
                    `not be moved onto the output timeline at ` +
                    `${outputStart.toFixed(3)}s: ${(err as Error).message}`,
                streamPlan.streamDir,
                first.partIndex
            );
        }
        outputStart += job.end - job.start;

        const span = job.end - job.start;
        const muxed = parsed.segments.map((segment) => segment.duration);
        const head = muxed.slice(0, -1).reduce((sum, d) => sum + d, 0);
        // Rounded to the microsecond the assembler formats at: a raw float
        // difference (0.6200000000000001) no longer matches its own
        // six-decimal text, and the lossless builder then emits the noisy
        // number instead of the text.
        let tail = Math.round((span - head) * 1e6) / 1e6;
        if (!(tail > 0)) {
            logger.warn(
                `Part ${first.partIndex} of ${streamPlan.streamDir} overran ` +
                    `its planned ${span.toFixed(3)}s by ` +
                    `${(head - span).toFixed(3)}s before its last segment`
            );
            tail = MIN_AUTHORED_EXTINF;
        }
        const authored = muxed.map((duration, index) =>
            index === muxed.length - 1 ? tail : duration
        );

        const boundaries = snapJunctions(job, muxed);
        for (const [index, part] of job.parts.entries()) {
            parts.push({
                // The job wrote one init, under its first part's name; a part
                // split off inside the job continues it and emits no map.
                mapUri:
                    mapEveryPart || part.ownInit
                        ? partInitName(first)
                        : undefined,
                segments: parsed.segments
                    .slice(boundaries[index], boundaries[index + 1])
                    .map((segment, offset) => ({
                        uri: segment.uri,
                        duration: authored[boundaries[index] + offset],
                    })),
            });
        }
    }

    await writeFile(
        join(streamDirPath, 'playlist.m3u8'),
        buildSplicedMediaPlaylist(parts),
        'utf-8'
    );

    for (const part of streamPlan.parts) {
        // Parts collapsed into a neighbour's job wrote neither of these; the
        // unlink is a no-op for them.
        await unlink(join(streamDirPath, partPlaylistName(part))).catch(
            () => {}
        );
        // An init nothing references would still be uploaded — the pipeline
        // ships every `init_*.mp4` in the directory at drain.
        if (!mapEveryPart && !part.ownInit) {
            await unlink(join(streamDirPath, partInitName(part))).catch(
                () => {}
            );
        }
    }
}

/** What a finished run says about itself; see the summary line at the end. */
interface QuickTrimTally {
    copyContent: number;
    copyWallMs: number;
    copyParts: number;
    bridgeContent: number;
    bridgeWallMs: number;
    bridgeParts: number;
}

/** One stream's share of a run: what it writes and what is left to do. */
interface StreamRun {
    streamPlan: QuickTrimStreamPlan;
    target: QuickTrimStreamTarget;
    streamDirPath: string;
    params: SourceVideoParams | null;
    /** Seek tolerance for this stream's copy measurements, seconds. */
    tolerance: number;
    jobs: QuickTrimJob[];
    /** Jobs still to finish; assembly runs when it reaches zero. */
    remaining: number;
}

/**
 * Run every job of a plan and author what they produced.
 *
 * Jobs of one stream are independent of each other except for assembly, which
 * needs all of them; jobs of different streams are independent outright. So the
 * whole plan goes through one pool of {@link QUICK_TRIM_JOB_CONCURRENCY}
 * workers, each stream's playlist is spliced as its last job lands, and the
 * master is written when the pool drains.
 */
export async function runQuickTrim(
    deps: QuickTrimRunnerDeps,
    opts: EncodeOptions,
    plan: QuickTrimPlan
): Promise<EncodeResult> {
    const { inputPath, outputDir, encodeConfig, onProgress } = opts;
    const segmentDuration = encodeConfig.segmentDuration ?? 6;
    const mapEveryPart = deps.mapEveryPart ?? MAP_EVERY_PART;
    const runStartedAt = Date.now();

    await mkdir(outputDir, { recursive: true });
    if (encodeConfig.trimSegments?.length) {
        await writeQuickTrimConcatFile(
            inputPath,
            encodeConfig.trimSegments,
            outputDir
        );
    }

    const totalWeight = plan.streams.reduce(
        (total, stream) =>
            total +
            stream.parts.reduce(
                (sum, part) => sum + Math.max(part.end - part.start, 0),
                0
            ),
        0
    );
    let doneWeight = 0;
    // The high-water mark, not the last value: several jobs report at once and
    // each knows only its own fraction, so a slower one following a faster one
    // would otherwise walk the bar backwards.
    let maxPercent = 0;
    const report = (fraction: number, weight: number): void => {
        if (totalWeight <= 0) return;
        const percent = Math.min(
            99.9,
            ((doneWeight + fraction * weight) / totalWeight) * 100
        );
        if (percent - maxPercent < 0.5) return;
        maxPercent = percent;
        onProgress(Math.round(percent * 10) / 10);
    };

    // The whole promise of a quick trim is that only the boundary GOPs are
    // re-encoded, so the run accounts for itself: content seconds and wall
    // time per kind, said out loud at the end. A bridge whose wall time is
    // out of all proportion to its span means the job read past its part —
    // the failure mode is silent (output identical, run merely slow), so it
    // is watched for here rather than discovered by a stopwatch. The counts
    // are of ffmpeg *runs*, which is what the wall times measure; one copy run
    // covers all the copy parts of one kept range.
    const tally: QuickTrimTally = {
        copyContent: 0,
        copyWallMs: 0,
        copyParts: 0,
        bridgeContent: 0,
        bridgeWallMs: 0,
        bridgeParts: 0,
    };

    const runs: StreamRun[] = [];
    for (const streamPlan of plan.streams) {
        const target = deps.targets.find(
            (t) => t.streamDir === streamPlan.streamDir
        );
        if (!target) {
            throw new QuickTrimRunError(
                `Plan names stream ${streamPlan.streamDir}, which this ` +
                    `config does not produce`,
                streamPlan.streamDir,
                0
            );
        }

        const streamDirPath = join(outputDir, streamPlan.streamDir);
        await mkdir(streamDirPath, { recursive: true });

        const params =
            target.kind === 'video'
                ? await probeVideoParams(inputPath, target.sourceTrackIndex)
                : null;
        const jobs = buildQuickTrimJobs(streamPlan.parts, segmentDuration);
        runs.push({
            streamPlan,
            target,
            streamDirPath,
            params,
            // Half a frame: a copy job starts on a keyframe, so anything closer
            // than that is the same frame reported through a rational timebase.
            tolerance: 0.5 / (params?.frameRate ?? FALLBACK_FRAME_RATE),
            jobs,
            remaining: jobs.length,
        });
    }

    const queue: { run: StreamRun; job: QuickTrimJob }[] = [];
    for (const run of runs) {
        for (const job of run.jobs) queue.push({ run, job });
    }

    let failure: Error | null = null;
    let next = 0;
    const fail = (err: unknown): void => {
        if (failure) return;
        // A cancelled run must not present as a run *error*: the caller answers
        // an error with the precise path, and a cancel with nothing at all.
        failure = deps.isCancelled()
            ? new QuickTrimCancelledError()
            : (err as Error);
        // The jobs still running are producing output that is already being
        // thrown away, and a bridge is a real encode.
        deps.killRunningJobs?.();
    };

    const worker = async (): Promise<void> => {
        while (failure === null) {
            if (deps.isCancelled()) {
                fail(new QuickTrimCancelledError());
                return;
            }
            const index = next++;
            if (index >= queue.length) return;
            const { run, job } = queue[index];

            try {
                await runOneJob(deps, run, job, {
                    inputPath,
                    segmentDuration,
                    report,
                    tally,
                });
                doneWeight += Math.max(job.end - job.start, 0);
                run.remaining -= 1;
                if (run.remaining === 0) {
                    await assembleStreamPlaylist(
                        run.streamDirPath,
                        run.streamPlan,
                        run.jobs,
                        mapEveryPart,
                        deps.logger
                    );
                }
            } catch (err) {
                fail(err);
                return;
            }
        }
    };

    await Promise.all(
        Array.from(
            { length: deps.concurrency ?? QUICK_TRIM_JOB_CONCURRENCY },
            () => worker()
        )
    );
    if (failure) throw failure;

    await writeFile(
        join(outputDir, 'master.m3u8'),
        buildQuickTrimMasterContent(encodeConfig, deps.targets),
        'utf-8'
    );

    const reEncodedShare =
        tally.copyContent + tally.bridgeContent > 0
            ? (tally.bridgeContent /
                  (tally.copyContent + tally.bridgeContent)) *
              100
            : 0;
    deps.logger.log(
        `[quick-trim] copied ${tally.copyContent.toFixed(1)}s across ` +
            `${tally.copyParts} part(s) in ${(tally.copyWallMs / 1000).toFixed(1)}s; ` +
            `re-encoded ${tally.bridgeContent.toFixed(1)}s across ` +
            `${tally.bridgeParts} bridge(s) in ${(tally.bridgeWallMs / 1000).toFixed(1)}s ` +
            `(${reEncodedShare.toFixed(1)}% of output content re-encoded; ` +
            // The per-kind figures above are summed job wall times, which now
            // overlap; this is the run as a stopwatch sees it.
            `${((Date.now() - runStartedAt) / 1000).toFixed(1)}s wall)`
    );

    onProgress(100);

    return {
        outputDir,
        masterPlaylist: 'master.m3u8',
        segmentFormat: 'fmp4',
        // Nothing was seeked past on every stream's behalf: each part seeks to
        // its own planned start, so the output's t=0 is the first kept range's
        // in-point and no head has to be removed from anything derived.
        alignmentOffset: 0,
    };
}

/**
 * One job: run it, time it, and fold what it cost into the tally.
 *
 * Progress is reported against the job's own span, which for a collapsed copy
 * job is every part it covers — the pool has no finer unit to report from, and
 * the parts inside a job are not produced in sequence anyway.
 */
async function runOneJob(
    deps: QuickTrimRunnerDeps,
    run: StreamRun,
    job: QuickTrimJob,
    ctx: {
        inputPath: string;
        segmentDuration: number;
        report: (fraction: number, weight: number) => void;
        tally: QuickTrimTally;
    }
): Promise<void> {
    const weight = Math.max(job.end - job.start, 0);
    const span = job.end - job.start;
    const onTime = (seconds: number): void => {
        if (span <= 0) return;
        // `out_time` is the source clock under `-copyts` and the job's own
        // clock when the muxer rebased it; accept either.
        const absolute = (seconds - job.start) / span;
        const fraction =
            absolute >= 0 && absolute <= 1.5 ? absolute : seconds / span;
        ctx.report(Math.min(1, Math.max(0, fraction)), weight);
    };

    const jobStartedAt = Date.now();
    if (job.kind === 'bridge') {
        await runBridgePart(
            deps,
            {
                inputPath: ctx.inputPath,
                streamDirPath: run.streamDirPath,
                target: run.target,
                part: job.parts[0],
                params: run.params,
            },
            onTime
        );
        const wallMs = Date.now() - jobStartedAt;
        ctx.tally.bridgeContent += weight;
        ctx.tally.bridgeWallMs += wallMs;
        ctx.tally.bridgeParts += 1;
        if (wallMs > BRIDGE_WALL_WARN_MS) {
            deps.logger.warn(
                `[quick-trim] bridge ${job.parts[0].partIndex} of ` +
                    `${run.streamPlan.streamDir} took ` +
                    `${(wallMs / 1000).toFixed(1)}s for ` +
                    `${weight.toFixed(2)}s of content — the job is reading ` +
                    `past its part`
            );
        }
        return;
    }

    await runCopyPart(
        deps,
        {
            inputPath: ctx.inputPath,
            streamDirPath: run.streamDirPath,
            streamDir: run.streamPlan.streamDir,
            target: run.target,
            job,
            segmentDuration: ctx.segmentDuration,
            tolerance: run.tolerance,
            keyframeStep: run.streamPlan.keyframeStep,
        },
        onTime
    );
    ctx.tally.copyContent += weight;
    ctx.tally.copyWallMs += Date.now() - jobStartedAt;
    ctx.tally.copyParts += 1;
}

async function runBridgePart(
    deps: QuickTrimRunnerDeps,
    ctx: {
        inputPath: string;
        streamDirPath: string;
        target: QuickTrimStreamTarget;
        part: QuickTrimPart;
        params: SourceVideoParams | null;
    },
    onTime: (seconds: number) => void
): Promise<void> {
    const { part, target } = ctx;
    const useGpu = deps.accelMode !== 'cpu' && deps.accelMode !== 'none';
    const label = `${target.streamDir} bridge ${part.partIndex}`;

    const args = buildBridgeArgs({
        inputPath: ctx.inputPath,
        streamDirPath: ctx.streamDirPath,
        sourceTrackIndex: target.sourceTrackIndex,
        part,
        rendition: target.rendition,
        params: ctx.params,
        accelMode: deps.accelMode,
        useGpu,
    });

    try {
        await deps.runJob(args, onTime, label);
    } catch (err) {
        if (!useGpu) throw err;
        // Same fallback the preview takes: a hardware encoder can refuse for
        // reasons that have nothing to do with this input (session limits), and
        // a bridge is short enough that the CPU path costs nothing to try.
        deps.logger.warn(
            `${label} failed on ${deps.accelMode}, retrying on CPU: ` +
                `${(err as Error).message}`
        );
        await deletePartOutput(ctx.streamDirPath, part);
        await deps.runJob(
            buildBridgeArgs({
                inputPath: ctx.inputPath,
                streamDirPath: ctx.streamDirPath,
                sourceTrackIndex: target.sourceTrackIndex,
                part,
                rendition: target.rendition,
                params: ctx.params,
                accelMode: 'cpu',
                useGpu: false,
            }),
            onTime,
            label
        );
    }
}

async function runCopyPart(
    deps: QuickTrimRunnerDeps,
    ctx: {
        inputPath: string;
        streamDirPath: string;
        streamDir: string;
        target: QuickTrimStreamTarget;
        job: QuickTrimJob;
        segmentDuration: number;
        tolerance: number;
        keyframeStep?: number;
    },
    onTime: (seconds: number) => void
): Promise<void> {
    const { job, target } = ctx;
    const first = job.parts[0];
    const label = `${ctx.streamDir} copy ${first.partIndex}`;

    const run = async (seekStart: number): Promise<void> => {
        await deps.runJob(
            buildCopyPartArgs({
                inputPath: ctx.inputPath,
                streamDirPath: ctx.streamDirPath,
                kind: target.kind,
                sourceTrackIndex: target.sourceTrackIndex,
                part: first,
                end: job.end,
                seekStart,
                segmentDuration: ctx.segmentDuration,
            }),
            onTime,
            label
        );
    };

    // The demuxer's landing rule, measured on both reference files (identical
    // 1 s grids and mutually offset ones alike): an input seek lands on the
    // largest keyframe at or before *target minus the stream's hop*, where
    // the hop is one keyframe interval when the mapped stream is not the
    // file's default (the cross-track positioning gives back a whole GOP)
    // and zero when it is. Which stream is the default is not knowable
    // cheaply, so the first attempt assumes the common case — aim one
    // interval past the intended start — and the retry derives the hop the
    // stream actually exhibited from where that attempt landed.
    const aimTarget =
        job.start +
        (target.kind === 'video' && ctx.keyframeStep
            ? ctx.keyframeStep + EPSILON_SECONDS
            : 0);
    await run(aimTarget);

    // Audio cuts on the output side, on the frame grid, and needs no check.
    if (target.kind === 'audio') return;

    const landed = await measureFirstPts(ctx.streamDirPath, first, 'video');
    if (landed === null) {
        throw new QuickTrimRunError(
            `Could not measure where ${label} started`,
            ctx.streamDir,
            first.partIndex
        );
    }
    if (Math.abs(landed - job.start) <= ctx.tolerance) return;

    // target − landed IS the stream's hop under the landing rule, whichever
    // regime it is in — re-aiming with it is exact in one step for both.
    const bumped = Math.max(0, job.start + (aimTarget - landed));
    deps.logger.warn(
        `${label} landed at ${landed.toFixed(3)}s for ${job.start.toFixed(3)}s` +
            ` — retrying from ${bumped.toFixed(3)}s`
    );
    await deletePartOutput(ctx.streamDirPath, first);
    await run(bumped);

    const second = await measureFirstPts(ctx.streamDirPath, first, 'video');
    if (second !== null && Math.abs(second - job.start) <= ctx.tolerance) {
        return;
    }
    throw new QuickTrimRunError(
        `${label} could not be seeked to ${job.start.toFixed(3)}s ` +
            `(landed at ${landed.toFixed(3)}s, then ` +
            `${second === null ? 'unmeasurable' : `${second.toFixed(3)}s`})`,
        ctx.streamDir,
        first.partIndex
    );
}
