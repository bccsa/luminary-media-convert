import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_RECOVERY_POLICY,
    RecoveryManager,
    StallWatchdog,
    resolveRecoveryPolicy,
} from './recovery.js';
import type { PlayerError } from './types.js';

describe('resolveRecoveryPolicy', () => {
    it('merges overrides over the documented defaults', () => {
        expect(resolveRecoveryPolicy()).toEqual(DEFAULT_RECOVERY_POLICY);
        expect(resolveRecoveryPolicy({ maxReloadAttempts: 1 })).toMatchObject({
            maxReloadAttempts: 1,
            reloadDelaysMs: [2_000, 4_000, 8_000],
        });
    });
});

describe('RecoveryManager', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function harness(
        overrides: Parameters<typeof resolveRecoveryPolicy>[0] = {},
    ) {
        const recoverInPlace = vi.fn(() => true);
        const reload = vi.fn(async () => {});
        const onFatal = vi.fn<(error: PlayerError) => void>();
        let now = 0;
        const manager = new RecoveryManager(resolveRecoveryPolicy(overrides), {
            recoverInPlace,
            reload,
            onFatal,
            now: () => now,
        });
        return {
            manager,
            recoverInPlace,
            reload,
            onFatal,
            advanceClock: (ms: number) => {
                now += ms;
            },
            fail: (category: 'network' | 'media' = 'media') =>
                manager.handleError({ category, fatal: true }),
        };
    }

    it('ignores non-fatal errors', () => {
        const h = harness();
        h.manager.handleError({ category: 'media', fatal: false });
        expect(h.recoverInPlace).not.toHaveBeenCalled();
    });

    it('tries in-place recovery first', () => {
        const h = harness();
        h.fail();
        expect(h.recoverInPlace).toHaveBeenCalledWith('media');
        expect(h.reload).not.toHaveBeenCalled();
    });

    it('escalates 2s / 4s / 8s and then gives up', async () => {
        const h = harness();

        h.fail(); // in-place
        expect(h.recoverInPlace).toHaveBeenCalledTimes(1);

        h.fail(); // recurrence in window → reload #1 at 2s
        await vi.advanceTimersByTimeAsync(1_999);
        expect(h.reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.reload).toHaveBeenCalledTimes(1);

        h.fail(); // reload #2 at 4s
        await vi.advanceTimersByTimeAsync(3_999);
        expect(h.reload).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.reload).toHaveBeenCalledTimes(2);

        h.fail(); // reload #3 at 8s
        await vi.advanceTimersByTimeAsync(8_000);
        expect(h.reload).toHaveBeenCalledTimes(3);

        h.fail(); // attempts exhausted → fatal
        expect(h.onFatal).toHaveBeenCalledTimes(1);
        expect(h.onFatal.mock.calls[0]?.[0]).toMatchObject({
            code: 'media',
            fatal: true,
        });
    });

    it('reloads straight away when the adapter cannot recover in place', async () => {
        const h = harness();
        h.recoverInPlace.mockReturnValue(false);
        h.fail();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.reload).toHaveBeenCalledTimes(1);
    });

    it('retries in-place again when the recurrence falls outside the window', () => {
        const h = harness();
        h.fail();
        h.advanceClock(DEFAULT_RECOVERY_POLICY.escalationWindowMs + 1);
        h.fail();
        // Not a recurrence any more, but the in-place card is already spent.
        expect(h.recoverInPlace).toHaveBeenCalledTimes(1);
    });

    it('resets the ladder once playback is healthy again', () => {
        const h = harness();
        h.fail();
        h.manager.notePlaybackHealthy();
        h.fail();
        expect(h.recoverInPlace).toHaveBeenCalledTimes(2);
        expect(h.reload).not.toHaveBeenCalled();
    });

    it('does nothing after destroy()', async () => {
        const h = harness();
        h.manager.destroy();
        h.fail();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.recoverInPlace).not.toHaveBeenCalled();
        expect(h.reload).not.toHaveBeenCalled();
    });
});

describe('StallWatchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function harness(currentTime = { value: 0 }) {
        const seek = vi.fn((seconds: number) => {
            currentTime.value = seconds;
        });
        const onStalled = vi.fn<(stalled: boolean) => void>();
        const onWedged = vi.fn();
        const watchdog = new StallWatchdog(DEFAULT_RECOVERY_POLICY, {
            getCurrentTime: () => currentTime.value,
            seek,
            onStalled,
            onWedged,
        });
        return { watchdog, seek, onStalled, onWedged, currentTime };
    }

    it('nudges after 10s of no progress, then wedges 10s later', () => {
        const h = harness();
        // seek() would normally move currentTime; a truly wedged engine does not.
        h.seek.mockImplementation(() => {});
        h.watchdog.start();

        vi.advanceTimersByTime(9_999);
        expect(h.seek).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(h.onStalled).toHaveBeenCalledWith(true);
        expect(h.seek).toHaveBeenCalledWith(
            DEFAULT_RECOVERY_POLICY.stallNudgeSeconds,
        );
        expect(h.onWedged).not.toHaveBeenCalled();

        vi.advanceTimersByTime(10_000);
        expect(h.onWedged).toHaveBeenCalledTimes(1);
    });

    it('stays quiet while time advances', () => {
        const state = { value: 0 };
        const h = harness(state);
        h.watchdog.start();

        for (let i = 1; i <= 5; i++) {
            state.value = i * 10;
            vi.advanceTimersByTime(10_000);
        }
        expect(h.onStalled).not.toHaveBeenCalled();
        expect(h.onWedged).not.toHaveBeenCalled();
        h.watchdog.stop();
    });

    it('clears the stall once the nudge works', () => {
        const state = { value: 0 };
        const h = harness(state);
        h.watchdog.start();

        vi.advanceTimersByTime(10_000);
        expect(h.onStalled).toHaveBeenLastCalledWith(true);

        state.value = 30;
        vi.advanceTimersByTime(10_000);
        expect(h.onStalled).toHaveBeenLastCalledWith(false);
        expect(h.onWedged).not.toHaveBeenCalled();
        h.watchdog.stop();
    });

    it('stops checking after stop()', () => {
        const h = harness();
        h.watchdog.start();
        h.watchdog.stop();
        vi.advanceTimersByTime(60_000);
        expect(h.onWedged).not.toHaveBeenCalled();
    });
});
