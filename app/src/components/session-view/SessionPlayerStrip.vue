<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { SegmentEditor } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import HlsPlayer from '../HlsPlayer.vue';
import type { AudioTrackInfo, QualityLevelInfo } from '../HlsPlayer.vue';

const props = defineProps<{
    activePlaybackUrl: string | null;
    isCompleted: boolean;
    thumbnailVttUrl: string | null | undefined;
    encodingType: 'video' | 'audio';
    isAudioOnly: boolean;
    encryptionKeyHex: string | undefined;
    pollerEncryptionKeyHex: string | undefined;
    showChaptersSidePanel: boolean;
    chaptersSidePanelDuration: number;
    isPreviewPlaying: boolean;
    segmentEditorProbeFps: number;
    chaptersSaveError: string | null;
    activeTab: string;
    showAngleSwitcher: boolean;
    uniqueAnglePlaylists: { name: string; key: string }[];
    currentAngleIndex: number;
}>();

const chapterSegments = defineModel<Segment[]>('chapterSegments', { required: true });

/** Match chapters column height to the player shell so the list never extends below the video (scroll inside list). */
const playerShellRef = ref<HTMLElement | null>(null);
const chaptersAsideMaxHeightPx = ref<number | null>(null);

watchEffect(
    (onCleanup) => {
        const el = playerShellRef.value;
        if (!el || !props.showChaptersSidePanel) {
            chaptersAsideMaxHeightPx.value = null;
            return;
        }
        const ro = new ResizeObserver(() => {
            const h = el.getBoundingClientRect().height;
            chaptersAsideMaxHeightPx.value = h > 0 ? Math.round(h * 100) / 100 : null;
        });
        ro.observe(el);
        const h = el.getBoundingClientRect().height;
        chaptersAsideMaxHeightPx.value = h > 0 ? Math.round(h * 100) / 100 : null;
        onCleanup(() => ro.disconnect());
    },
    { flush: 'post' },
);

const chaptersAsideStyle = computed(() => {
    if (!props.showChaptersSidePanel || chaptersAsideMaxHeightPx.value == null) return undefined;
    return { maxHeight: `${chaptersAsideMaxHeightPx.value}px` };
});

const emit = defineEmits<{
    qualityLevels: [levels: QualityLevelInfo[]];
    playingChange: [playing: boolean];
    durationChange: [d: number];
    audioTracks: [tracks: AudioTrackInfo[]];
    angleChange: [index: number];
}>();

const hlsPlayerRef = ref<InstanceType<typeof HlsPlayer> | null>(null);
const chapterSegmentEditorRef = ref<{ focus?: () => void } | null>(null);

defineExpose({
    playerRef: hlsPlayerRef,
});

/** Focus chapters keyboard root (without stealing from inputs): enables I/J/L/… on first click in the panel. */
function onChaptersAsidePointerDown(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el || el.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
    chapterSegmentEditorRef.value?.focus?.();
}

function onQualityLevels(levels: QualityLevelInfo[]) {
    emit('qualityLevels', levels);
}
function onPlayingChange(playing: boolean) {
    emit('playingChange', playing);
}
function onDurationChange(seconds: number | null) {
    if (seconds != null) emit('durationChange', seconds);
}
function onAudioTracks(tracks: AudioTrackInfo[]) {
    emit('audioTracks', tracks);
}
</script>

