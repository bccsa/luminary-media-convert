/**
 * One in-flight attempt at a time, and only a success is remembered.
 *
 * Written for the lazy `videojs-youtube` import, where the obvious form is a bug:
 *
 * ```ts
 * cached ??= import('videojs-youtube');   // keeps a rejected promise too
 * ```
 *
 * `??=` assigns only when the slot is nullish, and a rejected promise is not
 * nullish. So a single failed chunk fetch — a flaky network, a stale dev-server
 * cache — is cached for the life of the page, and every later attempt rethrows
 * the first failure without ever retrying. A plugin that could not be fetched
 * once is then permanently unavailable, which is a much worse outcome than the
 * transient failure it came from.
 *
 * Concurrent callers still share one attempt: the point of the cache is that two
 * overlapping loads do not each fetch the plugin.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | null = null;

    return () => {
        if (!inFlight) {
            inFlight = task().catch((err) => {
                // Cleared before rethrowing, so the next call starts a fresh
                // attempt rather than replaying this one.
                inFlight = null;
                throw err;
            });
        }
        return inFlight;
    };
}
