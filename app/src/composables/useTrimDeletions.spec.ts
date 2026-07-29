import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useTrimDeletions } from './useTrimDeletions';
import type { Segment } from '@luminary-media-converter/segment-editor';

const seg = (id: string, inSec: number, outSec: number, label = ''): Segment => ({
    id,
    inSec,
    outSec,
    label,
});

describe('useTrimDeletions', () => {
    it('records a removed range', () => {
        const segments = ref<Segment[]>([seg('b', 30, 40)]);
        const { removed, record } = useTrimDeletions(segments);
        record(seg('a', 10, 20, 'Intro'));
        expect(removed.value).toHaveLength(1);
        expect(removed.value[0].label).toBe('Intro');
    });

    it('keeps the removed list in source order, not deletion order', () => {
        const segments = ref<Segment[]>([]);
        const { removed, record } = useTrimDeletions(segments);
        record(seg('c', 50, 60));
        record(seg('a', 10, 20));
        record(seg('b', 30, 40));
        expect(removed.value.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('ignores a duplicate removal of the same range', () => {
        const segments = ref<Segment[]>([]);
        const { removed, record } = useTrimDeletions(segments);
        record(seg('a', 10, 20));
        record(seg('a', 10, 20));
        expect(removed.value).toHaveLength(1);
    });

    it('restores a range to its original position', () => {
        const segments = ref<Segment[]>([seg('a', 10, 20), seg('c', 50, 60)]);
        const { removed, record, restore } = useTrimDeletions(segments);
        record(seg('b', 30, 40, 'Middle'));
        restore('b');
        expect(segments.value.map((s) => s.id)).toEqual(['a', 'b', 'c']);
        expect(segments.value[1].label).toBe('Middle');
        expect(removed.value).toHaveLength(0);
    });

    it('restores in front of everything when it came first', () => {
        const segments = ref<Segment[]>([seg('b', 30, 40)]);
        const { record, restore } = useTrimDeletions(segments);
        record(seg('a', 10, 20));
        restore('a');
        expect(segments.value.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('does not duplicate a range that is somehow already back', () => {
        const segments = ref<Segment[]>([seg('a', 10, 20)]);
        const { removed, record, restore } = useTrimDeletions(segments);
        record(seg('a', 10, 20));
        restore('a');
        expect(segments.value).toHaveLength(1);
        expect(removed.value).toHaveLength(0);
    });

    it('ignores a restore for something it never recorded', () => {
        const segments = ref<Segment[]>([seg('a', 10, 20)]);
        const { restore } = useTrimDeletions(segments);
        restore('nope');
        expect(segments.value).toHaveLength(1);
    });

    it('restores everything at once, in order', () => {
        const segments = ref<Segment[]>([seg('b', 30, 40)]);
        const { removed, record, restoreAll } = useTrimDeletions(segments);
        record(seg('c', 50, 60));
        record(seg('a', 10, 20));
        restoreAll();
        expect(segments.value.map((s) => s.id)).toEqual(['a', 'b', 'c']);
        expect(removed.value).toHaveLength(0);
    });

    it('forgets removals once they have been consumed', () => {
        const segments = ref<Segment[]>([]);
        const { removed, record, clear } = useTrimDeletions(segments);
        record(seg('a', 10, 20));
        clear();
        expect(removed.value).toHaveLength(0);
    });

    it('stores a copy, so later edits to the original do not leak in', () => {
        const segments = ref<Segment[]>([]);
        const { removed, record } = useTrimDeletions(segments);
        const original = seg('a', 10, 20, 'Before');
        record(original);
        original.label = 'After';
        expect(removed.value[0].label).toBe('Before');
    });
});
