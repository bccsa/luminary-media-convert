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
    /** When true, hide the below-player angle row (e.g. on tabs other than the player view). */
    hideAngleSwitcher?: boolean;
    showAudioSelect: boolean;
    previewAudioSelectOptions: { value: number; label: string }[];
    showQualitySelect: boolean;
    previewQualitySelectOptions: { value: string; label: string }[];
}>();

const selectedAudioTrack = defineModel<number>('selectedAudioTrack', { required: true });
const selectedQualityId = defineModel<string | null>('selectedQualityId', { required: true });

const angleSelectOptions = computed(() =>
    props.uniqueAnglePlaylists.map((ap, i) => ({ value: i, label: ap.name })),
);

const showAngleRow = computed(
    () => props.isCompleted && props.showAngleSwitcher && !props.hideAngleSwitcher,
);

const showPlaybackControlsRow = computed(
    () => showAngleRow.value || props.showAudioSelect || props.showQualitySelect,
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

// ---- Split resizer (player ↔ aside) ----
const SPLIT_KEY = 'lmc:session-player-split';
const SPLIT_MIN = 25;
const SPLIT_MAX = 75;

const splitPercent = ref<number>((() => {
    try {
        const raw = localStorage.getItem(SPLIT_KEY);
        const n = raw == null ? NaN : Number(raw);
        return Number.isFinite(n) && n >= SPLIT_MIN && n <= SPLIT_MAX ? n : 50;
    } catch {
        return 50;
    }
})());

const splitRowRef = ref<HTMLElement | null>(null);
const isResizing = ref(false);

const clamp = (n: number) => Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, n));

function persistSplit() {
    try {
        localStorage.setItem(SPLIT_KEY, String(Math.round(splitPercent.value)));
    } catch {
        // ignore — non-critical UX state
    }
}

function onResizeStart(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    isResizing.value = true;

    let raf = 0;
    const onMove = (ev: PointerEvent) => {
        const row = splitRowRef.value;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        if (rect.width <= 0) return;
        const next = clamp(((ev.clientX - rect.left) / rect.width) * 100);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            splitPercent.value = next;
        });
    };
    const onEnd = (ev: PointerEvent) => {
        isResizing.value = false;
        if (raf) cancelAnimationFrame(raf);
        try { handle.releasePointerCapture(ev.pointerId); } catch {}
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        persistSplit();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
}

function onResizeReset() {
    splitPercent.value = 50;
    persistSplit();
}

function onResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 5 : 2;
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        splitPercent.value = clamp(splitPercent.value - step);
        persistSplit();
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        splitPercent.value = clamp(splitPercent.value + step);
        persistSplit();
    } else if (e.key === 'Home') {
        e.preventDefault();
        splitPercent.value = SPLIT_MIN;
        persistSplit();
    } else if (e.key === 'End') {
        e.preventDefault();
        splitPercent.value = SPLIT_MAX;
        persistSplit();
    }
}

const playerColStyle = computed(() =>
    props.showAside ? { flex: `0 0 ${splitPercent.value}%` } : undefined,
);
const asideColStyle = computed(() =>
    props.showAside ? { flex: `0 0 ${100 - splitPercent.value}%` } : undefined,
);

defineExpose({
    playerRef: hlsPlayerRef,
});
</script>

<template>
    <div class="flex h-full flex-col">
        <!--
            Trim layout: row fills all space above the timeline.
            The player shell self-sizes to 16/9 of its column width and anchors
            top-left; the aside is free to stretch to the full row height so
            its form content (Detected media, Renditions, Audio groups…) lines
            up with the player's bottom instead of clipping above it.
        -->
        <div
            v-if="activePlaybackUrl"
            ref="splitRowRef"
            class="flex min-h-0 flex-1"
            :class="[
                showAside ? 'flex-row' : (activeTab === 'trim' ? 'flex-col items-center justify-center' : 'flex-col gap-4'),
                isResizing ? 'select-none' : '',
            ]"
        >
            <!-- Player column: shell anchored to the top, empty space below shows page background -->
            <div
                class="flex min-h-0 min-w-0 flex-col"
                :class="[
                    showAside ? '' : 'flex-1',
                    !showAside && activeTab === 'trim' ? 'max-w-[min(100%,60vw)]' : '',
                    activeTab === 'trim' ? 'pt-3 pl-3' : '',
                    activeTab === 'trim' && !showAside ? 'pr-3' : '',
                ]"
                :style="playerColStyle"
            >
                <div
                    ref="playerShellRef"
                    :class="activeTab === 'trim'
                        ? 'session-trim-player-shell overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5'
                        : 'w-full overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5'"
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
                <!--
                    Below-player row: session title/status on the left,
                    Angle / Audio / Quality dropdowns on the right.
                    Title truncates first; if the container is too narrow to
                    fit the dropdowns alongside, the row wraps and the
                    dropdowns slide to a second line, still right-aligned.
                -->
                <div
                    v-if="showPlaybackControlsRow || $slots['below-player']"
                    class="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3"
                >
                    <div
                        v-if="$slots['below-player']"
                        class="min-w-0 flex-1"
                    >
                        <slot name="below-player" />
                    </div>
                    <div
                        v-if="showPlaybackControlsRow"
                        class="shrink-0 ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2"
                    >
                        <span
                            v-if="showAngleRow"
                            class="inline-flex shrink-0 items-center gap-1.5"
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
                        </span>
                        <span
                            v-if="showAudioSelect"
                            class="inline-flex shrink-0 items-center gap-1.5"
                        >
                            <label class="playback-slot-label shrink-0">Audio:</label>
                            <FormSelect
                                variant="playback"
                                presentation="custom"
                                numeric
                                v-model="selectedAudioTrack"
                                :options="previewAudioSelectOptions"
                                aria-label="Audio track"
                            />
                        </span>
                        <span
                            v-if="showQualitySelect"
                            class="inline-flex shrink-0 items-center gap-1.5"
                        >
                            <label class="playback-slot-label shrink-0">Quality:</label>
                            <FormSelect
                                variant="playback"
                                presentation="custom"
                                :model-value="selectedQualityId ?? ''"
                                :options="previewQualitySelectOptions"
                                aria-label="Quality"
                                @update:model-value="selectedQualityId = $event === '' ? null : String($event)"
                            />
                        </span>
                    </div>
                </div>
            </div>

            <!-- Resize handle: drag to repartition player ↔ aside -->
            <div
                v-if="showAside"
                class="session-split-handle"
                :class="{ 'session-split-handle--active': isResizing }"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize player and side panel"
                :aria-valuenow="Math.round(splitPercent)"
                :aria-valuemin="25"
                :aria-valuemax="75"
                tabindex="0"
                title="Drag to resize · Double-click to reset · ←/→ to nudge"
                @pointerdown="onResizeStart"
                @dblclick="onResizeReset"
                @keydown="onResizeKey"
            >
                <span class="session-split-handle__bar" aria-hidden="true"></span>
                <span class="session-split-handle__grip" aria-hidden="true">
                    <span></span><span></span><span></span><span></span><span></span><span></span>
                </span>
            </div>

            <!-- Aside: bleeds flush to the right edge -->
            <aside
                v-if="showAside"
                class="flex min-h-0 flex-col overflow-hidden"
                :class="activeTab === 'trim'
                    ? 'gap-2 px-4 pt-3 pb-2 trim-aside'
                    : 'gap-3'"
                :style="asideColStyle"
            >
                <slot name="aside" />
            </aside>
        </div>
    </div>
