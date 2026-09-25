import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChunkBoundary } from '@luminary-media-converter/player-core';
import { ChunkPrefetcher } from '../src/adapter/chunkWarming';

/**
 * The warming loop, and in particular when it stops of its own accord.
 *
 * Warming each chunk at most once means a source runs out of work, and a
 * ticker sampling the buffer every second for the rest of the video after that
 * is a wakeup a low-end device pays for and gets nothing back — so the loop
 * stops once every warmable chunk has been warmed. `docs/chunk-warming.md`
 * (rule 9) allows it; these pin that it happens, and that it happens no sooner.
 */
const BASE = 'https://cdn.example.com/out/session';

/** One chain of three chunk objects, 20 s of media each. */
const CHAIN: ChunkBoundary[] = [
    { url: `${BASE}/media/v0_0.m4s`, start: 0, end: 20 },
    { url: `${BASE}/media/v0_1.m4s`, start: 20, end: 40 },
    { url: `${BASE}/media/v0_2.m4s`, start: 40, end: 60 },
];

function harness(schedules: ChunkBoundary[][], leadSeconds = 10) {
    let watermark = 0;
    let samples = 0;
    const warmed: string[] = [];
    const lines: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
        warmed.push(String(input));
        return { arrayBuffer: async () => new ArrayBuffer(8) };
    }) as unknown as typeof fetch;

    const prefetcher = new ChunkPrefetcher(
        {
            getWatermark: () => {
                samples += 1;
                return watermark;
            },
        },
        {
            leadSeconds,
            warmBytes: 1024,
            intervalMs: 1_000,
            fetchImpl,
            log: (message) => lines.push(message),
        },
    );
    prefetcher.start(schedules);

    return {
        prefetcher,
        warmed,
        lines,
        moveTo(seconds: number) {
            watermark = seconds;
        },
        samples: () => samples,
    };
}

describe('ChunkPrefetcher', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('warms each next chunk once as the buffer approaches it', async () => {
        const run = harness([CHAIN]);

        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(run.warmed).toEqual([`${BASE}/media/v0_1.m4s`]);

        run.moveTo(32);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(run.warmed).toEqual([`${BASE}/media/v0_1.m4s`, `${BASE}/media/v0_2.m4s`]);

        run.prefetcher.stop();
    });

    it('keeps sampling while any chunk is still to be warmed', async () => {
        // Paused just short of the first boundary, the buffer front still
        // moves, and the next chunk has to be warmed before play is pressed.
        const run = harness([CHAIN]);
        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(1_000);
        const afterFirstWarm = run.samples();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(run.samples()).toBe(afterFirstWarm + 5);

        run.prefetcher.stop();
    });

    it('stops sampling once every chunk has been warmed', async () => {
        const run = harness([CHAIN]);
        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(1_000);
        run.moveTo(32);
        await vi.advanceTimersByTimeAsync(1_000);
        const atLastWarm = run.samples();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(run.samples()).toBe(atLastWarm);
        expect(run.lines).toContain('every chunk warmed; ticker stopped');
    });

    it('waits for every chain, not only the first to finish', async () => {
        const audio: ChunkBoundary[] = [
            { url: `${BASE}/media/a_0.m4s`, start: 0, end: 50 },
            { url: `${BASE}/media/a_1.m4s`, start: 50, end: 100 },
        ];
        const run = harness([CHAIN, audio]);
        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(1_000);
        run.moveTo(32);
        await vi.advanceTimersByTimeAsync(1_000);
        // The video chain is done; the audio chain's second chunk is not.
        expect(run.warmed).toEqual([`${BASE}/media/v0_1.m4s`, `${BASE}/media/v0_2.m4s`]);

        const before = run.samples();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(run.samples()).toBe(before + 3);

        run.moveTo(45);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(run.warmed).toContain(`${BASE}/media/a_1.m4s`);
        const done = run.samples();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.samples()).toBe(done);
    });

    it('keeps sampling while a chunk skipped by a seek is still unwarmed', async () => {
        // Conservative on purpose: a seek back can still make that boundary
        // the next one, so the loop does not assume it will never be needed.
        const run = harness([CHAIN]);
        run.moveTo(32);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(run.warmed).toEqual([`${BASE}/media/v0_2.m4s`]);

        const before = run.samples();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(run.samples()).toBe(before + 3);

        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(run.warmed).toEqual([`${BASE}/media/v0_2.m4s`, `${BASE}/media/v0_1.m4s`]);
        const done = run.samples();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.samples()).toBe(done);
    });

    it('never starts sampling when there is nothing to warm', async () => {
        // A chain of one chunk: the engine's own start-up request fetches it.
        const run = harness([[{ url: `${BASE}/media/v0_0.m4s`, start: 0, end: 60 }]]);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.samples()).toBe(0);
        expect(run.lines).toContain('nothing left to warm; not ticking');
    });

    it('does not start again for chunks it has already warmed', async () => {
        // The same instance armed again with the same chains — every chunk is
        // already warmed, and at most once is per attached source.
        const run = harness([CHAIN]);
        run.moveTo(12);
        await vi.advanceTimersByTimeAsync(1_000);
        run.moveTo(32);
        await vi.advanceTimersByTimeAsync(1_000);

        run.prefetcher.start([CHAIN]);
        const armed = run.samples();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.samples()).toBe(armed);
        expect(run.warmed).toHaveLength(2);
    });
});
