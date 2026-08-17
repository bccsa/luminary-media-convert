/**
 * Quick trim (smart cut) part planning — pure, no I/O.
 *
 * A quick-trimmed stream is not one encode but a sequence of *parts*: spans
 * copied straight from the source, and short re-encoded "bridges" covering the
 * partial GOP at each cut. Every part is muxed on its own, so each one starts a
 * new segment run and, when its decoder configuration differs from its
 * neighbour's, carries its own `#EXT-X-MAP`.
 *
 * The invariant this file exists to hold: **every stream emits exactly three
 * parts per kept range**, so the discontinuity sequence is identical in every
 * playlist of the output. hls.js keys its timestamp alignment to the
 * discontinuity counter, so a video stream that happened to be cut on a
 * keyframe (needing no bridge) must still split there rather than emit one part
 * where its neighbours emit two. Part boundaries may differ between streams by
 * up to a GOP; the count may not.
 */

/**
 * Two times this close are the same instant. Keyframe times arrive from a
 * container's rational timebase via a decimal string, so a cut placed *on* a
 * keyframe by the UI will not compare equal to it without a tolerance.
 */
const EPSILON = 1e-6;

/** Median gap between consecutive keyframes, or undefined below two. */
function medianStep(keyframes: number[]): number | undefined {
    if (keyframes.length < 2) return undefined;
    const gaps = keyframes
        .slice(1)
        .map((k, i) => k - keyframes[i])
        .sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
}

/**
 * How a config asks for its streams to be produced — copied wholesale, encoded
 * again, or (only ever by mistake) some of each.
 *
 * There is no `trimMode` field to read: the copy checkboxes *are* the request.
 * All-copy plus a trim means quick cut, all-re-encode plus a trim means the
 * sample-accurate path, and a mixture means neither, because a trim's cut
 * points have to be authored the same way in every playlist of one output.
 */
export type TrimCopyMode = 'mixed' | 'precise' | 'quick';

/**
 * Which streams a config actually produces, as copy flags.
 *
 * Only the ones the encode opens: an audio-type config may still carry video
 * renditions a client left behind, and `FfmpegService.quickTrimStreamTargets`
 * ignores them — so this has to ignore them too, or the two disagree about what
 * "every stream" means.
 */
function copyFlags(config: TrimModeConfig): boolean[] {
    const flags: boolean[] = [];
    if (config.type === 'video') {
        for (const rendition of config.videoRenditions ?? []) {
            flags.push(rendition.copyStream === true);
        }
    }
    for (const group of config.audioGroups ?? []) {
        flags.push(group.copyStream === true);
    }
    return flags;
}

/** The slice of `EncodeConfigDto` the mode is read from. */
export interface TrimModeConfig {
    type?: string;
    videoRenditions?: { copyStream?: boolean }[];
    audioGroups?: { copyStream?: boolean }[];
    trimSegments?: unknown[];
}

export function trimCopyMode(config: TrimModeConfig): TrimCopyMode {
    const flags = copyFlags(config);
    if (flags.length === 0) return 'precise';
    if (flags.every((copied) => copied)) return 'quick';
    if (flags.every((copied) => !copied)) return 'precise';
    return 'mixed';
}

/**
 * Does this config ask for a quick trim?
 *
 * The controller gates on it and the encode service routes on it, from this one
 * function, so the request that was accepted is the request that runs.
 */
export function isQuickTrimConfig(config: TrimModeConfig): boolean {
    return (
        (config.trimSegments?.length ?? 0) > 0 &&
        trimCopyMode(config) === 'quick'
    );
}

/**
 * Segment numbers each part starts at, spaced so no two parts can collide.
 *
 * Parts are muxed independently and their segments land in one directory as
 * `segment_%07d.m4s`; the pipeline picks them up by prefix and suffix alone and
 * the playlist assembler reads them back in lexical order. Seven digits hold
 * 99 parts of up to 100000 segments each — which is why 99 parts is the cap
 * below rather than an arbitrary limit.
 */
