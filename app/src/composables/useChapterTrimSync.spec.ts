import { describe, expect, it } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { useChapterTrimSync } from './useChapterTrimSync';
import type { Segment } from '@luminary-media-converter/segment-editor';

const seg = (id: string, inSec: number, outSec: number, label = ''): Segment => ({
    id,
    inSec,
    outSec,
    label,
});

function setup(opts: { seeds?: boolean } = {}) {
    const editorSegments = ref<Segment[]>([]);
    const chapterSegments = ref<Segment[]>([]);
    const canEditTrimTimeline = ref(true);
    const trimSeeds = ref(opts.seeds ?? true);
    const chaptersLoaded = ref(true);

    const sync = useChapterTrimSync({
        editorSegments,
        chapterSegments,
        canEditTrimTimeline: computed(() => canEditTrimTimeline.value),
        trimSeedsChapters: computed(() => trimSeeds.value),
        chaptersLoaded: computed(() => chaptersLoaded.value),
    });

    return { editorSegments, chapterSegments, canEditTrimTimeline, trimSeeds, sync };
}

describe('useChapterTrimSync', () => {
    it('seeds the chapter list from trim ranges while they are live', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 10, 20), seg('b', 40, 50)];
        await nextTick();
        expect(chapterSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([
            [10, 20],
            [40, 50],
        ]);
    });

    it('preserves chapter labels by row when trim boundaries move', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 10, 20), seg('b', 40, 50)];
        await nextTick();
        chapterSegments.value = [
            seg('a', 10, 20, 'Intro'),
            seg('b', 40, 50, 'Outro'),
        ];
        await nextTick();
        editorSegments.value = [seg('a', 12, 20), seg('b', 40, 50)];
        await nextTick();
        expect(chapterSegments.value.map((s) => s.label)).toEqual(['Intro', 'Outro']);
    });

    it('clears chapters when the trim list empties and trim still seeds them', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 10, 20)];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(1);
        editorSegments.value = [];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(0);
    });

    it('keeps chapters when trim markers are dropped after submit', async () => {
        // Regression: the encode submit empties the trim list, and the sync used to
        // read that as "chapters deleted", taking authored chapters down with it.
        const { editorSegments, chapterSegments, trimSeeds } = setup();
        editorSegments.value = [seg('a', 10, 20)];
        await nextTick();
        chapterSegments.value = [seg('a', 10, 20, 'Keep me')];
        await nextTick();

        trimSeeds.value = false;
        editorSegments.value = [];
        await nextTick();

        expect(chapterSegments.value).toHaveLength(1);
        expect(chapterSegments.value[0].label).toBe('Keep me');
    });

    it('still renders chapters onto the timeline once trim stops seeding', async () => {
        // Post-encode the timeline shows chapters, so this direction must keep working.
        const { editorSegments, chapterSegments, trimSeeds } = setup({ seeds: false });
        chapterSegments.value = [seg('c', 5, 15, 'Chapter 1')];
        await nextTick();
        expect(trimSeeds.value).toBe(false);
        expect(editorSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([[5, 15]]);
    });

    it('does nothing while the chapter sidecar has not loaded', async () => {
        const editorSegments = ref<Segment[]>([]);
        const chapterSegments = ref<Segment[]>([]);
        useChapterTrimSync({
            editorSegments,
            chapterSegments,
            canEditTrimTimeline: computed(() => true),
            chaptersLoaded: computed(() => false),
        });
        editorSegments.value = [seg('a', 10, 20)];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(0);
    });
});
