import type { Segment } from '@luminary-media-converter/segment-editor';
import type { TrimSegment } from '../types';

/**
 * Helpers for showing the *output* timeline once an encode has been submitted.
 *
 * Before Start Encoding the timeline spans the source file and trim segments mark
 * the ranges to keep. After submission those ranges are all that will exist in the
 * encoded output, so the timeline — its duration and its waveform — has to switch
 * to the concatenated output rather than continuing to show material that has been
 * cut away.
 */

/** Total duration of the encoded output: the retained ranges, concatenated. */
export function trimmedDuration(trims: readonly TrimSegment[]): number {
    return trims.reduce(
        (total, t) => total + Math.max(0, t.outSec - t.inSec),
        0,
    );
}

/**
 * Slice source waveform peaks down to the retained ranges and concatenate them,
 * so the rendered waveform matches what the output actually contains.
 *
 * Peaks are evenly spaced across `sourceDuration`, so a time maps to an index by
 * simple proportion. Returns the input untouched when there is nothing to trim or
 * the inputs cannot be interpreted.
 */
export function slicePeaksToTrims(
    peaks: readonly number[] | null,
    sourceDuration: number,
    trims: readonly TrimSegment[],
): number[] | null {
    if (!peaks || peaks.length === 0) return peaks ? [...peaks] : null;
    if (trims.length === 0 || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        return [...peaks];
    }

    const perSecond = peaks.length / sourceDuration;
    const out: number[] = [];
    for (const t of trims.slice().sort((a, b) => a.inSec - b.inSec)) {
        const from = Math.max(0, Math.round(t.inSec * perSecond));
        const to = Math.min(peaks.length, Math.round(t.outSec * perSecond));
        if (to > from) out.push(...peaks.slice(from, to));
    }
    // A trim set that selects nothing usable (all ranges outside the source)
    // would blank the waveform entirely — keep the source peaks instead.
    return out.length > 0 ? out : [...peaks];
}

// ---------------------------------------------------------------------------
// Source ↔ output mapping
//
// While trimming, the timeline is more useful showing the programme than the
// source: the retained ranges laid end to end, so the waveform, the ruler and
// the playhead describe what will actually be encoded. Positions therefore have
// to be converted in both directions — the player still works in source time.
// ---------------------------------------------------------------------------

/** Ranges sorted, with anything degenerate dropped. */
function ordered<T extends { inSec: number; outSec: number }>(ranges: readonly T[]): T[] {
    return ranges.filter((r) => r.outSec > r.inSec).slice().sort((a, b) => a.inSec - b.inSec);
}

/**
 * Where a source position lands on the output timeline, or null when it falls in
 * discarded material and so has no place there.
 */
export function sourceToOutput(
    t: number,
    ranges: readonly TrimSegment[],
): number | null {
    let elapsed = 0;
    for (const r of ordered(ranges)) {
        if (t < r.inSec) return null;
        if (t < r.outSec) return elapsed + (t - r.inSec);
        elapsed += r.outSec - r.inSec;
    }
    return null;
}

/** Where an output position sits in the source file. */
export function outputToSource(
    t: number,
    ranges: readonly TrimSegment[],
): number {
    const list = ordered(ranges);
    if (list.length === 0) return t;
    let remaining = Math.max(0, t);
    for (const r of list) {
        const length = r.outSec - r.inSec;
        if (remaining < length) return r.inSec + remaining;
        remaining -= length;
    }
    const last = list[list.length - 1]!;
    return last.outSec;
}

/** The retained ranges laid end to end from zero, keeping ids and labels. */
export function toOutputSegments<T extends Segment>(source: readonly T[]): T[] {
    let cursor = 0;
    return ordered(source).map((s) => {
        const length = s.outSec - s.inSec;
        const mapped = { ...s, inSec: cursor, outSec: cursor + length };
        cursor += length;
        return mapped;
    });
}

/**
 * Fold edits made against the output timeline back onto the source ranges.
 *
 * Blocks are matched by id, and a block's change in length is applied to the
 * source range it stands for: growing a block's end extends that range further
 * into the material after it, and moving its start pulls the range's in-point.
 * Ids that were dropped are dropped; ids with no source counterpart are ignored,
 * since there is no defensible place to put them.
 */
export function applyOutputEdit<T extends Segment>(
    source: readonly T[],
    edited: readonly T[],
): T[] {
    const before = toOutputSegments(source);
    const byId = new Map(source.map((s) => [s.id, s]));
    const previousById = new Map(before.map((s) => [s.id, s]));

    const next: T[] = [];
    for (const block of edited) {
        const original = byId.get(block.id);
        const previous = previousById.get(block.id);
        if (!original || !previous) continue;

        const startDelta = block.inSec - previous.inSec;
        const endDelta = block.outSec - previous.outSec;
        const inSec = Math.max(0, original.inSec + startDelta);
        const outSec = Math.max(inSec, original.outSec + endDelta);
        next.push({ ...original, ...block, inSec, outSec });
    }
    return next.sort((a, b) => a.inSec - b.inSec);
}
