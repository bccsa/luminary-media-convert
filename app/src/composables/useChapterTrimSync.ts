import { ref, watch, type Ref } from 'vue';
import type { Segment } from '@luminary-media-converter/segment-editor';

interface ChapterTrimSyncDeps {
    /** Trim timeline ranges authored by the user. */
    editorSegments: Ref<Segment[]>;
    /** Chapter list (from useChapters), mirrored from the trim timeline while editing. */
    chapterSegments: Ref<Segment[]>;
    /** True when the trim timeline is currently editable. */
    canEditTrimTimeline: Readonly<Ref<boolean>>;
    /** True when the chapter sidecar has been loaded for the current session. */
    chaptersLoaded: Readonly<Ref<boolean>>;
}

function segmentTimesAlmostEqual(a: Segment, b: Segment): boolean {
    return (
        Math.abs(a.inSec - b.inSec) < 1e-4 &&
        Math.abs(a.outSec - b.outSec) < 1e-4
    );
}

function sameTrimAsChapterBoundaries(trim: Segment[], ch: Segment[]): boolean {
    if (trim.length !== ch.length) return false;
    return trim.every((t, i) => segmentTimesAlmostEqual(t, ch[i]!));
}

/** True when trim timeline and chapter list already match (times + labels, same order). */
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
 * Keeps the trim timeline and the chapter list mirrored while the trim
 * timeline is editable. Trim boundary changes propagate into the chapter list
 * (labels preserved by row index); chapter edits propagate back into the trim
 * timeline. Returns `syncChaptersFromTrim` so callers can re-trigger the sync
 * after discarding a chapter draft.
 */
export function useChapterTrimSync(deps: ChapterTrimSyncDeps) {
    const { editorSegments, chapterSegments, canEditTrimTimeline, chaptersLoaded } =
        deps;

    const hadTrimForChapterSync = ref(false);

    function syncEditorFromChaptersIfNeeded() {
        if (!canEditTrimTimeline.value || !chaptersLoaded.value) return;
        if (editorMatchesChapters(editorSegments.value, chapterSegments.value))
            return;
        editorSegments.value = chapterSegments.value.map((s) => ({ ...s }));
    }

    function syncChaptersFromTrim() {
        if (!canEditTrimTimeline.value || !chaptersLoaded.value) return;

        const trim = editorSegments.value;
        if (trim.length === 0) {
            if (hadTrimForChapterSync.value) {
                chapterSegments.value = [];
                hadTrimForChapterSync.value = false;
            }
            return;
        }

        hadTrimForChapterSync.value = true;
        const prev = chapterSegments.value;
        const next: Segment[] = trim.map((t, i) => ({
            ...t,
            label: i < prev.length ? (prev[i]!.label ?? '') : '',
        }));

        if (
            sameTrimAsChapterBoundaries(trim, prev) &&
            next.every((s, i) => (s.label ?? '') === (prev[i]?.label ?? ''))
        ) {
            return;
        }

        chapterSegments.value = next;
    }

    watch(editorSegments, () => syncChaptersFromTrim(), { deep: true });

    watch(chaptersLoaded, (loaded) => {
        if (loaded) {
            syncChaptersFromTrim();
            syncEditorFromChaptersIfNeeded();
        }
    });

    watch(chapterSegments, () => syncEditorFromChaptersIfNeeded(), { deep: true });

    watch(canEditTrimTimeline, (can) => {
        if (!can) hadTrimForChapterSync.value = false;
        else syncEditorFromChaptersIfNeeded();
    });

    return { syncChaptersFromTrim };
}
