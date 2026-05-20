<script setup lang="ts">
import { computed, ref } from 'vue';
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

const emit = defineEmits<{
    qualityLevels: [levels: QualityLevelInfo[]];
    playingChange: [playing: boolean];
    durationChange: [d: number];
    audioTracks: [tracks: AudioTrackInfo[]];
    angleChange: [index: number];
}>();

const playerShellRef = ref<HTMLElement | null>(null);
const hlsPlayerRef = ref<InstanceType<typeof HlsPlayer> | null>(null);

defineExpose({
    playerRef: hlsPlayerRef,
});
</script>

<template>
    <div class="flex h-full flex-col">
        <!-- Player + aside: height capped to 16/9 of the player-column width so no black bars show -->
        <div
            v-if="activePlaybackUrl"
            class="flex min-h-0 flex-1"
            :class="[
                showAside ? 'flex-row' : (activeTab === 'trim' ? 'flex-col items-center justify-center' : 'flex-col gap-4'),
                activeTab === 'trim' ? 'session-trim-player-row' : '',
            ]"
        >
            <!-- Player column: black bg so letterbox space is invisible; centers player vertically -->
            <div
                class="flex min-h-0 min-w-0 flex-col items-center justify-center bg-black flex-3"
                :class="!showAside && activeTab === 'trim' ? 'max-w-[min(100%,60vw)]' : ''"
            >
                <div
                    ref="playerShellRef"
                    class="bg-black"
                    :class="activeTab === 'trim'
                        ? 'session-trim-player-fill'
                        : 'w-full overflow-hidden rounded-xl shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5'"
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

            <!-- Aside: bleeds flush to the right edge; thin left border is the separator -->
            <aside
                v-if="showAside"
                class="flex min-h-0 flex-col overflow-hidden flex-2"
                :class="activeTab === 'trim'
                    ? 'gap-2 border-l border-slate-200 px-4 pt-3 pb-2 dark:border-slate-700/60 trim-aside'
                    : 'gap-3'"
            >
                <slot name="aside" />
            </aside>
        </div>

        <!-- Angle switcher below player (completed multi-angle) -->
        <div
            v-if="isCompleted && showAngleSwitcher && !hideAngleSwitcher"
            class="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2"
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
/*
 * Trim: cap the player+aside row to exactly the 16/9 height of the player column.
 * Player column is flex-3 of flex-5 total ≈ 60vw, so 16/9 height = 60vw × 9/16 = 33.75vw.
 * Also guarded by viewport height minus header and a rough timeline estimate.
 */
.session-trim-player-row {
    max-height: min(33.75vw, calc(100dvh - 12rem));
}

/* Trim: shell fills its column exactly — column is already the right height. */
.session-trim-player-fill {
    width: 100%;
    height: 100%;
}
.session-trim-player-fill :deep(> div) {
    height: 100%;
}
.session-trim-player-fill :deep(.video-js.vjs-fluid) {
    padding-top: 0 !important;
    width: 100%;
    height: 100%;
}
.session-trim-player-fill :deep(.video-js .vjs-tech) {
    object-fit: cover;
}

/* Force split-list SegmentEditor to fill the full aside height. */
.trim-aside :deep(.se-root--split-list) {
    height: 100%;
}
.trim-aside :deep(.se-list-section--split) {
    flex: 1 1 0%;
    max-height: none;
}
</style>
