import { reactive } from 'vue';
import type { PlayerState } from '@luminary-media-converter/player-core';
import { BROKEN_REJECTIONS, bridgeStats } from './bridgeStats';
import { Samples } from './samples';

export type Verdict = 'ok' | 'slow' | 'broken' | 'idle';

/** What the lab sees of the player, sampled every 100 ms and on every `timeupdate`. */
export interface Observation {
    currentTime: number;
    duration: number;
    /** From the controller where there is one; from the playhead moving in YouTube mode. */
    playing: boolean;
    /** The engine has the current load's item: its metadata arrived after the load began. */
    ready: boolean;
    /** `performance.now()` of the engine's last `loadedmetadata`; an item swap is done once this moves. */
    metadataAt: number;
    /** Null in YouTube mode. */
    state: Readonly<PlayerState> | null;
}

/** A timed expectation's limits, in milliseconds: above `slow` it is slow, never by `broken` it failed. */
export const LIMITS = {
    startup: { label: 'Load → ready', slow: 2500, broken: 10000 },
    play: { label: 'Play → playing', slow: 1000, broken: 5000 },
    pause: { label: 'Pause → paused', slow: 600, broken: 3000 },
    seek: { label: 'Seek → landed', slow: 1500, broken: 6000 },
    angle: { label: 'Angle switch', slow: 3000, broken: 10000 },
    // No engine event confirms these two, so they time the choice reaching the player's state.
    quality: { label: 'Quality choice → state', slow: 1500, broken: 6000 },
    audio: { label: 'Language choice → state', slow: 2000, broken: 8000 },
    mode: { label: 'Mode switch', slow: 4000, broken: 15000 },
} as const;
export type ExpectKind = keyof typeof LIMITS;

export interface Check {
    id: string;
    label: string;
    verdict: Verdict;
    detail: string;
}

interface Pending {
    kind: ExpectKind;
    label: string;
    test: (observation: Observation) => boolean;
    started: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (ms: number | null) => void;
}

const STALL_MS = 1500;
const FROZEN_MS = 5000;
/** After a load, seek or switch, buffering is expected; a quiet playhead then is not a stall. */
const DISRUPTION_GRACE_MS = 2500;

/**
 * Watches the player the lab is showing and turns what it sees into verdicts: broken (errors,
 * frozen playback, actions that never took effect), slow (latencies past their limit, stalls, a
 * busy main thread), or ok.
 */
export class HealthProbe {
    readonly data = reactive({
        latencies: {} as Record<string, Samples>,
        failures: [] as { kind: string; label: string; at: number }[],
        errors: [] as { source: string; message: string; at: number }[],
        stalls: 0,
        freezes: 0,
        timeupdates: 0,
        loopLag: new Samples(),
        heapStartMb: null as number | null,
        heapMb: null as number | null,
        mediaElements: 0,
        last: null as Observation | null,
    });

    private pending = new Set<Pending>();
    private lastTimeupdateAt = 0;
    private quietUntil = 0;
    private lastErrorKey = '';
    private started = false;
    /** Module evaluation and the first render make the opening seconds busy by nature. */
    private warmUntil = 0;