<template>
    <div>
        <div
            v-if="activePlaybackUrl"
            class="flex flex-col"
            :class="[
                activeTab === 'trim' ? 'gap-3' : 'gap-4',
                showChaptersSidePanel ? (activeTab === 'trim' ? 'lg:flex-row lg:items-stretch lg:gap-3' : 'lg:flex-row lg:items-start lg:gap-4') : '',
            ]"
        >
            <div
                :class="[
                    showChaptersSidePanel
                        ? 'min-w-0 flex-[5]'
                        : 'w-full',
                    !showChaptersSidePanel && activeTab === 'trim' ? 'flex justify-center' : '',
                ]"
            >
                <div
                    ref="playerShellRef"
                    :class="[
                        'overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5',
                        'w-full',
                        activeTab === 'trim' && !isAudioOnly ? 'session-trim-player-cap' : '',
                        !showChaptersSidePanel && activeTab === 'trim'
                            ? 'lg:max-w-[min(100%,60vw)]'
                            : '',
                    ]"
                >
                    <HlsPlayer
                        ref="hlsPlayerRef"
                        :playback-url="activePlaybackUrl"
                        :thumbnail-vtt-url="isCompleted ? thumbnailVttUrl : undefined"
                        :encoding-type="encodingType"
                        :is-audio-only="isAudioOnly"
                        :encryption-key-hex="isCompleted ? (encryptionKeyHex || pollerEncryptionKeyHex) : undefined"
                        :show-controls="false"
                        preserve-state-on-source-change
                        @quality-levels="onQualityLevels"
                        @playing-change="onPlayingChange"
                        @duration-change="onDurationChange"
                        @audio-tracks="onAudioTracks"
                    />
                </div>
            </div>
            <aside
                v-if="showChaptersSidePanel"
                class="flex min-h-0 min-w-0 flex-[3] flex-col"
                :class="activeTab === 'trim' ? 'gap-2 overflow-hidden trim-chapters-aside' : 'gap-3'"
                :style="chaptersAsideStyle"
                @mousedown.capture="onChaptersAsidePointerDown"
            >
                <SegmentEditor
                    ref="chapterSegmentEditorRef"
                    v-model="chapterSegments"
                    :class="activeTab === 'trim' ? 'h-full overflow-hidden' : ''"
                    mode="chapters"
                    split-list-panel
                    :duration="chaptersSidePanelDuration"
                    :get-current-time="() => hlsPlayerRef?.getCurrentTime() ?? 0"
                    :on-seek="(t: number) => hlsPlayerRef?.seek(t)"
                    :on-play-pause="() => hlsPlayerRef?.togglePlay()"
                    :is-playing="isPreviewPlaying"
                    :ripple-edit="false"
                    :show-timeline="false"
                    :show-toolbar="false"
                    :show-playback-controls="false"
                    :show-help="false"
                    title="Chapters"
                    keyboard-scope="focus"
                    :fps="segmentEditorProbeFps"
                />
                <p
                    v-if="chaptersSaveError"
                    class="text-xs text-red-600 dark:text-red-400"
                >{{ chaptersSaveError }}</p>
            </aside>
        </div>

        <p
            v-if="chaptersSaveError && !showChaptersSidePanel"
            class="mt-2 text-xs text-red-600 dark:text-red-400"
        >{{ chaptersSaveError }}</p>

        <div v-if="isCompleted && showAngleSwitcher" class="mt-4 flex flex-wrap items-center gap-2">
            <span class="text-xs font-medium text-slate-500 dark:text-slate-400">Angle</span>
            <div class="flex flex-wrap gap-1.5">
                <button
                    v-for="(ap, i) in uniqueAnglePlaylists"
                    :key="ap.key"
                    type="button"
                    class="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    :class="i === currentAngleIndex
                        ? 'bg-slate-800 text-white dark:bg-slate-700 dark:text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
                    @click="emit('angleChange', i)"
                >
                    {{ ap.name }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Force the SegmentEditor's split list panel to fill the full aside height in trim mode. */
.trim-chapters-aside :deep(.se-root--split-list) {
    height: 100%;
}
.trim-chapters-aside :deep(.se-list-section--split) {
    flex: 1 1 0%;
    max-height: none;
}

/* Trim tab: 16/9 matches typical preview/HLS; flex shares favor a wider/bigger player beside chapters. */
.session-trim-player-cap {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: min(58dvh, 82vh);
}
.session-trim-player-cap :deep(> div) {
    height: 100%;
}
.session-trim-player-cap :deep(.video-js.vjs-fluid) {
    padding-top: 0 !important;
    width: 100%;
    height: 100%;
}
.session-trim-player-cap :deep(.video-js .vjs-tech) {
    object-fit: contain;
}
</style>
