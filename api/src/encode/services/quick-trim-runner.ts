/**
 * Quick trim (smart cut) job runner — the executable half of
 * {@link ./quick-trim-plan.js}.
 *
 * A quick-trimmed stream is produced by one sequential ffmpeg job per planned
 * part, every job writing into that stream's `stream_<name>/` directory so
 * `SegmentPipelineService` picks the segments up live exactly as it does for a
 * normal encode. Chain membership, directory names and segment naming are the
 * ordinary conventions; only the numbering differs (`-start_number` per part,
 * `%07d`, stride {@link PART_NUMBER_STRIDE}) so parts cannot collide in one
 * directory.
 *
 * When every part of a stream is done its `part_<n>.m3u8` intermediates are
 * read back for the filenames the muxer actually wrote, spliced into one
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
 */

import { execFile } from 'child_process';
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';
import {
    buildSplicedMediaPlaylist,
    type SplicedPart,
    parseMediaPlaylist,
} from '@luminary-media-converter/hls';
import type {
    AudioGroupDto,
    EncodeConfigDto,
    TrimSegmentDto,
    VideoRenditionDto,
} from '../dto/encode-config.dto.js';
import { ffprobeBin } from './ffbin.js';
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

/** How far before a bridge's cut the decode starts, seconds. */
const BRIDGE_PREROLL_SECONDS = 2;

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
    logger: QuickTrimLogger;
    /** See {@link MAP_EVERY_PART}; defaults to it. */
    mapEveryPart?: boolean;
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
    part: QuickTrimPart;
    /** Where the demuxer is asked to seek — the retry moves this, not the part. */
    seekStart: number;
    segmentDuration: number;
}

