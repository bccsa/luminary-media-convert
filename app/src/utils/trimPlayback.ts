import type { TrimSegment } from '../types';

/**
 * Playback rules for a source being trimmed.
 *
 * Trim ranges are the material that survives into the encode, so a preview that
 * plays straight through the discarded stretches shows something the output will
 * never contain. These decide where playback should be instead.
 */

/** Ranges sorted and stripped of anything degenerate. */
function usable(ranges: readonly TrimSegment[]): TrimSegment[] {
    return ranges
        .filter((r) => r.outSec > r.inSec)
        .slice()
        .sort((a, b) => a.inSec - b.inSec);
}

/** True when `t` falls inside material that will be kept. */
export function isKept(t: number, ranges: readonly TrimSegment[]): boolean {
    return usable(ranges).some((r) => t >= r.inSec && t < r.outSec);
}

/**
 * Where playback should jump to when `t` lands in discarded material.
 *
 * Returns the start of the next surviving range, or `null` when nothing survives
 * after `t` — the caller decides whether that means stop or wrap. Returns `null`
 * for a position that is already inside kept material, so callers can treat a
 * non-null result as "a jump is needed".
 */
export function nextKeptStart(
    t: number,
    ranges: readonly TrimSegment[],
): number | null {
    const list = usable(ranges);
    if (list.length === 0) return null;
    if (isKept(t, list)) return null;
    const next = list.find((r) => r.inSec > t);
    return next ? next.inSec : null;
}

/**
 * Whether a jump from `t` to `target` is worth making. Seeking on every frame
 * would fight the player, so a jump is only worth it once the gap is larger than
 * the tolerance a seek itself introduces.
 */
export function shouldSeek(
    t: number,
    target: number,
    toleranceSec = 0.25,
): boolean {
    return Math.abs(target - t) > toleranceSec;
}
