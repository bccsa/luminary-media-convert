// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import SessionTrimWorkspace from './SessionTrimWorkspace.vue';

/**
 * The bottom timeline is trim before the encode and chapters once it is submitted. The two
 * differ in more than a title, so the props it hands the editor have to follow
 * the phase — which they did not, and chapter editing quietly inherited the trim
 * rules.
 */
function mountTimeline(editsChapters: boolean) {
    return shallowMount(SessionTrimWorkspace, {
        props: {
            section: 'timeline',
            showTrimSegmentEditor: true,
            editsChapters,
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

const editorProps = (editsChapters: boolean) =>
    mountTimeline(editsChapters)
        .findComponent({ name: 'SegmentEditor' })
        .props();

describe('SessionTrimWorkspace timeline', () => {
    it('edits trim ranges before the encode', () => {
        expect(editorProps(false).mode).toBe('trim');
    });

    it('edits chapters once the encode is submitted', () => {
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

describe('SessionTrimWorkspace regenerate thumbnails', () => {
    function mountToolbar(props: Record<string, unknown>) {
        return shallowMount(SessionTrimWorkspace, {
            props: {
                section: 'timeline',
                showTrimSegmentEditor: true,
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
                ...props,
            },
            global: {
                stubs: {
                    // Renders the toolbar slot the button lives in.
                    SegmentEditor: {
                        template:
                            '<div><slot name="toolbar-before-clear" /></div>',
                    },
                },
            },
        });
    }

    it('offers to make the thumbnails again while the source is here', async () => {
        const wrapper = mountToolbar({ canRegenerateThumbnails: true });

        await wrapper
            .find('[data-test="regenerateThumbnails"]')
            .trigger('click');

        expect(wrapper.emitted('regenerateThumbnails')).toHaveLength(1);
    });

    it('does not offer it while thumbnails are still being made', () => {
        const wrapper = mountToolbar({
            canRegenerateThumbnails: true,
            storyboardPending: true,
        });

        expect(
            wrapper.find('[data-test="regenerateThumbnails"]').exists()
        ).toBe(false);
        expect(wrapper.text()).toContain('Generating thumbnails');
    });

    it('does not offer it once the source is gone or an encode has started', () => {
        const wrapper = mountToolbar({ canRegenerateThumbnails: false });

        expect(
            wrapper.find('[data-test="regenerateThumbnails"]').exists()
        ).toBe(false);
    });

    it('says why the last attempt failed', () => {
        const wrapper = mountToolbar({
            canRegenerateThumbnails: true,
            regenerateThumbnailsError:
                'The source file for this session is no longer on disk',
        });

        expect(
            wrapper.find('[data-test="regenerateThumbnailsError"]').text()
        ).toContain('no longer on disk');
    });
});
