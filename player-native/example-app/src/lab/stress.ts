import type { PlaybackMode, PlayerHandle } from '@/build-time/contracts/video-player/contract';
import { LIMITS, type ExpectKind, type HealthProbe, type Observation } from './probe';

export interface Intensity {
    id: 'gentle' | 'rapid' | 'brutal';
    label: string;
    /** Actions per scenario. */
    iterations: number;
    /** Between actions. */
    intervalMs: number;
    /** How long the soak plays. */
    soakSeconds: number;
}

export const INTENSITIES: Intensity[] = [
    { id: 'gentle', label: 'Gentle', iterations: 8, intervalMs: 500, soakSeconds: 30 },
    { id: 'rapid', label: 'Rapid', iterations: 25, intervalMs: 80, soakSeconds: 60 },
    { id: 'brutal', label: 'Brutal', iterations: 80, intervalMs: 10, soakSeconds: 180 },
];

/** What a scenario may do to the lab. */
export interface StressContext {
    readonly signal: AbortSignal;
    readonly intensity: Intensity;
    readonly probe: HealthProbe;
    handle(): PlayerHandle | null;
    mode(): PlaybackMode;
    modes(): PlaybackMode[];
    /** Switches mode and resolves once the new player is ready (or null if it never was). */
    setMode(mode: PlaybackMode): Promise<number | null>;
    /** Loads the same source again in place, without waiting. */
    reload(): void;
    /** Unmounts and mounts the player, resolving once it is ready. */
    remount(): Promise<number | null>;
    log(line: string): void;
    progress(fraction: number): void;
}

export interface ScenarioResult {
    status: 'pass' | 'slow' | 'fail' | 'skipped';
    notes: string;
    ms: number;
}

interface Scenario {
    id: string;
    label: string;
    description: string;
    /** Why it cannot run here, or null when it can. */
    skip(context: StressContext): string | null;
    /** Returns the latency kind and sample its verdict turns on, if any. */
    run(context: StressContext): Promise<{ kind?: ExpectKind; last?: number | null; notes?: string }>;
}

class Aborted extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Aborted());
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Aborted());
        }, { once: true });
    });

async function repeat(context: StressContext, action: (i: number) => void | Promise<void>): Promise<void> {
    const { iterations, intervalMs } = context.intensity;
    for (let i = 0; i < iterations; i++) {
        if (context.signal.aborted) throw new Aborted();
        await action(i);
        context.progress((i + 1) / iterations);
        await sleep(intervalMs, context.signal);
    }
}

const handle = (context: StressContext) => {
    const player = context.handle();
    if (!player) throw new Error('No player mounted');
    return player;
};
const state = (context: StressContext) => context.handle()?.state ?? null;
/**
 * A seek has landed once playback moves on from the target. The adapter answers the position at
 * once (the controller reads it back before native can report), so "at the target" alone proves
 * nothing.
 */
export const landedAt = (target: number) => (o: Observation) =>
    o.playing && o.currentTime >= target + 0.25 && o.currentTime < target + 5;
/** The final target of a storm must differ from what is already active, or the call is a no-op. */
const other = <T>(ids: T[], active: T | null | undefined): T => ids.find((id) => id !== active) ?? ids[0]!;
const needsController = (context: StressContext) =>
    context.handle()?.controller ? null : 'needs a controller (not in YouTube mode)';
const needsReady = (context: StressContext) => (context.probe.data.last?.ready ? null : 'the player is not ready yet');

