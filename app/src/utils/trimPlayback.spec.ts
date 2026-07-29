import { describe, expect, it } from 'vitest';
import { isKept, nextKeptStart, planPlaybackJump, shouldSeek } from './trimPlayback';
import type { TrimSegment } from '../types';

const r = (inSec: number, outSec: number): TrimSegment => ({ inSec, outSec });
const ranges = [r(10, 20), r(40, 50)];

describe('isKept', () => {
    it('is true inside a range', () => {
        expect(isKept(15, ranges)).toBe(true);
    });

    it('includes the start and excludes the end, so ranges do not double up', () => {
        expect(isKept(10, ranges)).toBe(true);
        expect(isKept(20, ranges)).toBe(false);
    });

    it('is false in discarded material', () => {
        expect(isKept(5, ranges)).toBe(false);
        expect(isKept(30, ranges)).toBe(false);
        expect(isKept(60, ranges)).toBe(false);
    });

    it('is false when nothing has been marked', () => {
        expect(isKept(15, [])).toBe(false);
    });
});

describe('nextKeptStart', () => {
    it('jumps forward to the next surviving range', () => {
        expect(nextKeptStart(30, ranges)).toBe(40);
    });

    it('jumps from before the first range to its start', () => {
        expect(nextKeptStart(0, ranges)).toBe(10);
    });

    it('stays put inside kept material', () => {
        expect(nextKeptStart(15, ranges)).toBeNull();
    });

    it('has nowhere to go past the last range', () => {
        expect(nextKeptStart(55, ranges)).toBeNull();
    });

    it('has nowhere to go when nothing is marked', () => {
        expect(nextKeptStart(15, [])).toBeNull();
    });

    it('handles ranges given out of order', () => {
        expect(nextKeptStart(30, [r(40, 50), r(10, 20)])).toBe(40);
    });

    it('ignores degenerate ranges', () => {
        expect(nextKeptStart(0, [r(30, 30), r(40, 50)])).toBe(40);
    });

    it('treats a range boundary as discarded, so playback moves on', () => {
        // 20 is the exclusive end of the first range: nothing is playing there.
        expect(nextKeptStart(20, ranges)).toBe(40);
    });
});

describe('shouldSeek', () => {
    it('is true for a jump worth making', () => {
        expect(shouldSeek(30, 40)).toBe(true);
    });

    it('is false within the tolerance a seek itself introduces', () => {
        expect(shouldSeek(39.9, 40)).toBe(false);
    });

    it('respects a custom tolerance', () => {
        expect(shouldSeek(39, 40, 2)).toBe(false);
        expect(shouldSeek(39, 40, 0.5)).toBe(true);
    });
});

describe('planPlaybackJump', () => {
    const ranges = [r(10, 20), r(40, 50)];

    it('does nothing while playback is inside kept material', () => {
        const plan = planPlaybackJump({ t: 15, ranges, pendingTarget: null });
        expect(plan).toEqual({ seekTo: null, pendingTarget: null });
    });

    it('jumps to the next range and remembers it', () => {
        const plan = planPlaybackJump({ t: 25, ranges, pendingTarget: null });
        expect(plan).toEqual({ seekTo: 40, pendingTarget: 40 });
    });

    it('does not fire a second seek while the first is still in flight', () => {
        // The player has not caught up yet — this is the frame that used to
        // re-seek, and the one after that, and the one after that.
        const plan = planPlaybackJump({
            t: 25,
            ranges,
            pendingTarget: 40,
            pendingAgeMs: 16,
        });
        expect(plan.seekTo).toBeNull();
        expect(plan.pendingTarget).toBe(40);
    });

    it('forgets the pending seek once playback arrives', () => {
        const plan = planPlaybackJump({ t: 40, ranges, pendingTarget: 40, pendingAgeMs: 50 });
        expect(plan).toEqual({ seekTo: null, pendingTarget: null });
    });

    it('forgets it if playback ended up in kept material some other way', () => {
        const plan = planPlaybackJump({ t: 15, ranges, pendingTarget: 40, pendingAgeMs: 50 });
        expect(plan).toEqual({ seekTo: null, pendingTarget: null });
    });

    it('retries a seek that never took effect', () => {
        const plan = planPlaybackJump({
            t: 25,
            ranges,
            pendingTarget: 40,
            pendingAgeMs: 1500,
        });
        expect(plan.seekTo).toBe(40);
    });

    it('leaves a jump smaller than the tolerance alone', () => {
        // Seeking 0.1s is not worth the stall it costs.
        const plan = planPlaybackJump({ t: 39.9, ranges, pendingTarget: null });
        expect(plan.seekTo).toBeNull();
    });

    it('does nothing past the last range', () => {
        const plan = planPlaybackJump({ t: 55, ranges, pendingTarget: null });
        expect(plan).toEqual({ seekTo: null, pendingTarget: null });
    });
});
