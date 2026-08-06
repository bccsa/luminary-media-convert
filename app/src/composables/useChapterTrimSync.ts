import { ref, watch, type Ref } from 'vue';
import type { Segment } from '@luminary-media-converter/segment-editor';

interface ChapterTrimSyncDeps {
    /** Segments shown on the bottom timeline. */
    editorSegments: Ref<Segment[]>;
    /** Chapter list (from useChapters), edited beside the player. */
    chapterSegments: Ref<Segment[]>;
    /**
     * True once the timeline represents chapters rather than trim markers — that
     * is, after the encode has been submitted. Mirroring is off before then:
     * trimming picks which parts of the source to keep and says nothing about how
     * the result should be divided into chapters, so the two lists must not touch
     * each other while trim markers are live.
     */
    mirrorActive: Readonly<Ref<boolean>>;
    /** True when the chapter sidecar has been loaded for the current session. */
    chaptersLoaded: Readonly<Ref<boolean>>;
}

function segmentTimesAlmostEqual(a: Segment, b: Segment): boolean {
    return (
        Math.abs(a.inSec - b.inSec) < 1e-4 &&
        Math.abs(a.outSec - b.outSec) < 1e-4
    );
}

function sameBoundaries(a: Segment[], b: Segment[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((s, i) => segmentTimesAlmostEqual(s, b[i]!));
}

/** True when timeline and chapter list already match (times + labels, same order). */
function editorMatchesChapters(ed: Segment[], ch: Segment[]): boolean {
    if (ed.length !== ch.length) return false;
    return ed.every((s, i) => {
        const c = ch[i]!;
        return (
            segmentTimesAlmostEqual(s, c) &&
            (s.label ?? '') === (c.label ?? '')
        );
    });
}

/**
 * Keeps the bottom timeline and the chapter list mirrored once the timeline is a
 * chapter editor — after the encode has been submitted. Timeline edits propagate
 * into the chapter list (labels preserved by row index) and chapter edits
 * propagate back onto the timeline.
 *
 * Nothing is mirrored while `mirrorActive` is false. Before the encode the
 * timeline holds trim markers: ephemeral ranges describing what to encode. They
 * must never seed chapters, and loading a chapter sidecar must never overwrite
 * them.
 *
 * Returns `syncChaptersFromTimeline` so callers can re-trigger the sync after
 * discarding a chapter draft.
 */
export function useChapterTrimSync(deps: ChapterTrimSyncDeps) {
    const { editorSegments, chapterSegments, mirrorActive, chaptersLoaded } =
        deps;

    /** Guards against reading a timeline emptied for other reasons as a deletion. */
    const timelineHadSegments = ref(false);

    function syncEditorFromChapters() {
        if (!mirrorActive.value || !chaptersLoaded.value) return;
        if (editorMatchesChapters(editorSegments.value, chapterSegments.value))
            return;
        editorSegments.value = chapterSegments.value.map((s) => ({ ...s }));
    }

    function syncChaptersFromTimeline() {
        if (!mirrorActive.value || !chaptersLoaded.value) return;

        const timeline = editorSegments.value;
        if (timeline.length === 0) {
            if (timelineHadSegments.value) {
                chapterSegments.value = [];
                timelineHadSegments.value = false;
            }
            return;
        }

        timelineHadSegments.value = true;
        const prev = chapterSegments.value;
        const next: Segment[] = timeline.map((t, i) => ({
            ...t,
            label: i < prev.length ? (prev[i]!.label ?? '') : '',
        }));

        if (
            sameBoundaries(timeline, prev) &&
            next.every((s, i) => (s.label ?? '') === (prev[i]?.label ?? ''))
        ) {
            return;
        }

        chapterSegments.value = next;
    }

    watch(editorSegments, () => syncChaptersFromTimeline(), { deep: true });

    watch(chaptersLoaded, (loaded) => {
        if (loaded) {
            syncChaptersFromTimeline();
            syncEditorFromChapters();
        }
    });

    watch(chapterSegments, () => syncEditorFromChapters(), { deep: true });

    watch(mirrorActive, (active) => {
        if (!active) {
            timelineHadSegments.value = false;
            return;
        }

        // Entering chapter editing. Where chapters already exist they are the
        // source of truth and the timeline adopts them.
        //
        // Where there are none, the timeline seeds them instead of being
        // emptied by them. This is the moment an encode is submitted, so the
        // timeline is holding the ranges the user just selected — adopting an
        // empty chapter list here erased that selection in front of them, and
        // those ranges are a reasonable first draft of the chapters anyway.
        if (chapterSegments.value.length > 0) syncEditorFromChapters();
        else syncChaptersFromTimeline();
    });

    return { syncChaptersFromTimeline };
}
