import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_INTERVAL_MS, Poller } from './poller.js';

describe('Poller', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('checks immediately, then on a FIXED 30s cadence (no backoff)', async () => {
        const check = vi.fn(async () => false);
        const poller = new Poller({ check, onAvailable: () => {} });

        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(check).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
        expect(check).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
        expect(check).toHaveBeenCalledTimes(3);

        // A backoff implementation would have skipped this one.
        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
        expect(check).toHaveBeenCalledTimes(4);

        poller.stop();
    });

    it('honours a custom interval', async () => {
        const check = vi.fn(async () => false);
        const poller = new Poller({
            intervalMs: 5_000,
            check,
            onAvailable: () => {},
        });
        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(check).toHaveBeenCalledTimes(2);
        poller.stop();
    });

    it('skips the immediate check when told to', async () => {
        const check = vi.fn(async () => false);
        const poller = new Poller({
            check,
            immediate: false,
            onAvailable: () => {},
        });
        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(check).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
        expect(check).toHaveBeenCalledTimes(1);
        poller.stop();
    });

    it('fires onAvailable once and stops', async () => {
        let available = false;
        const check = vi.fn(async () => available);
        const onAvailable = vi.fn();
        const poller = new Poller({ check, onAvailable });

        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        available = true;
        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);

        expect(onAvailable).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 3);
        expect(check).toHaveBeenCalledTimes(2);
    });

    it('stops on error and reports it', async () => {
        const onError = vi.fn();
        const poller = new Poller({
            check: async () => {
                throw new Error('boom');
            },
            onAvailable: () => {},
            onError,
        });

        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(onError).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 2);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('never runs another check after stop()', async () => {
        const check = vi.fn(async () => false);
        const poller = new Poller({ check, onAvailable: () => {} });
        poller.start();
        await vi.advanceTimersByTimeAsync(0);
        poller.stop();

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 5);
        expect(check).toHaveBeenCalledTimes(1);
    });
});
