/**
 * Playback recovery policy and the stall watchdog.
 *
 * The split with the adapter: adapters expose recovery PRIMITIVES
 * (`recover()` — hls.js `recoverMediaError()` / `startLoad()`, ExoPlayer
 * `prepare()`, …); all POLICY lives here so every platform behaves identically
 * and the escalation ladder is testable without an engine.
 *
 * Ladder: fatal engine error → in-place `recover()` once → a same-category
 * error again inside `escalationWindowMs` → full reload of the munged source
 * (position + play state restored) at 2s / 4s / 8s → give up, `lifecycle:
 * 'error'`.
 */

import type {
    AdapterErrorCategory,
    AdapterErrorPayload,
    PlayerError,
    RecoveryPolicy,
} from './types.js';

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
    escalationWindowMs: 10_000,
    maxReloadAttempts: 3,
    reloadDelaysMs: [2_000, 4_000, 8_000],
    stallTimeoutMs: 10_000,
    stallNudgeSeconds: 0.1,
};

export function resolveRecoveryPolicy(
    overrides?: Partial<RecoveryPolicy>,
): RecoveryPolicy {
    return { ...DEFAULT_RECOVERY_POLICY, ...overrides };
}

export interface RecoveryHooks {
    /** Ask the adapter for an in-place recovery. */
    recoverInPlace: (category: AdapterErrorCategory) => boolean;
    /** Re-munge and re-attach the current source, restoring position + play state. */
    reload: (attempt: number) => Promise<void>;
    /** Escalation exhausted. */
    onFatal: (error: PlayerError) => void;
    /** A recovery attempt was made (attempt 0 = in-place). */
    onAttempt?: (attempt: number) => void;
    now?: () => number;
}

/** Drives the escalation ladder for engine errors. */
export class RecoveryManager {
    private readonly policy: RecoveryPolicy;
    private readonly now: () => number;
    private lastCategory: AdapterErrorCategory | null = null;
    private lastAt = 0;
    private reloadAttempts = 0;
    private triedInPlace = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(
        policy: RecoveryPolicy,
        private readonly hooks: RecoveryHooks,
    ) {
        this.policy = policy;
        this.now = hooks.now ?? (() => Date.now());
    }

    /** Feed an adapter error in. Non-fatal errors are ignored by design. */
    handleError(payload: AdapterErrorPayload): void {
        if (this.stopped || !payload.fatal) return;

        const at = this.now();
        const recurring =
            this.lastCategory === payload.category &&
            at - this.lastAt <= this.policy.escalationWindowMs;
        this.lastCategory = payload.category;
        this.lastAt = at;

        if (!this.triedInPlace && !recurring) {
            this.triedInPlace = true;
            if (this.hooks.recoverInPlace(payload.category)) {
                this.hooks.onAttempt?.(0);
                return;
            }
        }

        this.escalate(payload);
    }

    /** Playback made progress again — the ladder resets. */
    notePlaybackHealthy(): void {
        this.lastCategory = null;
        this.lastAt = 0;
        this.reloadAttempts = 0;
        this.triedInPlace = false;
    }

    destroy(): void {
        this.stopped = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private escalate(payload: AdapterErrorPayload): void {
        if (this.timer !== null) return; // a reload is already pending

        if (this.reloadAttempts >= this.policy.maxReloadAttempts) {
            this.hooks.onFatal(toPlayerError(payload));
            return;
        }

        const attempt = this.reloadAttempts;
        this.reloadAttempts += 1;
        const delays = this.policy.reloadDelaysMs;
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;

        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.stopped) return;
            this.hooks.onAttempt?.(attempt + 1);
            void this.hooks.reload(attempt + 1).catch(() => {
                // A failing reload surfaces as the next adapter error; if the
                // engine never reports one, the ladder still ends in onFatal.
                this.hooks.onFatal(toPlayerError(payload));
            });
        }, delay);
    }
}

function toPlayerError(payload: AdapterErrorPayload): PlayerError {
    const code: PlayerError['code'] =
        payload.category === 'network'
            ? 'network'
            : payload.category === 'media'
              ? 'media'
              : 'unknown';
    return {
        code,
        fatal: true,
        message: `Playback failed: unrecoverable ${payload.category} error`,
        cause: payload.detail,
    };
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

export interface StallWatchdogHooks {
    getCurrentTime: () => number;
    seek: (seconds: number) => void;
    /** Stall state changed. */
    onStalled: (stalled: boolean) => void;
    /** Still wedged after the nudge — hand over to the media-error path. */
    onWedged: () => void;
}

/**
 * Adapter-agnostic stall detection: while playing, no `currentTime` progress
 * for `stallTimeoutMs` → nudge `seek(+stallNudgeSeconds)`; still no progress
 * `stallTimeoutMs` later → wedged.
 *
 * Time is sampled from the adapter rather than counted from `timeupdate`
 * events, because an engine that has stopped decoding also stops emitting.
 */
export class StallWatchdog {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastTime = 0;
    private stage = 0;

    constructor(
        private readonly policy: Pick<
            RecoveryPolicy,
            'stallTimeoutMs' | 'stallNudgeSeconds'
        >,
        private readonly hooks: StallWatchdogHooks,
    ) {}

    /** Called when playback starts (or resumes). */
    start(): void {
        this.lastTime = this.hooks.getCurrentTime();
        this.stage = 0;
        this.arm();
    }

    /** Called on pause / ended / teardown. */
    stop(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.stage > 0) {
            this.stage = 0;
            this.hooks.onStalled(false);
        }
        this.stage = 0;
    }

    private arm(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.check();
        }, this.policy.stallTimeoutMs);
    }

    private check(): void {
        const time = this.hooks.getCurrentTime();
        if (time > this.lastTime) {
            this.lastTime = time;
            if (this.stage > 0) {
                this.stage = 0;
                this.hooks.onStalled(false);
            }
            this.arm();
            return;
        }

        this.stage += 1;
        if (this.stage === 1) {
            this.hooks.onStalled(true);
            this.hooks.seek(time + this.policy.stallNudgeSeconds);
            this.arm();
            return;
        }
        this.hooks.onWedged();
    }
}
