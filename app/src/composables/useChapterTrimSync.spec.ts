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

describe('useChapterTrimSync — when the sidecar loads after the encode', () => {
    /**
     * The sidecar is fetched over the network, so it can easily arrive after
     * the encode has been submitted and mirroring has gone live. At that moment
     * the timeline still holds the trim ranges the encode was started with.
     */
    function setupLateLoad() {
        const editorSegments = ref<Segment[]>([]);
        const chapterSegments = ref<Segment[]>([]);
        const chaptersLoaded = ref(false);

        useChapterTrimSync({
            editorSegments,
            chapterSegments,
            mirrorActive: computed(() => true),
            chaptersLoaded: computed(() => chaptersLoaded.value),
        });

        return { editorSegments, chapterSegments, chaptersLoaded };
    }

    it('keeps chapters that came from the sidecar', async () => {
        const { editorSegments, chapterSegments, chaptersLoaded } = setupLateLoad();

        // Trim ranges the encode was started with.
        editorSegments.value = [seg('t1', 0, 30), seg('t2', 60, 90)];
        await nextTick();

        // The sidecar arrives: three real chapters the user wrote earlier.
        chapterSegments.value = [
            seg('c1', 0, 10, 'Intro'),
            seg('c2', 10, 20, 'Middle'),
            seg('c3', 20, 30, 'Outro'),
        ];
        chaptersLoaded.value = true;
        await nextTick();

        expect(chapterSegments.value.map((s) => s.label)).toEqual([
            'Intro',
            'Middle',
            'Outro',
        ]);
    });

    it('does not truncate chapters to the number of trim ranges', async () => {
        const { editorSegments, chapterSegments, chaptersLoaded } = setupLateLoad();

        editorSegments.value = [seg('t1', 0, 30)];
        await nextTick();

        chapterSegments.value = [
            seg('c1', 0, 10, 'Intro'),
            seg('c2', 10, 20, 'Middle'),
        ];
        chaptersLoaded.value = true;
        await nextTick();

        expect(chapterSegments.value).toHaveLength(2);
    });

    it('shows the loaded chapters on the timeline', async () => {
        const { editorSegments, chapterSegments, chaptersLoaded } = setupLateLoad();

        editorSegments.value = [seg('t1', 0, 30), seg('t2', 60, 90)];
        await nextTick();

        chapterSegments.value = [seg('c1', 0, 10, 'Intro')];
        chaptersLoaded.value = true;
        await nextTick();

        expect(editorSegments.value.map((s) => s.label)).toEqual(['Intro']);
    });

    it('still seeds chapters from the timeline when the sidecar was empty', async () => {
        // Nothing to lose here, and the trim ranges are a sensible starting
        // point for chapters over the trimmed programme.
        const { editorSegments, chapterSegments, chaptersLoaded } = setupLateLoad();

        editorSegments.value = [seg('t1', 0, 30), seg('t2', 60, 90)];
        await nextTick();

        chaptersLoaded.value = true;
        await nextTick();

        expect(chapterSegments.value).toHaveLength(2);
    });
});

describe('useChapterTrimSync — selecting a range is not deleting it', () => {
    /**
     * Pressing Start Encode is the moment mirroring goes live, and at that
     * moment the timeline holds the ranges the user just selected. Adopting an
     * empty chapter list there erased that selection in front of them.
     */
    it('keeps the timeline when mirroring turns on with no chapters', async () => {
        const { editorSegments, mirror } = setup({ mirror: false });
        editorSegments.value = [seg('t1', 0, 30), seg('t2', 40, 60)];
        await nextTick();

        mirror.value = true;
        await nextTick();

        expect(editorSegments.value).toHaveLength(2);
    });

    it('seeds the chapter list from those ranges instead', async () => {
        const { editorSegments, chapterSegments, mirror } = setup({ mirror: false });
        editorSegments.value = [seg('t1', 0, 30), seg('t2', 40, 60)];
        await nextTick();

        mirror.value = true;
        await nextTick();

        // A reasonable first draft of the chapters, rather than nothing.
        expect(chapterSegments.value).toHaveLength(2);
    });

    it('still lets existing chapters win over the timeline', async () => {
        const { editorSegments, chapterSegments, mirror } = setup({ mirror: false });
        editorSegments.value = [seg('t1', 0, 30), seg('t2', 40, 60)];
        chapterSegments.value = [seg('c1', 0, 10, 'Intro')];
        await nextTick();

        mirror.value = true;
        await nextTick();

        expect(editorSegments.value.map((s) => s.label)).toEqual(['Intro']);
    });

    it('still clears chapters when the user empties the timeline', async () => {
        // The guard is only about entering chapter mode; deleting every segment
        // while editing must still propagate.
        const { editorSegments, chapterSegments } = setup({ mirror: true });
        editorSegments.value = [seg('a', 0, 10), seg('b', 10, 20)];
        await nextTick();

        editorSegments.value = [];
        await nextTick();

        expect(chapterSegments.value).toHaveLength(0);
    });
});
