<script setup lang="ts">
import { computed, ref } from 'vue';
import { SegmentEditor } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import FormSelect from '../FormSelect.vue';

const props = withDefaults(
    defineProps<{
        showChaptersSidePanel: boolean;
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
        showAudioSelect: boolean;
        previewAudioSelectOptions: { value: number; label: string }[];
        showQualitySelect: boolean;
        previewQualitySelectOptions: { value: string; label: string }[];
        /** Completed multi-angle HLS: angle dropdown in timeline toolbar (before audio). */
        showAngleSelect?: boolean;
        angleIndex?: number;
        previewAngleSelectOptions?: { value: number; label: string }[];
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
        showAngleSelect: false,
        angleIndex: 0,
        previewAngleSelectOptions: () => [],
        addGapAboveTimeline: false,
        isCompleted: false,
    },
);

const editorSegments = defineModel<Segment[]>('editorSegments', { required: true });
const selectedAudioTrack = defineModel<number>('selectedAudioTrack', { required: true });
const selectedQualityId = defineModel<string | null>('selectedQualityId', { required: true });

const emit = defineEmits<{
    discardChapters: [];
    saveChapters: [];
    angleChange: [index: number];
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
    if (props.showChaptersSidePanel && props.chaptersSaveError) return true;
    if (props.showChaptersSidePanel && !props.showTrimSegmentEditor) return true;
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
            v-if="showChaptersSidePanel && chaptersSaveError"
            class="text-xs text-red-600 dark:text-red-400"
        >{{ chaptersSaveError }}</p>

        <div
            v-if="showChaptersSidePanel && !showTrimSegmentEditor"
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
        class="relative left-1/2 w-screen max-w-[min(100vw-0.5rem,96rem)] -translate-x-1/2"
        :class="addGapAboveTimeline ? 'mt-2 sm:mt-3' : ''"
    >
        <SegmentEditor
            ref="trimSegmentEditorRef"
            v-model="editorSegments"
            mode="trim"
            :show-labels="true"
            :title="segmentEditorTimelineTitle"
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
        >
            <template v-if="showChaptersSidePanel" #toolbar-before-clear>
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
            <template
                v-if="showAngleSelect || showAudioSelect"
                #playback-start
            >
                <span
                    v-if="showAngleSelect && previewAngleSelectOptions.length > 0"
                    class="inline-flex shrink-0 items-center gap-1.5"
                >
                    <label class="playback-slot-label">Angle:</label>
                    <FormSelect
                        variant="playback"
                        presentation="custom"
                        numeric
                        wrapper-class="min-w-[8.5rem] max-w-[min(100%,18rem)]"
                        :model-value="angleIndex"
                        :options="previewAngleSelectOptions"
                        aria-label="Camera angle"
                        @update:model-value="emit('angleChange', Number($event))"
                    />
                </span>
                <span
                    v-if="showAudioSelect"
                    class="inline-flex shrink-0 items-center gap-1.5"
                    :class="showAngleSelect && previewAngleSelectOptions.length > 0 ? 'ml-3 sm:ml-4' : ''"
                >
                    <label class="playback-slot-label">Audio:</label>
                    <FormSelect
                        variant="playback"
                        presentation="custom"
                        numeric
                        v-model="selectedAudioTrack"
                        :options="previewAudioSelectOptions"
                    />
                </span>
            </template>
            <template v-if="showQualitySelect" #playback-end>
                <label class="playback-slot-label">Quality:</label>
                <FormSelect
                    variant="playback"
                    presentation="custom"
                    :model-value="selectedQualityId ?? ''"
                    :options="previewQualitySelectOptions"
                    @update:model-value="selectedQualityId = $event === '' ? null : String($event)"
                />
            </template>
        </SegmentEditor>
    </div>
</div>
</template>
