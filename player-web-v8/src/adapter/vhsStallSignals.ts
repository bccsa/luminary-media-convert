/**
 * Stall detection, as VHS reports it.
 *
 * VHS already watches playback far more closely than a wrapper could — its
 * `PlaybackWatcher` samples the buffer every 250 ms, knows a slow download from
 * a wedged decoder, skips gaps, corrects video underflow, and when the playhead
 * is stuck inside buffered data with three seconds ahead of it, seeks to
 * `currentTime` to kick the decoder — a seek that lands inside the buffer and
 * therefore resets nothing. Each of those verdicts is announced as a `usage`
 * event on the tech. This module listens for them and does two things:
 *
 * 1. Reports `stalled` — true on any of the verdicts, false once the playhead
 *    moves again — so the wrapper can show it.
 * 2. Counts the one verdict that means VHS is out of ideas. `vhs-unknown-waiting`
 *    is VHS having nudged and playback not having moved; three of them inside
 *    the window mean it nudged, and nudged, and nudged, and the engine is
 *    wedged. That becomes a fatal media error for the wrapper's recovery
 *    ladder, which can do the one thing VHS cannot: rebuild the source.
 *
 * The wrapper used to run its own watchdog beside this: a 10 s timer on
 * `currentTime` that seeked forward when it saw no progress. It could not tell
 * a slow chunk fetch from a wedge, its seek landed past the buffer end and made
 * VHS abort every request in flight, and `seeking`/`seeked` reset VHS's own
 * counters on the way past — so it compounded the stalls it was there to cure.
 * Detection is the engine's; this is the engine's detection.
 *
 * `usage` is not among the tech events video.js re-triggers on the player, so
 * the subscription goes on the tech itself, reached the same way the key seam
 * reaches VHS. A tech that does not emit `usage` (YouTube) simply never says
 * anything, and nothing here fires.
 */

import { monotonicNow } from '../drivers/clock';

/** `vhs-unknown-waiting` verdicts inside the window that count as wedged. */
export const UNKNOWN_WAITING_STRIKES = 3;

/**
 * How far back strikes count. VHS re-checks every 250 ms and nudges again once
 * five checks pass without movement, so three strikes span a few seconds of a
 * genuinely stuck engine; a window of the wrapper's own escalation window keeps
 * an isolated nudge from an hour ago out of the count.
 */
export const UNKNOWN_WAITING_WINDOW_MS = 10_000;

/** The VHS verdicts that mean playback stopped moving and VHS intervened. */
const STALL_VERDICTS = new Set(['vhs-unknown-waiting', 'vhs-video-underflow', 'vhs-gap-skip']);

/** Enough of a video.js tech to subscribe to `usage` on. */
export interface UsageEventTarget {
    on(type: string, listener: (event?: unknown) => void): void;
    off(type: string, listener: (event?: unknown) => void): void;
}

export interface VhsStallSignalHooks {
    /** Stall state changed. */
    onStalled: (stalled: boolean) => void;
    /** VHS nudged repeatedly and playback still did not move. */
    onWedged: (detail: { reason: 'vhs-unknown-waiting'; strikes: number; windowMs: number }) => void;
}

export interface VhsStallSignalOptions {
    strikes?: number;
    windowMs?: number;
    /** Injectable clock; defaults to {@link monotonicNow}. */
    now?: () => number;
}

export class VhsStallSignals {
    private readonly strikes: number;
    private readonly windowMs: number;
    private readonly now: () => number;

    private target: UsageEventTarget | null = null;
    private strikeTimes: number[] = [];
    private stalled = false;
    private lastTime = 0;

    constructor(
        private readonly hooks: VhsStallSignalHooks,
        options: VhsStallSignalOptions = {},
    ) {
        this.strikes = options.strikes ?? UNKNOWN_WAITING_STRIKES;
        this.windowMs = options.windowMs ?? UNKNOWN_WAITING_WINDOW_MS;
        this.now = options.now ?? monotonicNow;
    }

    /**
     * Listen on this tech; re-subscribes only if it is a different one. Safe
     * to call with whatever `player.tech()` currently returns, including
     * nothing and including an object with no event methods.
     */
    attach(target: unknown): void {
        const next = isUsageEventTarget(target) ? target : null;
        if (next === this.target) return;
        this.detach();
        if (!next) return;
        this.target = next;
        next.on('usage', this.onUsage);
    }

    detach(): void {
        this.target?.off('usage', this.onUsage);
        this.target = null;
    }

    /** A playhead sample. Forward movement ends the stall and the count. */
    noteTime(seconds: number): void {
        if (seconds <= this.lastTime) return;
        this.lastTime = seconds;
        this.clear();
    }

    /** A seek moved the playhead without playback having progressed. */
    resetBaseline(seconds: number): void {
        this.lastTime = seconds;
    }

    /** Pause, end, a new source: nothing is stalled and nothing is counting. */
    clear(): void {
        this.strikeTimes = [];
        this.setStalled(false);
    }

    private readonly onUsage = (event?: unknown): void => {
        const name = (event as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string' || !STALL_VERDICTS.has(name)) return;

        this.setStalled(true);
        if (name !== 'vhs-unknown-waiting') return;

        const now = this.now();
        this.strikeTimes = this.strikeTimes.filter((at) => now - at <= this.windowMs);
        this.strikeTimes.push(now);
        if (this.strikeTimes.length < this.strikes) return;

        // Counted from zero again so a ladder that takes its time is not
        // handed a second verdict for the same wedge.
        this.strikeTimes = [];
        this.hooks.onWedged({
            reason: 'vhs-unknown-waiting',
            strikes: this.strikes,
            windowMs: this.windowMs,
        });
    };

    private setStalled(stalled: boolean): void {
        if (this.stalled === stalled) return;
        this.stalled = stalled;
        this.hooks.onStalled(stalled);
    }
}

function isUsageEventTarget(value: unknown): value is UsageEventTarget {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as UsageEventTarget).on === 'function' &&
        typeof (value as UsageEventTarget).off === 'function'
    );
}
