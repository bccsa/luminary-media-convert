import { describe, expect, it } from 'vitest';
import { isKept, nextKeptStart, shouldSeek } from './trimPlayback';
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
