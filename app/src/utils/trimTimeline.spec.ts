import { describe, expect, it } from 'vitest';
import {
    applyOutputEdit,
    outputToSource,
    slicePeaksToTrims,
    sourceToOutput,
    toOutputSegments,
    trimmedDuration,
} from './trimTimeline';
import type { Segment } from '@luminary-media-converter/segment-editor';
import type { TrimSegment } from '../types';

const trim = (inSec: number, outSec: number): TrimSegment => ({ inSec, outSec });
const seg = (id: string, inSec: number, outSec: number, label = ''): Segment => ({
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

describe('sourceToOutput', () => {
    const ranges = [trim(10, 20), trim(40, 50)];

    it('maps the first kept range onto the start of the output', () => {
        expect(sourceToOutput(10, ranges)).toBe(0);
        expect(sourceToOutput(15, ranges)).toBe(5);
    });

    it('closes the gap for later ranges', () => {
        expect(sourceToOutput(40, ranges)).toBe(10);
        expect(sourceToOutput(45, ranges)).toBe(15);
    });

    it('has no answer for discarded material', () => {
        expect(sourceToOutput(5, ranges)).toBeNull();
        expect(sourceToOutput(30, ranges)).toBeNull();
        expect(sourceToOutput(60, ranges)).toBeNull();
    });
});

describe('outputToSource', () => {
    const ranges = [trim(10, 20), trim(40, 50)];

    it('walks the ranges in order', () => {
        expect(outputToSource(0, ranges)).toBe(10);
        expect(outputToSource(5, ranges)).toBe(15);
        expect(outputToSource(10, ranges)).toBe(40);
        expect(outputToSource(15, ranges)).toBe(45);
    });

    it('clamps past the end to the last frame kept', () => {
        expect(outputToSource(999, ranges)).toBe(50);
    });

    it('is the identity when nothing is marked', () => {
        expect(outputToSource(42, [])).toBe(42);
    });

    it('round-trips with sourceToOutput', () => {
        for (const t of [10, 12.5, 19.9, 40, 47]) {
            expect(outputToSource(sourceToOutput(t, ranges)!, ranges)).toBeCloseTo(t, 6);
        }
    });
});

describe('toOutputSegments', () => {
    it('lays the ranges end to end from zero', () => {
        const out = toOutputSegments([seg('a', 10, 20), seg('b', 40, 50)]);
        expect(out.map((s) => [s.inSec, s.outSec])).toEqual([[0, 10], [10, 20]]);
    });

    it('keeps ids and labels', () => {
        const out = toOutputSegments([seg('a', 10, 20, 'Intro')]);
        expect(out[0].id).toBe('a');
        expect(out[0].label).toBe('Intro');
    });

    it('orders by source position before laying out', () => {
        const out = toOutputSegments([seg('b', 40, 50), seg('a', 10, 20)]);
        expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    });
});

describe('applyOutputEdit', () => {
    const source = [seg('a', 10, 20), seg('b', 40, 50)];

    it('is a no-op when nothing moved', () => {
        const out = applyOutputEdit(source, toOutputSegments(source));
        expect(out.map((s) => [s.inSec, s.outSec])).toEqual([[10, 20], [40, 50]]);
    });

    it('folds a lengthened block back onto its source out-point', () => {
        const edited = toOutputSegments(source);
        edited[0] = { ...edited[0], outSec: edited[0].outSec + 3 };
        const out = applyOutputEdit(source, edited);
        expect(out[0].outSec).toBe(23);
        expect(out[1]).toEqual(source[1]);
    });

    it('folds a moved start back onto its source in-point', () => {
        const edited = toOutputSegments(source);
        edited[0] = { ...edited[0], inSec: edited[0].inSec + 2 };
        const out = applyOutputEdit(source, edited);
        expect(out[0].inSec).toBe(12);
        expect(out[0].outSec).toBe(20);
    });

    it('edits a later block without disturbing the ones before it', () => {
        const edited = toOutputSegments(source);
        edited[1] = { ...edited[1], outSec: edited[1].outSec + 5 };
        const out = applyOutputEdit(source, edited);
        expect(out[0]).toEqual(source[0]);
        expect(out[1].outSec).toBe(55);
    });

    it('drops a block that was deleted', () => {
        const edited = toOutputSegments(source).filter((s) => s.id !== 'a');
        const out = applyOutputEdit(source, edited);
        expect(out.map((s) => s.id)).toEqual(['b']);
        expect(out[0]).toEqual(source[1]);
    });

    it('ignores a block with no source counterpart', () => {
        const edited = [...toOutputSegments(source), seg('new', 20, 30)];
        const out = applyOutputEdit(source, edited);
        expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('never lets an edit invert a range', () => {
        const edited = toOutputSegments(source);
        edited[0] = { ...edited[0], outSec: edited[0].inSec - 5 };
        const out = applyOutputEdit(source, edited);
        expect(out[0].outSec).toBeGreaterThanOrEqual(out[0].inSec);
    });
});