export const SCENARIOS: Scenario[] = [
    {
        id: 'play-pause',
        label: 'Play / pause flood',
        description: 'Toggles as fast as the intensity allows, then checks both still work.',
        skip: needsReady,
        async run(context) {
            await repeat(context, (i) => (i % 2 === 0 ? handle(context).play() : handle(context).pause()));
            // Whichever way the flood ended, both directions must still work: each is a real transition.
            handle(context).pause();
            await context.probe.expect('pause', 'pause after flood', (o) => !o.playing);
            void handle(context).play();
            const last = await context.probe.expect('play', 'play after flood', (o) => o.playing);
            handle(context).pause();
            await context.probe.expect('pause', 'pause after flood', (o) => !o.playing);
            return { kind: 'play', last };
        },
    },
    {
        id: 'seek-storm',
        label: 'Seek storm',
        description: 'Random seeks back to back; the last must land where asked.',
        skip: (context) => needsReady(context) ?? ((context.probe.data.last?.duration ?? 0) > 20 ? null : 'too short to seek around'),
        async run(context) {
            const duration = context.probe.data.last!.duration;
            await repeat(context, () => handle(context).seek(Math.random() * (duration - 10)));
            void handle(context).play();
            await context.probe.expect('play', 'playing before the final seek', (o) => o.playing);
            const target = Math.round(duration / 3);
            handle(context).seek(target);
            const last = await context.probe.expect('seek', `seek to ${target}s after storm`, landedAt(target));
            return { kind: 'seek', last };
        },
    },
    {
        id: 'load-storm',
        label: 'Reload storm',
        description: 'Loads the source again and again without waiting: the generation guards at work.',
        skip: () => null,
        async run(context) {
            await repeat(context, () => context.reload());
            // The storm's loads have settled by now; the verdict is one more, timed from its start.
            context.reload();
            const last = await context.probe.expect('startup', 'ready after reload storm', (o) => o.ready);
            return { kind: 'startup', last };
        },
    },
    {
        id: 'remount',
        label: 'Mount / unmount',
        description: 'Tears the component down and builds it again; nothing may be left behind.',
        skip: () => null,
        async run(context) {
            let last: number | null = null;
            const cycles = Math.min(context.intensity.iterations, 20);
            for (let i = 0; i < cycles; i++) {
                last = await context.remount();
                context.progress((i + 1) / cycles);
                await sleep(context.intensity.intervalMs, context.signal);
            }
            await sleep(1000, context.signal);
            const elements = context.probe.data.mediaElements;
            return { kind: 'startup', last, notes: `${elements} media element(s) left` };
        },
    },
    {
        id: 'angle-hop',
        label: 'Angle hop',
        description: 'Cycles the camera angles; the last choice must be the one playing.',
        skip: (context) => needsController(context) ?? ((state(context)?.angles.length ?? 0) > 1 ? null : 'the source has one angle'),
        async run(context) {
            const angles = state(context)!.angles.map((angle) => angle.id);
            await repeat(context, (i) => void handle(context).controller!.setAngle(angles[i % angles.length]!));
            await context.probe.expect('startup', 'settled after angle storm', (o) => o.ready);
            const target = other(angles, state(context)!.activeAngleId);
            const since = performance.now();
            void handle(context).controller!.setAngle(target);
            const last = await context.probe.expect('angle', `angle ${target}`, (o) => o.state?.activeAngleId === target && o.metadataAt > since);
            return { kind: 'angle', last };
        },
    },
    {
        id: 'quality-hop',
        label: 'Quality hop',
        description: 'Cycles the qualities and Auto; the last choice must stick.',
        skip: (context) => needsController(context) ?? ((state(context)?.qualities.length ?? 0) > 1 ? null : 'one quality only'),
        async run(context) {
            const ids = ['auto', ...state(context)!.qualities.map((quality) => quality.id)];
            await repeat(context, (i) => handle(context).controller!.setQuality(ids[i % ids.length]!));
            const target = other(ids, state(context)!.activeQualityId);
            handle(context).controller!.setQuality(target);
            const last = await context.probe.expect('quality', `quality ${target}`, (o) => o.state?.activeQualityId === target);
            return { kind: 'quality', last };
        },
    },
    {
        id: 'audio-hop',
        label: 'Language hop',
        description: 'Cycles the audio languages; the last must be the one heard (the hand-back rule).',
        skip: (context) => needsController(context) ?? ((state(context)?.audioTracks.length ?? 0) > 1 ? null : 'one language only'),
        async run(context) {
            const ids = state(context)!.audioTracks.map((track) => track.id);
            await repeat(context, (i) => handle(context).controller!.setAudioTrack(ids[i % ids.length]!));
            const target = other(ids, state(context)!.activeAudioTrackId);
            handle(context).controller!.setAudioTrack(target);
            const last = await context.probe.expect('audio', `language ${target}`, (o) => o.state?.activeAudioTrackId === target);
            return { kind: 'audio', last };
        },
    },
    {
        id: 'mode-hop',
        label: 'Mode hop',
        description: 'Switches between every available mode; each must come up ready.',
        skip: (context) => (context.modes().length > 1 ? null : 'one mode only'),
        async run(context) {
            const modes = context.modes();
            const start = context.mode();
            let last: number | null = null;
            const hops = Math.min(context.intensity.iterations, modes.length * 4);
            for (let i = 1; i <= hops; i++) {
                last = await context.setMode(modes[(modes.indexOf(start) + i) % modes.length]!);
                context.progress(i / hops);
                await sleep(context.intensity.intervalMs, context.signal);
            }
            if (context.mode() !== start) await context.setMode(start);
            return { kind: 'mode', last };
        },
    },
    {
        id: 'fullscreen',
        label: 'Full-screen in / out',
        description: 'Presents and dismisses repeatedly. Native only: a browser allows full-screen from a tap alone.',
        skip: (context) => (context.mode() === 'native' ? needsReady(context) : 'native mode only'),
        async run(context) {
            await repeat(context, (i) => (i % 2 === 0 ? handle(context).enterFullscreen() : handle(context).exitFullscreen()));
            await handle(context).exitFullscreen();
            return {};
        },
    },
    {
        id: 'chaos',
        label: 'Chaos',
        description: 'Random actions of every kind, then it must settle ready and playing.',
        skip: needsReady,
        async run(context) {
            const actions: ((player: PlayerHandle) => void)[] = [
                (player) => void player.play(),
                (player) => player.pause(),
                (player) => player.seek(Math.random() * Math.max(1, (context.probe.data.last?.duration ?? 60) - 10)),
                () => context.reload(),
            ];
            const s = state(context);
            if (s && s.angles.length > 1) actions.push((player) => void player.controller?.setAngle(s.angles[Math.floor(Math.random() * s.angles.length)]!.id));
            if (s && s.qualities.length) actions.push((player) => player.controller?.setQuality(Math.random() < 0.3 ? 'auto' : s.qualities[Math.floor(Math.random() * s.qualities.length)]!.id));
            if (s && s.audioTracks.length > 1) actions.push((player) => player.controller?.setAudioTrack(s.audioTracks[Math.floor(Math.random() * s.audioTracks.length)]!.id));
            await repeat(context, () => actions[Math.floor(Math.random() * actions.length)]!(handle(context)));
            await context.probe.expect('startup', 'ready after chaos', (o) => o.ready);
            handle(context).pause();
            await context.probe.expect('pause', 'paused after chaos', (o) => !o.playing);
            void handle(context).play();
            const last = await context.probe.expect('play', 'playing after chaos', (o) => o.playing);
            return { kind: 'play', last };
        },
    },
    {
        id: 'soak',
        label: 'Soak',
        description: 'Just plays, watching for stalls, freezes, leaks and a busy main thread.',
        skip: needsReady,
        async run(context) {
            void handle(context).play();
            await context.probe.expect('play', 'soak start', (o) => o.playing);
            const seconds = context.intensity.soakSeconds;
            for (let s = 0; s < seconds; s++) {
                await sleep(1000, context.signal);
                context.progress((s + 1) / seconds);
            }
            const d = context.probe.data;
            return { notes: `${d.stalls} stall(s), ${d.freezes} freeze(s) so far` };
        },
    },
];

