import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SleepTimer } from './sleepTimer.js';
import type { SleepTimerState } from './types.js';

describe('SleepTimer', () => {
    let fired: number;
    let changes: (SleepTimerState | null)[];
    let timer: SleepTimer;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
        fired = 0;
        changes = [];
        timer = new SleepTimer(
            () => fired++,
            (state) => changes.push(state)
        );
    });
    afterEach(() => vi.useRealTimers());

    it('fires after the minutes it was given, not before', () => {
        timer.set({ kind: 'minutes', minutes: 15 });
        vi.advanceTimersByTime(15 * 60_000 - 1);
        expect(fired).toBe(0);
        vi.advanceTimersByTime(1);
        expect(fired).toBe(1);
    });

    it('says when it will fire, for a countdown, and is cleared once it has', () => {
        timer.set({ kind: 'minutes', minutes: 5 });
        expect(timer.state).toEqual({ kind: 'minutes', endsAt: Date.now() + 5 * 60_000 });
        vi.advanceTimersByTime(5 * 60_000);
        expect(timer.state).toBeNull();
        expect(changes.at(-1)).toBeNull();
    });

    it('is replaced by a new one, and the old one never fires', () => {
        timer.set({ kind: 'minutes', minutes: 5 });
        timer.set({ kind: 'minutes', minutes: 30 });
        vi.advanceTimersByTime(10 * 60_000);
        expect(fired).toBe(0);
        vi.advanceTimersByTime(20 * 60_000);
        expect(fired).toBe(1);
    });

    it('is cleared by null, and nothing fires', () => {
        timer.set({ kind: 'minutes', minutes: 5 });
        timer.set(null);
        vi.advanceTimersByTime(60 * 60_000);
        expect(fired).toBe(0);
        expect(timer.state).toBeNull();
    });

    it('ignores minutes that are not a positive number', () => {
        for (const minutes of [0, -5, NaN, Infinity]) {
            timer.set({ kind: 'minutes', minutes });
            expect(timer.state).toBeNull();
        }
    });

    it('stops at the end of the chapter: the time the playhead reaches it', () => {
        timer.set({ kind: 'chapter' }, 120);
        expect(timer.state).toEqual({ kind: 'chapter', endTime: 120 });
        timer.onTime(119.9);
        expect(fired).toBe(0);
        timer.onTime(120);
        expect(fired).toBe(1);
        expect(timer.state).toBeNull();
    });

    it('ignores a chapter timer with no end to wait for', () => {
        timer.set({ kind: 'chapter' });
        timer.set({ kind: 'chapter' }, NaN);
        expect(timer.state).toBeNull();
    });

    it('leaves a minutes timer running across a new source and ends a chapter timer', () => {
        timer.set({ kind: 'minutes', minutes: 10 });
        timer.onNewSource();
        expect(timer.state?.kind).toBe('minutes');

        timer.set({ kind: 'chapter' }, 60);
        timer.onNewSource();
        expect(timer.state).toBeNull();
    });

    it('tells the listener on every change', () => {
        timer.set({ kind: 'minutes', minutes: 5 });
        timer.set(null);
        expect(changes).toEqual([{ kind: 'minutes', endsAt: Date.now() + 5 * 60_000 }, null]);
    });
});
