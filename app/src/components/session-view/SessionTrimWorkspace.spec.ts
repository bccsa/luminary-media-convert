// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import SessionTrimWorkspace from './SessionTrimWorkspace.vue';

/**
 * The bottom timeline is trim before the encode and chapters after it. The two
 * differ in more than a title, so the props it hands the editor have to follow
 * the phase — which they did not, and chapter editing quietly inherited the trim
 * rules.
 */
function mountTimeline(isCompleted: boolean) {
    return shallowMount(SessionTrimWorkspace, {
        props: {
            section: 'timeline',
            showTrimSegmentEditor: true,
            isCompleted,
            editorSegments: [],
            showChaptersSidePanel: false,
            chaptersIsDirty: false,
            chaptersIsSaving: false,
            chaptersSaveError: null,
            probeDuration: 120,
            getCurrentTime: () => 0,
            onSeek: () => {},
            onPlayPause: () => {},
            isPreviewPlaying: false,
            segmentEditorProbeFps: 25,
        },
    });
}

const editorProps = (isCompleted: boolean) =>
    mountTimeline(isCompleted).findComponent({ name: 'SegmentEditor' }).props();

describe('SessionTrimWorkspace timeline', () => {
    it('edits trim ranges before the encode', () => {
        expect(editorProps(false).mode).toBe('trim');
    });

    it('edits chapters once the encode has produced output', () => {
        // Left in trim mode, chapters could not be multi-selected, lost their
        // hover delete, and shift-drag marked a new range instead of selecting
        // across several.
        expect(editorProps(true).mode).toBe('chapters');
    });

    it('keeps trimming to a single range', () => {
        expect(editorProps(false).maxSegments).toBe(1);
    });

    it('does not cap the number of chapters', () => {
        // The trim cap replaces the oldest range when a new one is marked. Applied
        // to chapters that silently destroyed the previous chapter.
        expect(editorProps(true).maxSegments).toBeUndefined();
    });

    it('leaves labelling to the editor rather than forcing it on', () => {
        // Trim ranges carry no name worth showing over the frames: the bright
        // stretch already says which part is kept, and the times live in the
        // Cuts panel. Chapters do have names, and the editor shows them by
        // default — so not passing the prop gives the right answer in both.
        expect(editorProps(false).showLabels).toBeUndefined();
        expect(editorProps(true).showLabels).toBeUndefined();
    });
});
