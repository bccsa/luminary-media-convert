/**
 * The recovery ladder — the whole of it, policy and timers together.
 *
 * This is the reference implementation of the obligation `PlayerAdapter` states
 * in `player-core/src/types.ts`: before an adapter may declare playback over,
 * it must try its engine's own primitive, then re-attach a bounded number of
 * times with backoff, and only then ask the wrapper for the one repair it
 * cannot make itself — rebuilding the munged source.
 *
 * It lives here, in the adapter package, rather than in `player-core`, and the
 * reason is worth stating because it is the organising idea of the whole
 * arrangement. A native engine keeps pulling segments from its own threads
 * while a locked screen freezes the WebView; a ladder that lives in shared
 * JavaScript is frozen exactly when the playback it is guarding needs it. Nor
 * would extracting the *decisions* into a pure function in `player-core` help:
 * a pure `step()` a native adapter cannot call while suspended is a
 * specification wearing the costume of shared code. So the module is
 * self-contained — it imports one TYPE from the wrapper and nothing else — and
 * a platform without its own retry policy ports this file as a unit. A platform
 * that has one (ExoPlayer's `LoadErrorHandlingPolicy` is exactly a
 * retry-count-plus-backoff policy) satisfies the obligation with it instead;
 * two ladders on one engine would fight.
 *
 * The rungs, with the default policy:
 *
 * | | Rung | When | Needs JS |
 * |---|---|---|---|
 * | 0 | the engine's in-place primitive, once | immediately | no |
 * | 1 | `reattach()` | +2 s | no |
 * | 2 | ask for a re-munge | +4 s | **yes** |
 * | 3 | ask for a re-munge | +8 s | **yes** |
 * | — | exhausted: report the failure | | |
 *
 * Rung 1 is where the split earns itself: re-attaching re-creates the engine
 * against URLs the adapter already holds, which is all a transient failure
 * needs and all a backgrounded native player can do alone. The re-munge above
 * it is reserved for the failures that genuinely need the source rebuilt.
 */

import type {
    AdapterErrorCategory,
    AdapterErrorPayload,
    RecoveryPolicy,
} from '@luminary-media-converter/player-core';
import { monotonicNow } from './clock';

/** Why the ladder is climbing — passed through to the wrapper for logging. */
export type RecoveryReason = 'wedged' | 'fatal';

export interface RecoveryLadderHooks {
    /**
     * The engine's own in-place repair, or false when it has none to try.
     * Returning true for a repair that did nothing is worse than saying no: the
     * ladder believes it and stops climbing.
     */
    recoverInPlace(category: AdapterErrorCategory): boolean;
    /** Re-prepare the engine against the source it already holds. */
    reattach(): Promise<void>;
    /**
     * Ask the wrapper to rebuild the munged source. Needs JavaScript awake, so
     * a suspended runtime simply never delivers it — which is why the ladder
     * remembers the request and {@link RecoveryLadder.noteResumed} re-raises it.
     */
    requestReload(reason: RecoveryReason, attempt: number): void;
    /** Every rung spent. Playback is over; report the failure that got us here. */
    onExhausted(payload: AdapterErrorPayload): void;
}

export interface RecoveryLadderOptions {
    /**
     * Injectable clock, for tests. Defaults to {@link monotonicNow} — never
     * `Date.now`, whose jump across a suspension makes an error that recurred
     * the instant playback resumed look like a fresh one, restarting the ladder
     * at the wrong rung just when it should be escalating.
     */
    now?: () => number;
}

export class RecoveryLadder {
    private policy: RecoveryPolicy;
    private readonly now: () => number;

    private lastCategory: AdapterErrorCategory | null = null;
    private lastAt = 0;
    private attempts = 0;
    private triedInPlace = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    /** A re-munge asked for and not yet answered by playback moving again. */
    private pendingReload: { reason: RecoveryReason; attempt: number } | null =
        null;

    constructor(
        policy: RecoveryPolicy,
        private readonly hooks: RecoveryLadderHooks,
        options: RecoveryLadderOptions = {},
    ) {
        this.policy = policy;
        this.now = options.now ?? monotonicNow;
    }

    /** Adopt the policy the wrapper resolved for the source being attached. */
    setPolicy(policy: RecoveryPolicy): void {
        this.policy = policy;
    }

    /**
     * Feed in a failure. Non-fatal payloads are informational and ignored:
     * an engine that is still trying has not failed yet.
     */
    note(payload: AdapterErrorPayload, reason: RecoveryReason = 'fatal'): void {
        if (this.stopped || !payload.fatal) return;

        const at = this.now();
        const recurring =
            this.lastCategory === payload.category &&
            at - this.lastAt <= this.policy.escalationWindowMs;
        this.lastCategory = payload.category;
        this.lastAt = at;

        // The in-place card is spent once, and never on a recurrence: if the
        // same failure is already back inside the window, the engine's own
        // repair is what did not hold.
        if (!this.triedInPlace && !recurring) {
            this.triedInPlace = true;
            if (this.hooks.recoverInPlace(payload.category)) return;
        }

        this.climb(payload, reason);
    }

    /**
     * Playback is moving again. Everything resets, including any re-munge still
     * outstanding — it either arrived and worked, or stopped mattering.
     */
    notePlaybackHealthy(): void {
        this.lastCategory = null;
        this.lastAt = 0;
        this.attempts = 0;
        this.triedInPlace = false;
        this.pendingReload = null;
    }

    /**
     * A source was attached. Resets the ladder — unless this is the re-munge
     * the ladder itself asked for, which must not clear the count that decides
     * how much road is left. Without that exception a source rebuilt on rung 2
     * would reset to rung 0 and the ladder would climb the same steps forever.
     */
    noteSourceLoaded(): void {
        if (this.pendingReload) return;
        this.notePlaybackHealthy();
    }

    /**
     * The app came back to the foreground. A re-munge requested while the
     * runtime was suspended was never delivered — nothing was listening — so it
     * is raised again here rather than counted as an attempt that failed.
     */
    noteResumed(): void {
        if (this.stopped || !this.pendingReload) return;
        const { reason, attempt } = this.pendingReload;
        this.hooks.requestReload(reason, attempt);
    }

    destroy(): void {
        this.stopped = true;
        this.clearTimer();
        this.pendingReload = null;
    }

    private climb(payload: AdapterErrorPayload, reason: RecoveryReason): void {
        // An attempt is already scheduled; a second failure does not buy a
        // second rung, or a burst of errors would exhaust the ladder in a tick.
        if (this.timer !== null) return;

        if (this.attempts >= this.policy.maxReloadAttempts) {
            this.hooks.onExhausted(payload);
            return;
        }

        const attempt = this.attempts;
        this.attempts += 1;
        const delays = this.policy.reloadDelaysMs;
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;

        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.stopped) return;

            if (attempt === 0) {
                // Rung 1 — the repair that needs nothing from the wrapper, and
                // therefore the only one a suspended runtime could still make.
                void this.hooks
                    .reattach()
                    .catch(() => this.climb(payload, reason));
                return;
            }

            // Rung 2 and up. Remembered before it is raised: if nothing is
            // listening because the runtime is frozen, `noteResumed` raises it
            // again rather than letting the ladder count a silent loss.
            this.pendingReload = { reason, attempt: attempt + 1 };
            this.hooks.requestReload(reason, attempt + 1);
        }, delay);
    }

    private clearTimer(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}
