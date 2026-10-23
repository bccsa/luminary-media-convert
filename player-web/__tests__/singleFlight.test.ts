import { describe, it, expect, vi } from 'vitest';
import { singleFlight } from '../src/singleFlight';

describe('singleFlight', () => {
    it('runs the task once and reuses the result', async () => {
        const task = vi.fn(() => Promise.resolve('loaded'));
        const get = singleFlight(task);

        await expect(get()).resolves.toBe('loaded');
        await expect(get()).resolves.toBe('loaded');

        expect(task).toHaveBeenCalledTimes(1);
    });

    it('shares one attempt between concurrent callers', async () => {
        // The reason the cache exists: two overlapping loads must not each fetch
        // the plugin.
        const task = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('x'), 5)));
        const get = singleFlight(task);

        await Promise.all([get(), get(), get()]);

        expect(task).toHaveBeenCalledTimes(1);
    });

    it('retries after a failure instead of replaying it', async () => {
        // The bug this exists to prevent: `cached ??= task()` keeps a rejected
        // promise, because a rejected promise is not nullish. One failed fetch
        // would then disable the feature for the life of the page.
        let attempt = 0;
        const get = singleFlight(() => {
            attempt += 1;
            return attempt === 1 ? Promise.reject(new Error('network')) : Promise.resolve('ok');
        });

        await expect(get()).rejects.toThrow('network');
        await expect(get()).resolves.toBe('ok');

        expect(attempt).toBe(2);
    });

    it('reports the failure to every caller waiting on it', async () => {
        // Clearing the slot must not swallow the rejection — a caller that
        // silently resolved would proceed as though the plugin had loaded.
        const get = singleFlight(() => Promise.reject(new Error('network')));

        const results = await Promise.allSettled([get(), get()]);

        expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });

    it('keeps retrying for as long as the task keeps failing', async () => {
        const task = vi.fn(() => Promise.reject(new Error('still down')));
        const get = singleFlight(task);

        await expect(get()).rejects.toThrow();
        await expect(get()).rejects.toThrow();
        await expect(get()).rejects.toThrow();

        expect(task).toHaveBeenCalledTimes(3);
    });
});