export const PART_NUMBER_STRIDE = 100000;

/** See {@link PART_NUMBER_STRIDE}. */
export const MAX_PARTS_PER_STREAM = 99;

export interface StreamGrid {
    /** The stream's output directory, e.g. `stream_v0` — its identity here. */
    streamDir: string;
    kind: 'video' | 'audio';
    /**
     * Keyframe presentation times, ascending, on this stream's own grid.
     *
     * Null or empty means cut-anywhere, which is what an audio stream is: its
     * junctions land on an AAC frame at mux time (~21 ms at 48 kHz), so the
     * planner uses the exact times and lets the muxer round them.
     */
    keyframes: number[] | null;
    /**
     * The stream's first frames arrive out of presentation order (B-frames):
     * its first keyframe presents at t=0 but *decodes* at a negative time, and
     * a copy part starting there gets shifted by the reorder delay — fMP4
     * decode timelines cannot start negative, so the muxer moves the whole
     * part and the measurement (correctly) refuses it. When set, the copy
     * span of a range never starts at `keyframes[0]`; the head is bridged
     * through the first GOP instead. Mid-file starts are unaffected: their
     * decode times are positive under -copyts.
     */
    reordersAtStart?: boolean;
}

export interface QuickTrimPart {
    /** `copy` remuxes the source; `bridge` re-encodes a partial GOP. */
    kind: 'bridge' | 'copy';
    /** Position in this stream's part sequence, counted across all ranges. */
    partIndex: number;
    /**
     * Which kept range this part belongs to, indexing `trimSegments`.
     *
     * The runner produces every copy part of one range in a *single* ffmpeg
     * job, and this is how it knows where one range's copy run ends: two
     * consecutive copy parts may be a copy split inside a range (one job) or
     * the tail of one range and the head of the next (two jobs, seeking to
     * different places in the source), and their times alone do not say which.
     */
    rangeIndex: number;
    /** First segment number this part may write — `partIndex * 100000`. */
    startNumber: number;
    /** Part bounds on the source timeline, seconds. */
    start: number;
    end: number;
    /**
     * The part writes an init of its own, and its playlist entry carries an
     * `#EXT-X-MAP`. False means the previous part's map still applies — the
     * assembler emits no map at all, which is only correct while the decoder
     * configuration has not changed.
     */
    ownInit: boolean;
}

export interface QuickTrimStreamPlan {
    streamDir: string;
    parts: QuickTrimPart[];
    /**
     * Median keyframe spacing of this stream's grid, seconds; absent for
     * audio. The runner's copy-job seek aims one GOP past its keyframe with
     * this — the demuxer's landing rule (measured on both reference files) is
     * "largest keyframe at or before target minus one GOP".
     */
    keyframeStep?: number;
}

export interface QuickTrimPlan {
    streams: QuickTrimStreamPlan[];
    /** Segments the whole plan expects to produce, for progress reporting. */
    plannedTotalSegments: number;
}

/**
 * Why this source cannot be quick-trimmed. Not an error: the caller falls back
 * to the precise (full re-encode) path, and the reason says which stream and
 * which range made the geometry impossible.
 */
export interface QuickTrimRejection {
    reason: string;
}

/** A kept range, matching `TrimSegmentDto`. */
export interface QuickTrimRange {
    inSec: number;
    outSec: number;
}

export interface QuickTrimPlanInput {
    streams: StreamGrid[];
    trimSegments: QuickTrimRange[];
    /** Target segment length of the encode, seconds. */
    segmentDuration: number;
}

export function isQuickTrimRejection(
    result: QuickTrimPlan | QuickTrimRejection
): result is QuickTrimRejection {
    return (result as QuickTrimRejection).reason !== undefined;
}

/**
 * Segments a part is expected to produce. A bridge is one segment by
 * construction — it is a single closed GOP shorter than any target duration.
 */
