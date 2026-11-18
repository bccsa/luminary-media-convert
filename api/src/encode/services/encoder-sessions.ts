/**
 * How many hardware encode sessions this process may hold open at once.
 *
 * The cap belongs to the driver, not to any one subsystem. GeForce cards limit
 * concurrent NVENC sessions — the ceiling has moved repeatedly (2, then 3, then
 * 5, now 8 on current drivers, and a GTX 1630 is capped at 3 whatever the
 * driver) — and every session in the process counts against the same number.
 *
 * That is why this is a module-level semaphore rather than a field on a
 * service. A per-service count would have the ladder, previews and quick-trim
 * bridges each politely staying under three and adding up to nine. A ladder
 * encoding while somebody scrubs the preview timeline is the ordinary case, not
 * a corner one.
 *
 * Exceeding the cap is not a graceful failure. The extra sessions fail to open
 * with "Could not open encoder before EOF", and the encode fails with them.
 */

/**
 * Concurrent sessions permitted.
 *
 * Three, not the eight a current driver might allow: the ceiling depends on the
 * card and the installed driver, neither of which we can read reliably, and
 * being wrong upward fails the encode. Hardware encoding is fast enough that
 * the queue is rarely the bottleneck.
 */
export const MAX_HARDWARE_SESSIONS = 3;

let held = 0;
const waiting: Array<() => void> = [];

/**
 * Wait for a session, then hold it until the returned function is called.
 *
 * Always release in a `finally`. A leaked permit is permanent — the process
 * loses a session for its lifetime, and enough leaks deadlock every encode.
 */
export async function acquireEncoderSession(): Promise<() => void> {
    if (held >= MAX_HARDWARE_SESSIONS) {
        await new Promise<void>((resolve) => waiting.push(resolve));
    }
    held++;

    let released = false;
    return () => {
        // Guard against a double release: two of them would let the count drop
        // below the real number of open sessions and quietly raise the cap.
        if (released) return;
        released = true;
        held--;
        waiting.shift()?.();
    };
}

/**
 * Hold `count` sessions at once, for a caller that opens several in one ffmpeg
 * invocation — the ladder encodes a wave of renditions from a single process.
 *
 * Acquired one at a time rather than all-or-nothing, which cannot deadlock
 * against other callers but does mean a large wave waits for the queue to drain
 * rather than jumping it. Callers ask for no more than the cap.
 */
export async function acquireEncoderSessions(
    count: number
): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (let i = 0; i < count; i++) {
        releases.push(await acquireEncoderSession());
    }
    return () => {
        for (const release of releases) release();
    };
}

/**
 * How long after its last segment a transcoded preview still counts as in use,
 * for an encode of some *other* session. Long enough to cover somebody who
 * stopped scrubbing to fill in a form and is about to scrub again.
 */
const PREVIEW_IN_USE_MS = 10 * 60 * 1000;

/** Sessions whose preview is transcoded, and when each last asked for a segment. */
const transcodedPreviews = new Map<string, number>();

/**
 * A session's preview is being transcoded: it opens an encoder for every
 * segment. Called when such a preview is built and again on each segment, so
 * the time is that of its last use.
 *
 * Only a transcoded preview is ever noted. One the browser plays from the file,
 * one that is remuxed, and an audio-only one open no encoder session.
 */
export function notePreviewNeedsSession(
    sessionId: string,
    now: number = Date.now()
): void {
    transcodedPreviews.set(sessionId, now);
}

/** The session's preview is gone, and with it any claim on a session. */
export function forgetPreviewSession(sessionId: string): void {
    transcodedPreviews.delete(sessionId);
}

/**
 * How many sessions a ladder about to encode `sessionId` may plan its waves
 * around: all of them, or one fewer when a transcoded preview is in use.
 *
 * The preview stalled, the moment an encode started, because its segments
 * queued behind waves that held every session for minutes at a time. Holding
 * one back removes the queue at its source — but it costs the ladder a third of
 * its width, so it is held back only when a preview will actually open an
 * encoder: the encoding session's own preview is a transcoded one, or another
 * session's was asked for a segment recently.
 *
 * Asked once, when a session's first encode starts, and kept with the session:
 * a continued encode has to plan the same waves as the run it continues.
 */
export function ladderSessionCap(
    sessionId: string,
    now: number = Date.now()
): number {
    for (const [id, lastUsed] of transcodedPreviews) {
        if (id === sessionId || now - lastUsed <= PREVIEW_IN_USE_MS) {
            return Math.max(1, MAX_HARDWARE_SESSIONS - 1);
        }
    }
    return MAX_HARDWARE_SESSIONS;
}

/** How many sessions are held. For tests and for logging a stall. */
export function heldEncoderSessions(): number {
    return held;
}

/** Test-only: drop all state so one spec's queue cannot leak into the next. */
export function resetEncoderSessions(): void {
    held = 0;
    waiting.length = 0;
    transcodedPreviews.clear();
}
