/**
 * The chunk warming loop — the web reference implementation of the semantics
 * `PlayerAdapter.warmChunks` specifies (see `player-core/src/types.ts`, and
 * `docs/chunk-warming.md` for the prose version).
 *
 * The wrapper works out WHICH chunk objects playback is about to need
 * (`buildChunkSchedules`, pure and serializable); this paces the requests
 * against the media element's buffer front. That pacing is deliberately
 * platform work: this ticker is a JS interval, and a backgrounded page — or a
 * locked phone — throttles or suspends it while a native player keeps playing.
 * A native adapter therefore re-implements the loop beside AVPlayer /
 * ExoPlayer, with this class as the reference for its semantics rather than as
 * something to call across a bridge.
 *
 * The bytes fetched are discarded ciphertext — nothing is decrypted, parsed or
 * handed to the engine. The warm is advisory in every direction: it never
 * blocks a load, never retries, and never surfaces an error.
 */

import type {
    ChunkBoundary,
    ChunkWarmOptions,
} from '@luminary-media-converter/player-core';

/** How often the watermark is sampled. Boundaries are tens of seconds apart. */
const DEFAULT_PREFETCH_INTERVAL_MS = 1_000;

export interface ChunkPrefetcherOptions extends ChunkWarmOptions {
    /** Watermark sampling interval. Default 1000. */
    intervalMs?: number;
}

export interface ChunkPrefetcherHooks {
    /**
     * How far playback has been buffered, in seconds.
     *
     * This must be the BUFFER FRONT, not the playhead. The engine crosses a
     * chunk boundary tens of seconds before the viewer reaches it, so a
     * playhead-driven warm would arrive after the engine already hit the cold
     * object — exactly the request it was supposed to get ahead of. Callers
     * that cannot report buffer progress fall back to `max(bufferedEnd,
     * currentTime)`, which degrades to the playhead rather than to nothing.
     */
    getWatermark: () => number;
}

/** Warms the next chunk object shortly before the buffer crosses into it. */
export class ChunkPrefetcher {
    private readonly leadSeconds: number;
    private readonly warmBytes: number;
    private readonly intervalMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly log: ((message: string) => void) | null;
    /** Chunk URLs already asked for — a chunk is warmed at most once. */
    private readonly warmed = new Set<string>();

    private schedules: ChunkBoundary[][] = [];
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly hooks: ChunkPrefetcherHooks,
        options: ChunkPrefetcherOptions,
    ) {
        this.leadSeconds = options.leadSeconds;
        this.warmBytes = options.warmBytes;
        this.intervalMs = options.intervalMs ?? DEFAULT_PREFETCH_INTERVAL_MS;
        this.fetchImpl = options.fetchImpl;
        this.log = options.log ?? null;
    }

    /**
     * Arm the ticker for one set of chains. Ticking continues while paused on
     * purpose: the watermark stops moving, so nothing is fetched, but a player
     * parked just short of a boundary gets its next chunk warmed before the
     * viewer presses play again.
     */
    start(schedules: ChunkBoundary[][]): void {
        this.stop();
        this.schedules = schedules;
        if (schedules.length === 0) return;
        this.log?.(
            `armed: ${schedules.length} chain(s), lead ${this.leadSeconds}s — ` +
                schedules
                    .map(
                        (s) =>
                            `[${s.map((b) => `${tail(b.url)} ${b.start.toFixed(0)}–${b.end.toFixed(0)}s`).join(', ')}]`,
                    )
                    .join(' '),
        );
        this.timer = setInterval(() => this.tick(), this.intervalMs);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.schedules = [];
    }

    private tick(): void {
        const watermark = this.hooks.getWatermark();
        if (!Number.isFinite(watermark)) return;

        for (const schedule of this.schedules) {
            const index = schedule.findIndex(
                (boundary) =>
                    watermark >= boundary.start && watermark < boundary.end,
            );
            if (index < 0) continue;

            const current = schedule[index]!;
            if (current.end - watermark > this.leadSeconds) continue;

            const next = schedule[index + 1];
            // Chunk 0 is warmed by the engine's own start-up requests, and a
            // run that continues in the same object needs nothing.
            if (!next || next.url === current.url) continue;
            this.warm(next.url, watermark, current);
        }
    }

    private warm(url: string, watermark: number, current: ChunkBoundary): void {
        if (this.warmed.has(url)) return;
        // Marked before the fetch, not after: two ticks must not both fire, and
        // a failed warm is not retried — the engine's own request will do the
        // warming, later and more slowly, which is the status quo anyway.
        this.warmed.add(url);

        this.log?.(
            `warming ${tail(url)}: buffer front ${watermark.toFixed(1)}s, ` +
                `${(current.end - watermark).toFixed(1)}s left in ${tail(current.url)}, ` +
                `Range: bytes=0-${this.warmBytes - 1}`,
        );

        void this.fetchImpl(url, {
            headers: { Range: `bytes=0-${this.warmBytes - 1}` },
        })
            .then((response) => response.arrayBuffer())
            .then(() => this.log?.(`warmed ${tail(url)}`))
            .catch(() => {
                // Advisory: a warm that fails changes nothing the viewer sees.
                this.log?.(`warm failed for ${tail(url)} (not retried)`);
            });
    }
}

/** The last path segment — logs want `v0_1.m4s`, not a whole URL. */
function tail(url: string): string {
    return url.slice(url.lastIndexOf('/') + 1);
}
