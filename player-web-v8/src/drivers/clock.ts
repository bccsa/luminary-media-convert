/**
 * The clock playback policy is measured on.
 *
 * Wall-clock time is the wrong clock for a window or a backoff: a phone that
 * was locked for forty minutes wakes with `Date.now()` forty minutes ahead, so
 * an error that recurred the instant playback resumed looks like a fresh one
 * and a ladder restarts at the wrong rung. `performance.now()` is monotonic —
 * it never goes backwards and is unaffected by the wall clock being set — and
 * on the platforms that matter it does not run while the process is
 * suspended, which is the property a policy actually wants: elapsed time
 * *awake*.
 *
 * One function rather than a `Date.now` reference passed around, so the rule
 * has a name and a place, and so a native port has one thing to substitute
 * (`CLOCK_MONOTONIC`, `SystemClock.elapsedRealtime()`).
 */

/** Monotonic milliseconds. Only differences between two readings mean anything. */
export function monotonicNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}
