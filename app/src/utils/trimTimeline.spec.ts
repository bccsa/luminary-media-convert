import { describe, expect, it } from 'vitest';
import {
    remapToOutputTimeline,
    slicePeaksToTrims,
    trimmedDuration,
} from './trimTimeline';
import type { Segment } from '@luminary-media-converter/segment-editor';
import type { TrimSegment } from '../types';

const trim = (inSec: number, outSec: number): TrimSegment => ({ inSec, outSec });
const seg = (id: string, inSec: number, outSec: number, label?: string): Segment => ({
    id,
    inSec,
    outSec,
    label,
});

describe('trimmedDuration', () => {
    it('sums the retained ranges', () => {
        expect(trimmedDuration([trim(10, 20), trim(40, 50)])).toBe(20);
    });

    it('is zero without trims', () => {
        expect(trimmedDuration([])).toBe(0);
    });

    it('ignores inverted ranges rather than subtracting them', () => {
        expect(trimmedDuration([trim(10, 20), trim(50, 40)])).toBe(10);
    });
});

describe('remapToOutputTimeline', () => {
    it('lays ranges end to end from zero', () => {
        const out = remapToOutputTimeline([seg('a', 10, 20), seg('b', 40, 50)]);
        expect(out.map((s) => [s.inSec, s.outSec])).toEqual([
            [0, 10],
            [10, 20],
        ]);
    });

    it('preserves ids and labels', () => {
        const out = remapToOutputTimeline([seg('a', 10, 20, 'Intro')]);
        expect(out[0].id).toBe('a');
        expect(out[0].label).toBe('Intro');
    });

    it('orders by source position before mapping', () => {
        const out = remapToOutputTimeline([seg('b', 40, 50), seg('a', 10, 20)]);
        expect(out.map((s) => s.id)).toEqual(['a', 'b']);
        expect(out[0].outSec).toBe(10);
    });

    it('does not mutate the input', () => {
        const input = [seg('a', 10, 20)];
        remapToOutputTimeline(input);
        expect(input[0].inSec).toBe(10);
    });

    it('returns an empty list for no segments', () => {
        expect(remapToOutputTimeline([])).toEqual([]);
    });
});

describe('slicePeaksToTrims', () => {
    // 100 peaks over 100 s — one peak per second, value === index.
    const peaks = Array.from({ length: 100 }, (_, i) => i);

    it('keeps only the retained ranges, concatenated', () => {
        const out = slicePeaksToTrims(peaks, 100, [trim(10, 20), trim(40, 50)]);
        expect(out).toHaveLength(20);
        expect(out!.slice(0, 3)).toEqual([10, 11, 12]);
        expect(out!.slice(10, 13)).toEqual([40, 41, 42]);
    });

    it('orders slices by source position', () => {
        const out = slicePeaksToTrims(peaks, 100, [trim(40, 50), trim(10, 20)]);
        expect(out![0]).toBe(10);
        expect(out![10]).toBe(40);
    });

    it('scales when peak count and duration differ', () => {
        const dense = Array.from({ length: 400 }, (_, i) => i);
        const out = slicePeaksToTrims(dense, 100, [trim(50, 75)]);
        expect(out).toHaveLength(100);
        expect(out![0]).toBe(200);
    });

    it('clamps ranges that run past the source', () => {
        const out = slicePeaksToTrims(peaks, 100, [trim(90, 200)]);
        expect(out).toHaveLength(10);
        expect(out![9]).toBe(99);
    });

    it('returns the source peaks when there is nothing to trim', () => {
        expect(slicePeaksToTrims(peaks, 100, [])).toEqual(peaks);
    });

    it('falls back to the source peaks when every range misses the source', () => {
        expect(slicePeaksToTrims(peaks, 100, [trim(500, 600)])).toEqual(peaks);
    });

    it('falls back on a missing or nonsensical duration', () => {
        expect(slicePeaksToTrims(peaks, 0, [trim(10, 20)])).toEqual(peaks);
        expect(slicePeaksToTrims(peaks, Number.NaN, [trim(10, 20)])).toEqual(peaks);
    });

    it('passes null through and never mutates the input', () => {
        expect(slicePeaksToTrims(null, 100, [trim(10, 20)])).toBeNull();
        const original = [...peaks];
        slicePeaksToTrims(peaks, 100, [trim(10, 20)]);
        expect(peaks).toEqual(original);
    });
});