</template>

<style scoped>
/*
 * Trim: player shell self-sizes to 16/9 of its column width and anchors
 * top-left in a column that fills the full row height. The aside (the
 * other flex-1 column in the row) stretches to fill, so its form content
 * reaches all the way down to the timeline instead of clipping above
 * the player's bottom edge.
 *
 * max-height: 100% guards against extreme short windows where 16/9 of
 * the column width would exceed the row's height; video-js then shrinks
 * proportionally rather than overflowing.
 */
.session-trim-player-shell {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 100%;
}
.session-trim-player-shell :deep(> div) {
    height: 100%;
}
.session-trim-player-shell :deep(.video-js.vjs-fluid) {
    padding-top: 0 !important;
    width: 100%;
    height: 100%;
}
.session-trim-player-shell :deep(.video-js .vjs-tech) {
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

/* ---- Resize handle between player column and aside ----
 * Large hit area (10px), slim 1px bar at rest, thickens to 2px in sky-500 on
 * hover / focus / active. A small grip pill (dots) fades in to communicate
 * draggability.
 */
.session-split-handle {
    position: relative;
    flex: 0 0 10px;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: col-resize;
    touch-action: none;
    outline: none;
    -webkit-user-select: none;
    user-select: none;
}

.session-split-handle__bar {
    width: 1px;
    height: 100%;
    background: rgb(226 232 240); /* slate-200 */
    transition: background 0.14s ease, width 0.14s ease;
    pointer-events: none;
}
:global(html.dark) .session-split-handle__bar {
    background: rgb(51 65 85 / 0.6); /* slate-700/60 */
}

.session-split-handle:hover .session-split-handle__bar,
.session-split-handle:focus-visible .session-split-handle__bar,
.session-split-handle--active .session-split-handle__bar {
    background: rgb(2 132 199); /* sky-600 */
    width: 2px;
}
:global(html.dark) .session-split-handle:hover .session-split-handle__bar,
:global(html.dark) .session-split-handle:focus-visible .session-split-handle__bar,
:global(html.dark) .session-split-handle--active .session-split-handle__bar {
    background: rgb(14 165 233); /* sky-500 */
}

.session-split-handle__grip {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(0.94);
    display: grid;
    grid-template-columns: repeat(2, 4px);
    grid-auto-rows: 4px;
    gap: 3px;
    padding: 7px 5px;
    border-radius: 8px;
    background: #fff;
    border: 1px solid rgb(203 213 225); /* slate-300 */
    box-shadow: 0 1px 3px rgb(15 23 42 / 0.12), 0 1px 2px rgb(15 23 42 / 0.06);
    opacity: 0;
    transition: opacity 0.12s ease, transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
    pointer-events: none;
}
:global(html.dark) .session-split-handle__grip {
    background: rgb(30 41 59); /* slate-800 */
    border-color: rgb(71 85 105); /* slate-600 */
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.45);
}

.session-split-handle__grip > span {
    width: 4px;
    height: 4px;
    border-radius: 9999px;
    background: rgb(148 163 184); /* slate-400 */
}
:global(html.dark) .session-split-handle__grip > span {
    background: rgb(100 116 139); /* slate-500 */
}

.session-split-handle:hover .session-split-handle__grip,
.session-split-handle:focus-visible .session-split-handle__grip,
.session-split-handle--active .session-split-handle__grip {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
}

.session-split-handle--active .session-split-handle__grip {
    border-color: rgb(2 132 199); /* sky-600 */
    box-shadow: 0 2px 6px rgb(2 132 199 / 0.25);
}
.session-split-handle--active .session-split-handle__grip > span {
    background: rgb(2 132 199); /* sky-600 */
}
:global(html.dark) .session-split-handle--active .session-split-handle__grip {
    border-color: rgb(14 165 233); /* sky-500 */
}
:global(html.dark) .session-split-handle--active .session-split-handle__grip > span {
    background: rgb(14 165 233);
}
</style>
