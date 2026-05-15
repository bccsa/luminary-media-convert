<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import HlsPlayer from '../HlsPlayer.vue';
import type { AudioTrackInfo, QualityLevelInfo } from '../HlsPlayer.vue';
import FormSelect from '../FormSelect.vue';

const props = defineProps<{
    activePlaybackUrl: string | null;
    isCompleted: boolean;
    thumbnailVttUrl: string | null | undefined;
    encodingType: 'video' | 'audio';
    isAudioOnly: boolean;
    encryptionKeyHex: string | undefined;
    pollerEncryptionKeyHex: string | undefined;
    /** Whether to show the aside column beside the player. */
    showAside: boolean;
    activeTab: string;
    showAngleSwitcher: boolean;
    uniqueAnglePlaylists: { name: string; key: string }[];
    currentAngleIndex: number;
    /** When true, hide the below-player angle row (trim toolbar carries it, or another tab is active). */
    hideAngleSwitcher?: boolean;
}>();

const angleSelectOptions = computed(() =>
    props.uniqueAnglePlaylists.map((ap, i) => ({ value: i, label: ap.name })),
);

/** Match aside column height to the player shell so content never extends below the video. */
const playerShellRef = ref<HTMLElement | null>(null);
const asideMaxHeightPx = ref<number | null>(null);

watchEffect(
    (onCleanup) => {
        const el = playerShellRef.value;
        if (!el || !props.showAside) {
            asideMaxHeightPx.value = null;
            return;
        }
        const ro = new ResizeObserver(() => {
            const h = el.getBoundingClientRect().height;
            asideMaxHeightPx.value = h > 0 ? Math.round(h * 100) / 100 : null;
        });
        ro.observe(el);
        const h = el.getBoundingClientRect().height;
        asideMaxHeightPx.value = h > 0 ? Math.round(h * 100) / 100 : null;
        onCleanup(() => ro.disconnect());
    },
    { flush: 'post' },
);

const asideStyle = computed(() => {
    if (!props.showAside || asideMaxHeightPx.value == null) return undefined;
    return { maxHeight: `${asideMaxHeightPx.value}px` };
});

const emit = defineEmits<{
    qualityLevels: [levels: QualityLevelInfo[]];
    playingChange: [playing: boolean];
    durationChange: [d: number];
    audioTracks: [tracks: AudioTrackInfo[]];
    angleChange: [index: number];
}>();

const hlsPlayerRef = ref<InstanceType<typeof HlsPlayer> | null>(null);

defineExpose({
    playerRef: hlsPlayerRef,
});
</script>

<template>
    <div>
        <div
            v-if="activePlaybackUrl"
            class="flex flex-col"
            :class="[
                activeTab === 'trim' ? 'gap-3' : 'gap-4',
                showAside ? (activeTab === 'trim' ? 'lg:flex-row lg:items-stretch lg:gap-3' : 'lg:flex-row lg:items-start lg:gap-4') : '',
            ]"
        >
            <div
                :class="[
                    showAside
                        ? 'min-w-0 flex-3'
                        : 'w-full',
                    !showAside && activeTab === 'trim' ? 'flex justify-center' : '',
                ]"
            >
                <div
                    ref="playerShellRef"
                    :class="[
                        'overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5',
                        'w-full',
                        activeTab === 'trim' && !isAudioOnly ? 'session-trim-player-cap' : '',
                        !showAside && activeTab === 'trim'
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
                        @quality-levels="emit('qualityLevels', $event)"
                        @playing-change="emit('playingChange', $event)"
                        @duration-change="(d) => { if (d != null) emit('durationChange', d) }"
                        @audio-tracks="emit('audioTracks', $event)"
                    />
                </div>
            </div>

            <aside
                v-if="showAside"
                class="flex min-h-0 min-w-0 flex-3 flex-col"
                :class="activeTab === 'trim' ? 'gap-2 overflow-hidden trim-aside' : 'gap-3'"
                :style="asideStyle"
            >
                <slot name="aside" />
            </aside>
        </div>

        <div
            v-if="isCompleted && showAngleSwitcher && !hideAngleSwitcher"
            class="mt-4 flex flex-wrap items-center gap-2"
        >
            <label class="playback-slot-label shrink-0">Angle:</label>
            <FormSelect
                variant="playback"
                presentation="custom"
                numeric
                wrapper-class="min-w-[10rem] max-w-[min(100%,20rem)]"
                :model-value="currentAngleIndex"
                :options="angleSelectOptions"
                aria-label="Camera angle"
                @update:model-value="emit('angleChange', Number($event))"
            />
        </div>
    </div>
</template>

<style scoped>
/* Trim tab: 16/9 matches typical preview/HLS; flex shares favor a wider/bigger player beside the aside. */
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

/* Force slot content that uses split-list-panel to fill the full aside height. */
.trim-aside :deep(.se-root--split-list) {
    height: 100%;
}
.trim-aside :deep(.se-list-section--split) {
    flex: 1 1 0%;
    max-height: none;
}
</style>