    start(): void {
        if (this.started) return;
        this.started = true;
        this.warmUntil = performance.now() + 3000;
        let expected = performance.now() + 250;
        setInterval(() => {
            const now = performance.now();
            if (now > this.warmUntil) this.data.loopLag.add(Math.max(0, now - expected));
            expected = now + 250;
            this.data.mediaElements = document.querySelectorAll('video, iframe').length;
            const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
            if (memory) {
                this.data.heapMb = memory.usedJSHeapSize / 1048576;
                this.data.heapStartMb ??= this.data.heapMb;
            }
            this.checkCadence();
        }, 250);
        const originalError = console.error.bind(console);
        console.error = (...args: unknown[]) => {
            this.error('console', args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
            originalError(...args);
        };
        window.addEventListener('error', (event) => this.error('uncaught', event.message));
        window.addEventListener('unhandledrejection', (event) =>
            this.error('unhandled rejection', (event.reason as Error)?.message ?? String(event.reason)),
        );
    }

    error(source: string, message: string): void {
        this.data.errors.push({ source, message, at: Date.now() });
        if (this.data.errors.length > 30) this.data.errors.shift();
    }

    /** A load, seek or switch is under way: buffering for a moment is expected, not a stall. */
    disrupted(): void {
        this.quietUntil = performance.now() + DISRUPTION_GRACE_MS;
    }

    observe(observation: Observation): void {
        this.data.last = observation;
        const error = observation.state?.error;
        const key = error ? `${error.code}:${error.message}` : '';
        if (key && key !== this.lastErrorKey) this.error(`player (${error!.code})`, error!.message);
        this.lastErrorKey = key;
        for (const pending of [...this.pending]) {
            if (pending.test(observation)) this.settle(pending, performance.now() - pending.started);
        }
    }

    timeupdate(): void {
        this.data.timeupdates++;
        this.lastTimeupdateAt = performance.now();
    }

    /** While playing, `timeupdate` stops only when playback has. */
    private checkCadence(): void {
        const last = this.data.last;
        const now = performance.now();
        if (!last?.playing || now < this.quietUntil || this.lastTimeupdateAt === 0) return;
        const gap = now - this.lastTimeupdateAt;
        if (gap > FROZEN_MS) {
            this.data.freezes++;
            this.lastTimeupdateAt = now;
        } else if (gap > STALL_MS && gap - 250 <= STALL_MS) {
            this.data.stalls++;
        }
    }

    /**
     * Resolves with how long [test] took to hold, or null if it never did within the kind's
     * `broken` limit, which is recorded as not working.
     */
    expect(kind: ExpectKind, label: string, test: (observation: Observation) => boolean): Promise<number | null> {
        this.disrupted();
        return new Promise((resolve) => {
            const pending: Pending = {
                kind,
                label,
                test,
                started: performance.now(),
                resolve,
                timer: setTimeout(() => this.settle(pending, null), LIMITS[kind].broken),
            };
            this.pending.add(pending);
            if (this.data.last && test(this.data.last)) this.settle(pending, 0);
        });
    }

    /** Pending expectations belong to the player that is going away; they are dropped, not failed. */
    abandonPending(): void {
        for (const pending of [...this.pending]) {
            clearTimeout(pending.timer);
            this.pending.delete(pending);
            pending.resolve(null);
        }
    }

    private settle(pending: Pending, ms: number | null): void {
        if (!this.pending.delete(pending)) return;
        clearTimeout(pending.timer);
        if (ms === null) {
            this.data.failures.push({ kind: pending.kind, label: pending.label, at: Date.now() });
            if (this.data.failures.length > 30) this.data.failures.shift();
        } else {
            (this.data.latencies[pending.kind] ??= new Samples()).add(ms);
        }
        pending.resolve(ms);
    }

    /** Counts a scenario compares before and after itself. */
    marks(): { failures: number; errors: number; freezes: number } {
        return {
            failures: this.data.failures.length,
            errors: this.data.errors.length,
            freezes: this.data.freezes,
        };
    }

    reset(): void {
        this.abandonPending();
        Object.assign(this.data, {
            latencies: {},
            failures: [],
            errors: [],
            stalls: 0,
            freezes: 0,
            timeupdates: 0,
            loopLag: new Samples(),
            heapStartMb: this.data.heapMb,
        });
        this.lastErrorKey = '';
        bridgeStats.reset();
    }

    // Verdicts.

    checks(): Check[] {
        const d = this.data;
        const checks: Check[] = [];
        const last = <T>(list: T[]) => list[list.length - 1];

        checks.push(
            d.errors.length
                ? { id: 'errors', label: 'Errors', verdict: 'broken', detail: `${d.errors.length} · ${last(d.errors)!.source}: ${last(d.errors)!.message}` }
                : { id: 'errors', label: 'Errors', verdict: 'ok', detail: 'none' },
        );
        checks.push(
            d.failures.length
                ? { id: 'failures', label: 'Not responding', verdict: 'broken', detail: `${d.failures.length} · last: ${last(d.failures)!.label}` }
                : { id: 'failures', label: 'Not responding', verdict: 'ok', detail: 'every action took effect' },
        );
        checks.push({
            id: 'cadence',
            label: 'Playback',
            verdict: d.freezes ? 'broken' : d.stalls ? 'slow' : d.timeupdates ? 'ok' : 'idle',
            detail: d.freezes
                ? `${d.freezes} freeze(s) over ${FROZEN_MS / 1000} s`
                : d.stalls
                  ? `${d.stalls} stall(s) over ${STALL_MS / 1000} s`
                  : `${d.timeupdates} timeupdates, no stalls`,
        });

        for (const [kind, limit] of Object.entries(LIMITS) as [ExpectKind, (typeof LIMITS)[ExpectKind]][]) {
            const samples = d.latencies[kind];
            if (!samples?.count) continue;
            const p95 = samples.p95 ?? 0;
            checks.push({
                id: kind,
                label: limit.label,
                verdict: p95 > limit.slow ? 'slow' : 'ok',
                detail: `p50 ${ms(samples.p50)} · p95 ${ms(p95)} · n=${samples.count}`,
            });
        }

        const lag = d.loopLag.p95 ?? 0;
        checks.push({
            id: 'loop',
            label: 'Main thread',
            verdict: d.loopLag.count < 12 ? 'idle' : lag > 250 ? 'broken' : lag > 60 ? 'slow' : 'ok',
            detail: `lag p95 ${ms(lag)} · max ${ms(d.loopLag.max)}`,
        });

        const methods = Object.entries(bridgeStats.calls);
        if (methods.length) {
            const [slowest, samples] = methods.reduce((a, b) => ((b[1].p95 ?? 0) > (a[1].p95 ?? 0) ? b : a));
            const broken = bridgeStats.rejections.filter((r) => BROKEN_REJECTIONS.has(r.code));
            const races = bridgeStats.rejections.length - broken.length;
            checks.push({
                id: 'bridge',
                label: 'Bridge calls',
                verdict: broken.length ? 'broken' : (samples.p95 ?? 0) > 250 ? 'slow' : 'ok',
                detail: broken.length
                    ? `${broken.length} rejected: ${last(broken)!.method} ${last(broken)!.code}`
                    : `slowest ${slowest} p95 ${ms(samples.p95)}${races ? ` · ${races} stale/unknown (races)` : ''}`,
            });
            const bytes = bridgeStats.loadBytes.max;
            if (bytes !== null) {
                checks.push({
                    id: 'payload',
                    label: 'Load payload',
                    verdict: bytes > 5_000_000 ? 'slow' : 'ok',
                    detail: `largest ${(bytes / 1024).toFixed(0)} KiB · ${bridgeStats.loadBytes.count} loads`,
                });
            }
        }

        const growth = d.heapMb !== null && d.heapStartMb !== null ? d.heapMb - d.heapStartMb : null;
        checks.push({
            id: 'leaks',
            label: 'Leaks',
            verdict: d.mediaElements > 2 || (growth ?? 0) > 150 ? 'broken' : (growth ?? 0) > 60 ? 'slow' : 'ok',
            detail: `${d.mediaElements} media element(s)${growth === null ? '' : ` · heap ${growth >= 0 ? '+' : ''}${growth.toFixed(0)} MB`}`,
        });
        return checks;
    }

    overall(checks: Check[] = this.checks()): Verdict {
        if (checks.some((check) => check.verdict === 'broken')) return 'broken';
        if (checks.some((check) => check.verdict === 'slow')) return 'slow';
        return checks.some((check) => check.verdict === 'ok') ? 'ok' : 'idle';
    }
}

function ms(value: number | null): string {
    if (value === null) return '–';
    return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

export const probe = new HealthProbe();
