import type { Segment } from '@luminary-media-converter/segment-editor';
import type { TrimSegment } from '../types';

/**
 * Helpers for showing the *output* timeline once an encode has been submitted.
 *
 * Before Start Encoding the timeline spans the source file and trim segments mark
 * the ranges to keep. After submission those ranges are all that will exist in the
 * encoded output, so the timeline — duration, waveform and any segments drawn on
 * it — has to switch to the concatenated output timeline instead of continuing to
 * show material that has been cut away.
 */

/** Total duration of the encoded output: the retained ranges, concatenated. */
export function trimmedDuration(trims: readonly TrimSegment[]): number {
    return trims.reduce(
        (total, t) => total + Math.max(0, t.outSec - t.inSec),
        0,
    );
}

/**
 * Map source-timeline ranges onto the output timeline, where they sit end to end
 * from zero. Labels and ids are preserved so a trimmed range keeps its identity
 * as it becomes a chapter.
 */
export function remapToOutputTimeline(segments: readonly Segment[]): Segment[] {
    let cursor = 0;
    return segments
        .slice()
        .sort((a, b) => a.inSec - b.inSec)
        .map((s) => {
            const length = Math.max(0, s.outSec - s.inSec);
            const mapped = { ...s, inSec: cursor, outSec: cursor + length };
            cursor += length;
            return mapped;
        });
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