export function estimateSegmentsForPart(
    part: QuickTrimPart,
    segmentDuration: number
): number {
    if (part.kind === 'bridge') return 1;
    return Math.max(1, Math.ceil((part.end - part.start) / segmentDuration));
}

/**
 * Where a range's copy span starts and ends on one stream's grid.
 *
 * `inPoint` is the first keyframe *strictly after* the cut and `outPoint` the
 * last one strictly before the range's end, which is what makes the on-keyframe
 * case degenerate rather than disappear: a cut sitting exactly on a keyframe
 * still leaves a whole GOP in front of `inPoint`, so the head part is a copy of
 * that GOP instead of a re-encode of a fragment. Three parts either way.
 */
interface RangeJunctions {
    inPoint: number;
    outPoint: number;
    headOnKeyframe: boolean;
    tailOnKeyframe: boolean;
}

function junctionsFor(
    keyframes: number[],
    range: QuickTrimRange,
    reordersAtStart = false
): RangeJunctions | null {
    // See StreamGrid.reordersAtStart: a copy span must not start at the
    // file's first keyframe on a B-frame stream, so that keyframe is neither
    // a valid in-point nor an on-keyframe head — the head part becomes a
    // bridge through the first GOP instead.
    const copyFloor = reordersAtStart
        ? keyframes[0] + EPSILON
        : Number.NEGATIVE_INFINITY;

    const headOnKeyframe = keyframes.some(
        (k) => Math.abs(k - range.inSec) <= EPSILON && k > copyFloor
    );
    const tailOnKeyframe = keyframes.some(
        (k) => Math.abs(k - range.outSec) <= EPSILON
    );

    const inPoint = keyframes.find(
        (k) => k > range.inSec + EPSILON && k > copyFloor
    );
    let outPoint: number | undefined;
    for (const k of keyframes) {
        if (k < range.outSec - EPSILON) outPoint = k;
        else break;
    }

    if (inPoint === undefined || outPoint === undefined) return null;
    if (outPoint - inPoint <= EPSILON) return null;
    return { inPoint, outPoint, headOnKeyframe, tailOnKeyframe };
}

function rejectRange(
    streamDir: string,
    range: QuickTrimRange
): QuickTrimRejection {
    return {
        reason:
            `Stream ${streamDir} has no whole keyframe interval inside the ` +
            `kept range ${range.inSec.toFixed(3)}–${range.outSec.toFixed(3)}s ` +
            `— the range is shorter than one GOP on this stream`,
    };
}

function validateRanges(ranges: QuickTrimRange[]): QuickTrimRejection | null {
    if (ranges.length === 0) return { reason: 'No kept ranges to plan' };
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        if (!(range.outSec - range.inSec > EPSILON)) {
            return {
                reason:
                    `Kept range ${range.inSec.toFixed(3)}–` +
                    `${range.outSec.toFixed(3)}s is empty`,
            };
        }
        if (i > 0 && range.inSec < ranges[i - 1].outSec - EPSILON) {
            return {
                reason:
                    `Kept ranges overlap or are out of order at ` +
                    `${range.inSec.toFixed(3)}s`,
            };
        }
    }
    return null;
}

/**
 * The three parts of one kept range, appended to a stream's sequence.
 *
 * `ownInit` marks the parts that begin an ffmpeg run, because a run writes an
 * init of its own and its segments can only be decoded against that one. A
 * bridge is always its own run — a fresh encode with its own SPS/PPS. So is the
 * first copy part of every kept range: the runner produces a range's copy span
 * in one job, seeking to that range's start. A copy part split off *inside* a
 * range comes out of the same run and continues its init.
 */
