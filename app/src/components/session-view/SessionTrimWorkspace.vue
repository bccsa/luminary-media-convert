<script setup lang="ts">
import { computed, ref } from 'vue';
import { SegmentEditor } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';

const props = withDefaults(
    defineProps<{
        showChaptersSidePanel: boolean;
        /**
         * Chapters can be written to S3. False while the timeline still holds
         * pre-encode trim markers — those are ephemeral and must not be savable.
         */
        canSaveChapters?: boolean;
        chaptersSaveError: string | null;
        showTrimSegmentEditor: boolean;
        /** Trim timeline is available (pre-encode configure phase). */
        canEditTrimTimeline?: boolean;
        /** Chapters beside player whenever playback is available (pre-encode, encoding, or completed). */
        canEditChaptersPlayback?: boolean;
        probeDuration: number;
        getCurrentTime: () => number;
        onSeek: (t: number) => void;
        onPlayPause: () => void;
        isPreviewPlaying: boolean;
        segmentEditorProbeFps: number;
        /** `toolbar` = hints + chapter actions in the workflow card. `timeline` = full trim editor (below the player row). */
        section?: 'toolbar' | 'timeline';
        /**
         * `thumbnails.vtt` URL for the timeline filmstrip and hover previews —
         * sampled from the source before the encode, read from S3 after it.
         */
        thumbnailVttUrl?: string | null;
        /** Audio waveform peaks (normalized 0–1 amplitude). */
        waveformPeaks?: number[] | null;
        /**
         * The source storyboard is still being sampled, so the filmstrip covers
         * only part of the timeline and more frames are on the way.
         */
        storyboardPending?: boolean;
        /** After encode completes — timeline title is for chapter editing, not pre-encode trim. */
        isCompleted?: boolean;
        /**
         * When the session shell uses zero flex gap (collapsed detail card), add space
         * between the player row and this timeline so it matches the spaced stack after encode.
         */
        addGapAboveTimeline?: boolean;
    }>(),
    {
        section: undefined,
        addGapAboveTimeline: false,
        isCompleted: false,
        canSaveChapters: false,
    },
);

const editorSegments = defineModel<Segment[]>('editorSegments', { required: true });

const emit = defineEmits<{
    segmentRemoved: [segment: Segment];
}>();

const showToolbarSection = () => props.section !== 'timeline';

const trimSegmentEditorRef = ref<{ focus?: () => void } | null>(null);

const segmentEditorTimelineTitle = computed(() =>
    props.isCompleted ? 'Edit chapters' : 'Trim segments',
);

/**
 * The same strip is trim before the encode and chapters after it, so the mode has
 * to follow the phase. Left hardcoded to `trim`, chapter editing inherited every
 * trim rule: one selection at a time, no hover delete, and shift-drag marking a
 * range instead of selecting across one.
 */
const timelineMode = computed(() => (props.isCompleted ? 'chapters' : 'trim'));

/**
 * Trimming keeps a single range; chapters are a list and must not be capped —
 * with the trim cap applied, marking a second chapter silently replaced the first.
 */
const timelineMaxSegments = computed(() =>
    props.isCompleted ? undefined : 1,
);

defineExpose({
    focusSegmentEditor: () => {
        trimSegmentEditorRef.value?.focus?.();
    },
});

/** Avoid an empty mt-5 wrapper (looked like stray margin / empty card in the session panel). */
const trimToolbarHasVisibleContent = computed(() => {
    if (props.section === 'timeline') return false;
    if (props.canSaveChapters && props.chaptersSaveError) return true;
    if (props.canEditTrimTimeline && !props.showTrimSegmentEditor) return true;
    if (props.canEditChaptersPlayback && !props.showTrimSegmentEditor && !props.showChaptersSidePanel) return true;
    return false;
});
</script>

<template>
<div>
    <!-- Toolbar: chapter actions + empty state only (trim UI lives in `section="timeline"`) -->
    <div v-if="showToolbarSection() && trimToolbarHasVisibleContent" class="mt-5 space-y-5">
        <p
            v-if="canSaveChapters && chaptersSaveError"
            class="text-xs text-red-600 dark:text-red-400"
        >{{ chaptersSaveError }}</p>

        <!--
            Saving moved into the chapter list's own header — it belongs with
            the list it saves rather than in a toolbar further down the page.
        -->

        <p
            v-if="showToolbarSection() && !(showTrimSegmentEditor || showChaptersSidePanel)"
            class="text-sm leading-relaxed text-slate-500 dark:text-slate-400"
        >
            <template v-if="canEditTrimTimeline">
                Loading player — the trim timeline will appear once playback is ready.
            </template>
            <template v-else-if="canEditChaptersPlayback">
                Chapter titles are edited in the column beside the player (trim cuts use the timeline below when available).
            </template>
        </p>
    </div>

    <!-- Timeline: full-width bottom strip for precise trim editing -->
    <div
        v-if="section === 'timeline' && showTrimSegmentEditor"
        class="se-timeline-wrap w-full pl-3 pr-4"
    >
        <SegmentEditor
            ref="trimSegmentEditorRef"
            v-model="editorSegments"
            :mode="timelineMode"
            :max-segments="timelineMaxSegments"
            :title="segmentEditorTimelineTitle"
            :show-header="false"
            :duration="probeDuration"
            :get-current-time="getCurrentTime"
            :on-seek="onSeek"
            :on-play-pause="onPlayPause"
            :is-playing="isPreviewPlaying"
            :show-list="false"
            keyboard-scope="global"
            :fps="segmentEditorProbeFps"
            :thumbnail-vtt-url="thumbnailVttUrl"
            :waveform-peaks="waveformPeaks"
            combined-controls
            @segment-removed="emit('segmentRemoved', $event)"
        >
            <template #toolbar-before-clear>
                <!--
                    Without this a half-drawn filmstrip looks like a failure. It
                    takes minutes to sample a long source, and the frames arrive
                    left to right as they are made.
                -->
                <span
                    v-if="storyboardPending"
                    class="storyboard-pending-pill"
                    title="Frames are sampled from the source after upload; the timeline fills in as they arrive."
                >Generating thumbnails…</span>
            </template>
        </SegmentEditor>
    </div>
</div>
</template>

<style scoped>
.storyboard-pending-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 9999px;
    border: 1px solid rgb(226 232 240);
    background: rgb(248 250 252);
    padding: 0.125rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: rgb(100 116 139);
}

:global(html.dark) .storyboard-pending-pill {
    border-color: rgb(51 65 85);
    background: rgb(30 41 59 / 0.6);
    color: rgb(148 163 184);
}

.se-timeline-wrap {
    /* Override the general .se-timeline-wrap rule that adds margin-bottom — we want
       the editor card to bleed flush to the column's bottom edge. */
    margin-bottom: 0;
}

.se-timeline-wrap :deep(.se-root) {
    /* Square while this bled edge to edge. Now that it is inset to line up with
       the player and the side card, it reads as one of them — so it is rounded
       like them (matching their `rounded-xl`). */
    border-radius: 0.75rem;
}
</style>
