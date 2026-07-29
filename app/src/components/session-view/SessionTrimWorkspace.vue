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
        chaptersIsDirty: boolean;
        chaptersIsSaving: boolean;
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
        /** Post-encode `thumbnails.vtt` URL for timeline hover previews (trim mode). */
        thumbnailVttUrl?: string | null;
        /** Audio waveform peaks (normalized 0–1 amplitude). */
        waveformPeaks?: number[] | null;
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
    discardChapters: [];
    saveChapters: [];
    segmentRemoved: [segment: Segment];
}>();

const showToolbarSection = () => props.section !== 'timeline';

const trimSegmentEditorRef = ref<{ focus?: () => void } | null>(null);

const segmentEditorTimelineTitle = computed(() =>
    props.isCompleted ? 'Edit chapters' : 'Trim segments',
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
    if (props.canSaveChapters && !props.showTrimSegmentEditor) return true;
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

        <div
            v-if="canSaveChapters && !showTrimSegmentEditor"
            class="flex flex-wrap items-center gap-2"
        >
            <span
                v-if="chaptersIsDirty"
                class="chapter-unsaved-pill"
                title="Unsaved changes are stored locally; click Save to commit to S3."
            >Unsaved</span>
            <button
                v-if="chaptersIsDirty"
                type="button"
                class="chapter-toolbar-muted"
                :disabled="chaptersIsSaving"
                @click="emit('discardChapters')"
            >Discard</button>
            <button
                type="button"
                class="chapter-save-btn"
                :disabled="!chaptersIsDirty || chaptersIsSaving"
                @click="emit('saveChapters')"
            >{{ chaptersIsSaving ? 'Saving…' : 'Save chapters' }}</button>
        </div>


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
        class="se-timeline-wrap w-full"
    >
        <SegmentEditor
            ref="trimSegmentEditorRef"
            v-model="editorSegments"
            mode="trim"
            :show-labels="true"
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
            <template v-if="canSaveChapters" #toolbar-before-clear>
                <span
                    v-if="chaptersIsDirty"
                    class="chapter-unsaved-pill"
                    title="Unsaved changes are stored locally; click Save to commit to S3."
                >Unsaved</span>
                <button
                    v-if="chaptersIsDirty"
                    type="button"
                    class="chapter-toolbar-muted"
                    :disabled="chaptersIsSaving"
                    @click="emit('discardChapters')"
                >Discard</button>
                <button
                    type="button"
                    class="chapter-save-btn"
                    :disabled="!chaptersIsDirty || chaptersIsSaving"
                    @click="emit('saveChapters')"
                >{{ chaptersIsSaving ? 'Saving…' : 'Save chapters' }}</button>
            </template>
        </SegmentEditor>
    </div>
</div>
</template>

<style scoped>
.se-timeline-wrap {
    /* Override the general .se-timeline-wrap rule that adds margin-bottom — we want
       the editor card to bleed flush to the column's bottom edge. */
    margin-bottom: 0;
}

.se-timeline-wrap :deep(.se-root) {
    border-radius: 0;
}
</style>