export function buildCopyPartArgs(input: CopyPartArgsInput): string[] {
    const { part, sourceTrackIndex, seekStart } = input;

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
            String(part.end),
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
        String(part.end),
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

    if (useGpu && accelMode === 'nvidia') {
        return [
            '-c:v',
            'h264_nvenc',
            '-preset',
            'p4',
            ...profileArgs,
            ...rate,
            ...gop,
        ];
    }
    if (useGpu && accelMode === 'apple') {
        return [
            '-c:v',
            'h264_videotoolbox',
            '-allow_sw',
            '1',
            '-realtime',
            '0',
            ...profileArgs,
            ...rate,
            ...gop,
        ];
    }
    if (useGpu && accelMode === 'intel') {
        return [
            '-c:v',
            'h264_qsv',
            '-preset',
            'medium',
            ...profileArgs,
            ...rate,
            ...gop,
        ];
    }
    return [
        '-c:v',
        'libx264',
        // A bridge is under a second of video; the ladder's height-based preset
        // table is about throughput over a whole file.
        '-preset',
        'veryfast',
        // Pinned only here: the hardware encoders take their pixel format from
        // the frames they are handed, and refuse most of what could be named.
        '-pix_fmt',
        params?.pixFmt ?? 'yuv420p',
        ...profileArgs,
        ...rate,
        ...gop,
        '-keyint_min',
        String(BRIDGE_GOP_FRAMES),
        '-sc_threshold',
        '0',
    ];
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
 * init's edit list, which ffprobe applies — a bare segment reads as 0.
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

/** Everything a part wrote, so a retry starts from nothing. */
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
 * Splice one stream's finished parts into its `playlist.m3u8`.
 *
 * Segment filenames come from each part's own playlist — never from a directory
 * listing, whose order is the filesystem's business. Durations come from the
 * plan: only the last segment of a part is adjusted, because a copy part's
 * intermediate segments are as long as the muxer made them and only the tail is
 * free to absorb the spill past `-to` (a stream copy stops on DTS, so it
 * overshoots by a few frames by construction).
 */
async function assembleStreamPlaylist(
    streamDirPath: string,
    streamPlan: QuickTrimStreamPlan,
    mapEveryPart: boolean,
    logger: QuickTrimLogger
): Promise<void> {
    const parts: SplicedPart[] = [];

    for (const part of streamPlan.parts) {
        let parsed;
        try {
            parsed = parseMediaPlaylist(
                await readFile(
                    join(streamDirPath, partPlaylistName(part)),
                    'utf-8'
                )
            );
        } catch (err) {
            throw new QuickTrimRunError(
                `Part ${part.partIndex} of ${streamPlan.streamDir} wrote no ` +
                    `playlist: ${(err as Error).message}`,
                streamPlan.streamDir,
                part.partIndex
            );
        }
        if (parsed.segments.length === 0) {
            throw new QuickTrimRunError(
                `Part ${part.partIndex} of ${streamPlan.streamDir} produced ` +
                    `no segments`,
                streamPlan.streamDir,
                part.partIndex
            );
        }

        const span = part.end - part.start;
        const head = parsed.segments
            .slice(0, -1)
            .reduce((sum, s) => sum + s.duration, 0);
        // Rounded to the microsecond the assembler formats at: a raw float
        // difference (0.6200000000000001) no longer matches its own
        // six-decimal text, and the lossless builder then emits the noisy
        // number instead of the text.
        let tail = Math.round((span - head) * 1e6) / 1e6;
        if (!(tail > 0)) {
            logger.warn(
                `Part ${part.partIndex} of ${streamPlan.streamDir} overran ` +
                    `its planned ${span.toFixed(3)}s by ` +
                    `${(head - span).toFixed(3)}s before its last segment`
            );
            tail = MIN_AUTHORED_EXTINF;
        }

        parts.push({
            mapUri:
                mapEveryPart || part.ownInit ? partInitName(part) : undefined,
            segments: parsed.segments.map((segment, index) => ({
                uri: segment.uri,
                duration:
                    index === parsed.segments.length - 1
                        ? tail
                        : segment.duration,
            })),
        });
    }

    await writeFile(
        join(streamDirPath, 'playlist.m3u8'),
        buildSplicedMediaPlaylist(parts),
        'utf-8'
    );

    for (const part of streamPlan.parts) {
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

/**
 * Run every job of a plan, in order, and author what they produced.
 *
 * Sequential on purpose: the jobs share the host's single process slot, which
 * is what makes cancellation a matter of one killed child and a flag.
 */
export async function runQuickTrim(
    deps: QuickTrimRunnerDeps,
    opts: EncodeOptions,
    plan: QuickTrimPlan
): Promise<EncodeResult> {
    const { inputPath, outputDir, encodeConfig, onProgress } = opts;
    const segmentDuration = encodeConfig.segmentDuration ?? 6;
    const mapEveryPart = deps.mapEveryPart ?? MAP_EVERY_PART;

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
    let lastPercent = 0;
    const report = (fraction: number, weight: number): void => {
        if (totalWeight <= 0) return;
        const percent = Math.min(
            99.9,
            ((doneWeight + fraction * weight) / totalWeight) * 100
        );
        if (percent - lastPercent < 0.5) return;
        lastPercent = percent;
        onProgress(Math.round(percent * 10) / 10);
    };

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
        // Half a frame: a copy part starts on a keyframe, so anything closer
        // than that is the same frame reported through a rational timebase.
        const tolerance = 0.5 / (params?.frameRate ?? FALLBACK_FRAME_RATE);

        for (const part of streamPlan.parts) {
            if (deps.isCancelled()) throw new QuickTrimCancelledError();

            const weight = Math.max(part.end - part.start, 0);
            const onTime = (seconds: number): void => {
                const span = part.end - part.start;
                if (span <= 0) return;
                // `out_time` is the source clock under `-copyts` and the part's
                // own clock when the muxer rebased it; accept either.
                const absolute = (seconds - part.start) / span;
                const fraction =
                    absolute >= 0 && absolute <= 1.5
                        ? absolute
                        : seconds / span;
                report(Math.min(1, Math.max(0, fraction)), weight);
            };

            if (part.kind === 'bridge') {
                await runBridgePart(
                    deps,
                    { inputPath, streamDirPath, target, part, params },
                    onTime
                );
            } else {
                await runCopyPart(
                    deps,
                    {
                        inputPath,
                        streamDirPath,
                        streamDir: streamPlan.streamDir,
                        target,
                        part,
                        segmentDuration,
                        tolerance,
                    },
                    onTime
                );
            }

            doneWeight += weight;
        }

        await assembleStreamPlaylist(
            streamDirPath,
            streamPlan,
            mapEveryPart,
            deps.logger
        );
    }

    await writeFile(
        join(outputDir, 'master.m3u8'),
        buildQuickTrimMasterContent(encodeConfig, deps.targets),
        'utf-8'
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
    const useGpu = deps.accelMode !== 'cpu';
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
        part: QuickTrimPart;
        segmentDuration: number;
        tolerance: number;
    },
    onTime: (seconds: number) => void
): Promise<void> {
    const { part, target } = ctx;
    const label = `${ctx.streamDir} copy ${part.partIndex}`;

    const run = async (seekStart: number): Promise<void> => {
        await deps.runJob(
            buildCopyPartArgs({
                inputPath: ctx.inputPath,
                streamDirPath: ctx.streamDirPath,
                kind: target.kind,
                sourceTrackIndex: target.sourceTrackIndex,
                part,
                seekStart,
                segmentDuration: ctx.segmentDuration,
            }),
            onTime,
            label
        );
    };

    await run(part.start);

    // Audio cuts on the output side, on the frame grid, and needs no check.
    if (target.kind === 'audio') return;

    const landed = await measureFirstPts(ctx.streamDirPath, part, 'video');
    if (landed === null) {
        throw new QuickTrimRunError(
            `Could not measure where ${label} started`,
            ctx.streamDir,
            part.partIndex
        );
    }
    if (Math.abs(landed - part.start) <= ctx.tolerance) return;

    const bumped = Math.max(0, part.start + (part.start - landed));
    deps.logger.warn(
        `${label} landed at ${landed.toFixed(3)}s for ${part.start.toFixed(3)}s` +
            ` — retrying from ${bumped.toFixed(3)}s`
    );
    await deletePartOutput(ctx.streamDirPath, part);
    await run(bumped);

    const second = await measureFirstPts(ctx.streamDirPath, part, 'video');
    if (second !== null && Math.abs(second - part.start) <= ctx.tolerance) {
        return;
    }
    throw new QuickTrimRunError(
        `${label} could not be seeked to ${part.start.toFixed(3)}s ` +
            `(landed at ${landed.toFixed(3)}s, then ` +
            `${second === null ? 'unmeasurable' : `${second.toFixed(3)}s`})`,
        ctx.streamDir,
        part.partIndex
    );
}