/** Runs one scenario and judges it by what the probe saw while it ran. */
export async function runScenario(scenario: Scenario, context: StressContext): Promise<ScenarioResult> {
    const skip = scenario.skip(context);
    if (skip) return { status: 'skipped', notes: skip, ms: 0 };
    const before = context.probe.marks();
    const started = performance.now();
    context.log(`▶ ${scenario.label} (${context.intensity.label}, ${context.mode()})`);
    try {
        const outcome = await scenario.run(context);
        const ms = performance.now() - started;
        const after = context.probe.marks();
        const problems = [
            after.errors > before.errors && `${after.errors - before.errors} error(s)`,
            after.failures > before.failures && `${after.failures - before.failures} action(s) never took effect`,
            after.freezes > before.freezes && `${after.freezes - before.freezes} freeze(s)`,
        ].filter(Boolean);
        const slow = outcome.kind && outcome.last != null && outcome.last > LIMITS[outcome.kind].slow;
        const notes = [
            ...problems,
            outcome.kind && outcome.last != null && `${LIMITS[outcome.kind].label} ${Math.round(outcome.last)} ms`,
            outcome.notes,
        ].filter(Boolean).join(' · ');
        const status = problems.length ? 'fail' : slow ? 'slow' : 'pass';
        context.log(`  ${status.toUpperCase()} ${notes}`);
        return { status, notes, ms };
    } catch (error) {
        const ms = performance.now() - started;
        if (error instanceof Aborted) return { status: 'skipped', notes: 'stopped', ms };
        const message = (error as Error)?.message ?? String(error);
        context.log(`  FAIL threw: ${message}`);
        return { status: 'fail', notes: `threw: ${message}`, ms };
    }
}

export type { Scenario };
