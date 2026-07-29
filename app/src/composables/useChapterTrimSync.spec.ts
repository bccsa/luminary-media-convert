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

function setup(opts: { mirror?: boolean } = {}) {
    const editorSegments = ref<Segment[]>([]);
    const chapterSegments = ref<Segment[]>([]);
    const mirror = ref(opts.mirror ?? true);
    const chaptersLoaded = ref(true);

    const sync = useChapterTrimSync({
        editorSegments,
        chapterSegments,
        mirrorActive: computed(() => mirror.value),
        chaptersLoaded: computed(() => chaptersLoaded.value),
    });

    return { editorSegments, chapterSegments, mirror, chaptersLoaded, sync };
}

describe('useChapterTrimSync — before the encode is submitted', () => {
    it('does not let trim markers seed the chapter list', async () => {
        const { editorSegments, chapterSegments } = setup({ mirror: false });
        editorSegments.value = [seg('a', 10, 20), seg('b', 40, 50)];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(0);
    });

    it('does not let a loaded chapter sidecar overwrite trim markers', async () => {
        const { editorSegments, chapterSegments } = setup({ mirror: false });
        editorSegments.value = [seg('a', 10, 20)];
        await nextTick();
        chapterSegments.value = [seg('c', 0, 5, 'Existing chapter')];
        await nextTick();
        expect(editorSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([[10, 20]]);
    });

    it('does not clear chapters when trim markers are dropped at submit', async () => {
        const { editorSegments, chapterSegments } = setup({ mirror: false });
        chapterSegments.value = [seg('c', 0, 5, 'Keep me')];
        editorSegments.value = [seg('a', 10, 20)];
        await nextTick();
        editorSegments.value = [];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(1);
        expect(chapterSegments.value[0].label).toBe('Keep me');
    });
});

describe('useChapterTrimSync — once the timeline is the chapter editor', () => {
    it('propagates timeline edits into the chapter list', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 0, 10), seg('b', 10, 20)];
        await nextTick();
        expect(chapterSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([
            [0, 10],
            [10, 20],
        ]);
    });

    it('preserves chapter labels by row when boundaries move', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 0, 10), seg('b', 10, 20)];
        await nextTick();
        chapterSegments.value = [seg('a', 0, 10, 'Intro'), seg('b', 10, 20, 'Outro')];
        await nextTick();
        editorSegments.value = [seg('a', 0, 12), seg('b', 12, 20)];
        await nextTick();
        expect(chapterSegments.value.map((s) => s.label)).toEqual(['Intro', 'Outro']);
    });

    it('renders chapters onto the timeline', async () => {
        const { editorSegments, chapterSegments } = setup();
        chapterSegments.value = [seg('c', 5, 15, 'Chapter 1')];
        await nextTick();
        expect(editorSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([[5, 15]]);
    });

    it('clears chapters when every segment is deleted from the timeline', async () => {
        const { editorSegments, chapterSegments } = setup();
        editorSegments.value = [seg('a', 0, 10)];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(1);
        editorSegments.value = [];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(0);
    });

    it('adopts the chapter list when mirroring turns on', async () => {
        const { editorSegments, chapterSegments, mirror } = setup({ mirror: false });
        chapterSegments.value = [seg('c', 3, 9, 'From S3')];
        editorSegments.value = [seg('trim', 40, 60)];
        await nextTick();

        mirror.value = true;
        await nextTick();

        expect(editorSegments.value.map((s) => [s.inSec, s.outSec])).toEqual([[3, 9]]);
    });
});

describe('useChapterTrimSync — guards', () => {
    it('does nothing while the chapter sidecar has not loaded', async () => {
        const editorSegments = ref<Segment[]>([]);
        const chapterSegments = ref<Segment[]>([]);
        useChapterTrimSync({
            editorSegments,
            chapterSegments,
            mirrorActive: computed(() => true),
            chaptersLoaded: computed(() => false),
        });
        editorSegments.value = [seg('a', 0, 10)];
        await nextTick();
        expect(chapterSegments.value).toHaveLength(0);
    });
});
