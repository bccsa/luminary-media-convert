import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterErrorPayload, RecoveryPolicy } from '@luminary-media-converter/player-core';
import { RecoveryLadder } from '../src/drivers/RecoveryLadder';

const failure: AdapterErrorPayload = {
    category: 'network',
    code: 'network-error',
    message: 'offline',
    fatal: true,
};

const policy: RecoveryPolicy = {
    escalationWindowMs: 10_000,
    maxReloadAttempts: 3,
    reloadDelaysMs: [2_000, 4_000, 8_000],
};

/** The ladder's hooks, recording what it did and when. */
function make(overrides: Partial<RecoveryPolicy> = {}) {
    const steps: string[] = [];
    const ladder = new RecoveryLadder(
        { ...policy, ...overrides },
        {
            recoverInPlace: () => {
                steps.push('in-place');
                return false;
            },
            reattach: async () => {
                steps.push(`reattach@${Date.now()}`);
            },
            requestReload: (reason, attempt) => steps.push(`reload(${reason},${attempt})@${Date.now()}`),
            onExhausted: (payload) => steps.push(`exhausted:${payload.code}`),
        },
        { now: () => Date.now() },
    );
    return { ladder, steps };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('RecoveryLadder', () => {
    it('climbs in-place, re-attach, two reloads, then reports the failure', () => {
        const { ladder, steps } = make();
        ladder.note(failure);
        vi.advanceTimersByTime(2_000);
        ladder.note(failure);
        vi.advanceTimersByTime(4_000);
        ladder.note(failure);
        vi.advanceTimersByTime(8_000);
        ladder.note(failure);

        expect(steps).toEqual([
            'in-place',
            'reattach@2000',
            'reload(fatal,2)@6000',
            'reload(fatal,3)@14000',
            'exhausted:network-error',
        ]);
    });

    it('drops a rung scheduled before playback recovered', () => {
        const { ladder, steps } = make();
        ladder.note(failure);
        vi.advanceTimersByTime(1_000);

        ladder.notePlaybackHealthy();
        vi.advanceTimersByTime(10_000);

        expect(steps).toEqual(['in-place']);
    });

    it('drops a rung scheduled before another source was attached', () => {
        const { ladder, steps } = make();
        ladder.note(failure);
        vi.advanceTimersByTime(1_000);

        ladder.noteSourceLoaded();
        vi.advanceTimersByTime(10_000);

        expect(steps).toEqual(['in-place']);
    });

    it('reports the failure once; the next failure that counts is after playback moved again', () => {
        const { ladder, steps } = make({ maxReloadAttempts: 1, reloadDelaysMs: [1_000] });
        ladder.note(failure);
        vi.advanceTimersByTime(1_000);
        ladder.note(failure);
        ladder.note(failure);
        ladder.note(failure);
        expect(steps).toEqual(['in-place', 'reattach@1000', 'exhausted:network-error']);

        ladder.notePlaybackHealthy();
        ladder.note(failure);
        expect(steps.at(-1)).toBe('in-place');
    });

    it('raises again on resume a reload asked for across a suspension, and not one reported as failed', () => {
        const { ladder, steps } = make({ maxReloadAttempts: 2, reloadDelaysMs: [1_000] });
        ladder.note(failure);
        vi.advanceTimersByTime(1_000);
        ladder.noteSuspended();
        ladder.note(failure);
        vi.advanceTimersByTime(1_000);
        expect(steps.at(-1)).toBe('reload(fatal,2)@2000');

        ladder.noteResumed();
        expect(steps.at(-1)).toBe('reload(fatal,2)@2000');
        expect(steps.filter((step) => step.startsWith('reload'))).toHaveLength(2);

        ladder.noteSuspended();
        ladder.note(failure);
        expect(steps.at(-1)).toBe('exhausted:network-error');
        ladder.noteResumed();
        expect(steps.at(-1)).toBe('exhausted:network-error');
    });
});