function appendParts(
    parts: QuickTrimPart[],
    rangeIndex: number,
    spans: { kind: 'bridge' | 'copy'; start: number; end: number }[]
): void {
    for (const span of spans) {
        const previous = parts[parts.length - 1];
        parts.push({
            kind: span.kind,
            partIndex: parts.length,
            rangeIndex,
            startNumber: parts.length * PART_NUMBER_STRIDE,
            start: span.start,
            end: span.end,
            ownInit:
                previous === undefined ||
                span.kind === 'bridge' ||
                previous.kind === 'bridge' ||
                previous.rangeIndex !== rangeIndex,
        });
    }
}

export function planQuickTrim(
    input: QuickTrimPlanInput
): QuickTrimPlan | QuickTrimRejection {
    const { streams, trimSegments, segmentDuration } = input;

    if (streams.length === 0) return { reason: 'No streams to plan' };
    if (!(segmentDuration > 0))
        return { reason: 'Segment duration must be positive' };

    const rangeProblem = validateRanges(trimSegments);
    if (rangeProblem) return rangeProblem;

    for (const stream of streams) {
        if (stream.kind !== 'video') continue;
        if ((stream.keyframes?.length ?? 0) < 2) {
            return {
                reason:
                    `Stream ${stream.streamDir} reported fewer than two ` +
                    `keyframes — its grid cannot be planned against`,
            };
        }
    }

    // Audio has no grid of its own, so its junctions are borrowed from the
    // first video stream's: within a GOP of every other stream's, which is the
    // tolerance the uniform-structure rule allows. With no video at all
    // (audio-only output) the range is split evenly instead.
    const reference = streams.find((s) => s.kind === 'video');

    const planned: QuickTrimStreamPlan[] = [];

    for (const stream of streams) {
        const parts: QuickTrimPart[] = [];

        for (const [rangeIndex, range] of trimSegments.entries()) {
            if (stream.kind === 'video') {
                const junctions = junctionsFor(
                    stream.keyframes!,
                    range,
                    stream.reordersAtStart
                );
                if (!junctions) return rejectRange(stream.streamDir, range);
                appendParts(parts, rangeIndex, [
                    {
                        kind: junctions.headOnKeyframe ? 'copy' : 'bridge',
                        start: range.inSec,
                        end: junctions.inPoint,
                    },
                    {
                        kind: 'copy',
                        start: junctions.inPoint,
                        end: junctions.outPoint,
                    },
                    {
                        kind: junctions.tailOnKeyframe ? 'copy' : 'bridge',
                        start: junctions.outPoint,
                        end: range.outSec,
                    },
                ]);
                continue;
            }

            const junctions = reference
                ? junctionsFor(
                      reference.keyframes!,
                      range,
                      reference.reordersAtStart
                  )
                : null;
            if (reference && !junctions)
                return rejectRange(reference.streamDir, range);
            const third = (range.outSec - range.inSec) / 3;
            const inPoint = junctions?.inPoint ?? range.inSec + third;
            const outPoint = junctions?.outPoint ?? range.outSec - third;
            appendParts(parts, rangeIndex, [
                { kind: 'copy', start: range.inSec, end: inPoint },
                { kind: 'copy', start: inPoint, end: outPoint },
                { kind: 'copy', start: outPoint, end: range.outSec },
            ]);
        }

        if (parts.length > MAX_PARTS_PER_STREAM) {
            return {
                reason:
                    `Stream ${stream.streamDir} would need ${parts.length} ` +
                    `parts; segment numbering allows ${MAX_PARTS_PER_STREAM}`,
            };
        }

        const keyframeStep =
            stream.kind === 'video' && stream.keyframes
                ? medianStep(stream.keyframes)
                : undefined;
        planned.push({
            streamDir: stream.streamDir,
            parts,
            ...(keyframeStep !== undefined ? { keyframeStep } : {}),
        });
    }

    const plannedTotalSegments = planned.reduce(
        (total, stream) =>
            total +
            stream.parts.reduce(
                (sum, part) =>
                    sum + estimateSegmentsForPart(part, segmentDuration),
                0
            ),
        0
    );

    return { streams: planned, plannedTotalSegments };
}
