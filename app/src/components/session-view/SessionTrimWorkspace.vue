<script setup lang="ts">
import { computed } from 'vue';
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
        /** True when the session is completed/imported — changes the placeholder copy while player duration loads. */
        canEditWithTimeline?: boolean;
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
        /** `toolbar` = hints + chapter actions in the workflow card. `timeline` = full trim editor (below the player row). */
        section?: 'toolbar' | 'timeline';
        /** Post-encode `thumbnails.vtt` URL for timeline hover previews (trim mode). */
        thumbnailVttUrl?: string | null;
    }>(),
    { section: undefined },
);

const editorSegments = defineModel<Segment[]>('editorSegments', { required: true });
const selectedAudioTrack = defineModel<number>('selectedAudioTrack', { required: true });
const selectedQualityId = defineModel<string | null>('selectedQualityId', { required: true });

const emit = defineEmits<{
    discardChapters: [];
    saveChapters: [];
}>();

const showToolbarSection = () => props.section !== 'timeline';

/** Avoid an empty mt-5 wrapper (looked like stray margin / empty card in the session panel). */
const trimToolbarHasVisibleContent = computed(() => {
    if (props.section === 'timeline') return false;
    if (props.showChaptersSidePanel && props.chaptersSaveError) return true;
    if (props.showChaptersSidePanel && !props.showTrimSegmentEditor) return true;
    return !(props.showTrimSegmentEditor || props.showChaptersSidePanel);
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
            class="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400"
        >
            <template v-if="canEditWithTimeline">
                Loading player — the timeline will appear once playback is ready.
            </template>
            <template v-else>
                Trim ranges appear once the source is probed. Chapters are edited beside the player when preview is available.
            </template>
        </p>
    </div>

    <!-- Timeline: breakout width, below player + chapters row -->
    <div
        v-if="section === 'timeline' && showTrimSegmentEditor"
        class="relative left-1/2 w-screen max-w-[92vw] -translate-x-1/2"
    >
        <SegmentEditor
            v-model="editorSegments"
            mode="trim"
            :duration="probeDuration"
            :get-current-time="getCurrentTime"
            :on-seek="onSeek"
            :on-play-pause="onPlayPause"
            :is-playing="isPreviewPlaying"
            :show-list="false"
            keyboard-scope="global"
            :fps="segmentEditorProbeFps"
            :thumbnail-vtt-url="thumbnailVttUrl"
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
            <template v-if="showAudioSelect" #playback-start>
                <label class="playback-slot-label">Audio:</label>
                <FormSelect
                    variant="playback"
                    presentation="custom"
                    numeric
                    v-model="selectedAudioTrack"
                    :options="previewAudioSelectOptions"
                />
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
