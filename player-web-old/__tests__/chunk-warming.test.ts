import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkPrefetcher } from '../src/adapter/chunkWarming';
import type { ChunkBoundary } from '@luminary-media-converter/player-core';

const BASE = 'https://cdn.example.com/out/session';

/**
 * One chain of two chunk objects, 20s of media each — the shape
 * `buildChunkSchedules` produces from a byte-range media playlist. Built by
 * hand here: this spec is about the loop, not about reading playlists.
 */
const SCHEDULES: ChunkBoundary[][] = [
    [
        { url: `${BASE}/media/v0_0.m4s`, start: 0, end: 20 },
        { url: `${BASE}/media/v0_1.m4s`, start: 20, end: 40 },
    ],
];

function harness(
    watermark: () => number,
    overrides: Partial<{
        leadSeconds: number;
        warmBytes: number;
        log: (message: string) => void;
    }> = {},
    fetchImpl?: typeof fetch,
) {
    const calls: Array<{ url: string; range?: string }> = [];
    const impl =
        fetchImpl ??
        ((async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                url: String(input),
                range: (init?.headers as Record<string, string>)?.Range,
            });
            return { arrayBuffer: async () => new ArrayBuffer(8) };
        }) as unknown as typeof fetch);

    const prefetcher = new ChunkPrefetcher(
        { getWatermark: watermark },
        {
            leadSeconds: 60,
            warmBytes: 65_536,
            intervalMs: 1_000,
            fetchImpl: impl,
            ...overrides,
        },
    );
    return { prefetcher, calls };
}

describe('ChunkPrefetcher', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('warms the next chunk once the buffer is within the lead, with a Range header', async () => {
        let watermark = 5;
        const { prefetcher, calls } = harness(() => watermark, {
            leadSeconds: 10,
            warmBytes: 1024,
        });
        prefetcher.start(SCHEDULES);

        // 15s left in chunk 0 — too early.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(calls).toEqual([]);

        watermark = 12;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(calls).toEqual([
            { url: `${BASE}/media/v0_1.m4s`, range: 'bytes=0-1023' },
        ]);

        prefetcher.stop();
    });

    it('warms a chunk at most once, however many ticks pass', async () => {
        const { prefetcher, calls } = harness(() => 15, { leadSeconds: 10 });
        prefetcher.start(SCHEDULES);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls).toHaveLength(1);

        prefetcher.stop();
    });

    it('warms nothing past the last chunk', async () => {
        const { prefetcher, calls } = harness(() => 39, { leadSeconds: 10 });
        prefetcher.start(SCHEDULES);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(calls).toEqual([]);

        prefetcher.stop();
    });

    it('swallows a failing warm, does not retry it, and says so in the log', async () => {
        let attempts = 0;
        const rejecting = (async () => {
            attempts += 1;
            throw new Error('offline');
        }) as unknown as typeof fetch;
        const lines: string[] = [];
        const { prefetcher } = harness(
            () => 15,
            { leadSeconds: 10, log: (message) => lines.push(message) },
            rejecting,
        );

        prefetcher.start(SCHEDULES);
        // No rejection escapes: an unhandled one would fail this test outright.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(attempts).toBe(1);
        expect(lines).toContain('warm failed for v0_1.m4s (not retried)');

        prefetcher.stop();
    });

    it('stops ticking on stop()', async () => {
        let watermark = 0;
        const { prefetcher, calls } = harness(() => watermark, {
            leadSeconds: 10,
        });
        prefetcher.start(SCHEDULES);
        prefetcher.stop();

        watermark = 15;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls).toEqual([]);
    });

    it('does nothing at all without schedules', async () => {
        const { prefetcher, calls } = harness(() => 15);
        prefetcher.start([]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls).toEqual([]);
    });

    it('narrates the schedule when armed and every warm as it fires', async () => {
        const lines: string[] = [];
        const { prefetcher } = harness(() => 15, {
            leadSeconds: 10,
            warmBytes: 1024,
            log: (message) => lines.push(message),
        });

        prefetcher.start(SCHEDULES);
        expect(lines[0]).toBe(
            'armed: 1 chain(s), lead 10s — [v0_0.m4s 0–20s, v0_1.m4s 20–40s]',
        );

        await vi.advanceTimersByTimeAsync(1_000);
        expect(lines[1]).toBe(
            'warming v0_1.m4s: buffer front 15.0s, 5.0s left in v0_0.m4s, ' +
                'Range: bytes=0-1023',
        );
        expect(lines).toContain('warmed v0_1.m4s');

        prefetcher.stop();
    });
});
