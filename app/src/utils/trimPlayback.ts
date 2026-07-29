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

export interface JumpPlan {
    /** Position to seek to, or null to leave playback alone this frame. */
    seekTo: number | null;
    /** Seek already in flight, carried to the next frame. */
    pendingTarget: number | null;
}

/**
 * Decide what to do about the play position on a single frame.
 *
 * A seek is not instant: `currentTime` keeps reporting the old position for a
 * while afterwards. Checked naively at animation-frame rate, that reads as "still
 * in discarded material" and fires another seek, then another — dozens of seeks
 * for one cut, which the player answers with a stall. So a seek is remembered
 * until it lands, and only re-issued if it appears to have been dropped.
 */
export function planPlaybackJump(opts: {
    t: number;
    ranges: readonly TrimSegment[];
    pendingTarget: number | null;
    /** Milliseconds since the pending seek was issued. */
    pendingAgeMs?: number;
    toleranceSec?: number;
    /** Give up on a seek that never took effect, and try once more. */
    retryAfterMs?: number;
}): JumpPlan {
    const {
        t,
        ranges,
        pendingTarget,
        pendingAgeMs = 0,
        toleranceSec = 0.25,
        retryAfterMs = 1000,
    } = opts;

    if (pendingTarget != null) {
        const arrived = t >= pendingTarget - toleranceSec;
        if (arrived || isKept(t, ranges)) {
            return { seekTo: null, pendingTarget: null };
        }
        if (pendingAgeMs < retryAfterMs) {
            return { seekTo: null, pendingTarget };
        }
        // Long overdue: the seek probably never took. Ask once more.
        return { seekTo: pendingTarget, pendingTarget };
    }

    if (isKept(t, ranges)) return { seekTo: null, pendingTarget: null };

    const target = nextKeptStart(t, ranges);
    if (target == null || !shouldSeek(t, target, toleranceSec)) {
        return { seekTo: null, pendingTarget: null };
    }
    return { seekTo: target, pendingTarget: target };
}
