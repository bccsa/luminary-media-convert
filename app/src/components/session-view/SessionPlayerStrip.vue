<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LuminaryPlayer, usePlayerState } from '@luminary-media-converter/player-web';
import type {
    PlayerControllerApi,
    PlayerSource,
} from '@luminary-media-converter/player-core';
import FormSelect from '../FormSelect.vue';

const props = defineProps<{
    /** What the player should present. `null` renders nothing at all. */
    source: PlayerSource | null;
    /** Whether to show the aside column beside the player. */
    showAside: boolean;
    activeTab: string;
    /** When true, hide the below-player angle row (e.g. on tabs other than the player view). */
    hideAngleSwitcher?: boolean;
    /**
     * Server-side preview audio tracks. The preview stream carries one audio
     * rendition chosen by URL, so switching it is a source swap rather than a
     * track change — which is why it is separate from the player's own
     * `audioTracks` below.
     */
    showAudioSelect: boolean;
    previewAudioSelectOptions: { value: number; label: string }[];
}>();

const selectedAudioTrack = defineModel<number>('selectedAudioTrack', { required: true });

const emit = defineEmits<{
    playingChange: [playing: boolean];
    durationChange: [d: number];
}>();

const playerShellRef = ref<HTMLElement | null>(null);
const luminaryPlayerRef = ref<InstanceType<typeof LuminaryPlayer> | null>(null);

const controller = computed<PlayerControllerApi | null>(
    () => luminaryPlayerRef.value?.controller ?? null,
);

const state = usePlayerState(controller);

// ---- Player-driven selectors (angles / qualities / audio tracks) ----
//
// All three come from the controller's state: the master is parsed once by the
// wrapper, so the angle list (including the synthesized "Audio only" rendering)
// and the post-cap quality ladder are whatever it found there.

const angleOptions = computed(() =>
    state.value.angles.map((angle) => ({ value: angle.id, label: angle.name })),
);

const showAngleRow = computed(
    () => angleOptions.value.length > 1 && !props.hideAngleSwitcher,
);

const qualityOptions = computed(() => [
    { value: 'auto', label: 'Auto' },
    ...state.value.qualities.map((quality) => ({
        value: quality.id,
        label: quality.label,
    })),
]);

const showQualitySelect = computed(
    () => state.value.qualities.length >= 1 && !state.value.isAudioOnly,
);

/**
 * Audio tracks the stream itself offers. The preview stream never has more than
 * one (its track is picked by URL), so this only lights up post-encode.
 */
const playerAudioOptions = computed(() =>
    state.value.audioTracks.map((track) => ({
        value: track.id,
        label: track.lang && track.lang !== track.label
            ? `${track.label} (${track.lang})`
            : track.label,
    })),
);

const showPlayerAudioSelect = computed(() => playerAudioOptions.value.length > 1);

/** There is a picture to make full screen. */
const canPlay = computed(() => state.value.lifecycle === 'ready');

const showPlaybackControlsRow = computed(
    () =>
        showAngleRow.value ||
        props.showAudioSelect ||
        showPlayerAudioSelect.value ||
        showQualitySelect.value ||
        canPlay.value,
);

/** The player exposes fullscreen; it deliberately draws no button for it. */
function enterFullscreen(): void {
    void luminaryPlayerRef.value?.enterFullscreen();
}

watch(() => state.value.playing, (playing) => emit('playingChange', playing));
watch(() => state.value.duration, (duration) => {
    if (duration > 0) emit('durationChange', duration);
});

// ---- Playback surface exposed to the view ----

/**
 * The play position, read straight off the media element when there is one.
 *
 * `state.currentTime` follows the engine's `timeupdate`, which fires about four
 * times a second — fine for a readout, far too coarse for a playhead drawn on
 * animation frames or for the trim-preview jumps that have to land within a
 * frame of a cut. The element is the same one the wrapper drives, so reading it
 * directly is a refresh-rate concern only, not a second source of truth.
 */
function mediaElement(): HTMLMediaElement | null {
    return playerShellRef.value?.querySelector('video') ?? null;
}

function getCurrentTime(): number {
    const el = mediaElement();
    if (el && Number.isFinite(el.currentTime)) return el.currentTime;
    return state.value.currentTime;
}

function getDuration(): number | null {
    const d = state.value.duration;
    return d > 0 ? d : null;
}

/**
 * Transport is only honoured while the player has something playable. In
 * `waiting-for-master` / `error` the engine may still hold the previous
 * source; driving it from the timeline would resume playback underneath the
 * coming-soon or error surface.
 */
function transportReady(): boolean {
    return state.value.lifecycle === 'ready';
}

function seek(time: number): void {
    if (!transportReady()) return;
    controller.value?.seek(Math.max(0, time));
}

function togglePlay(): void {
    if (!transportReady()) return;
    controller.value?.togglePlay();
}

function isPlaying(): boolean {
    return state.value.playing;
}

/**
 * Re-run the load for the current source. The player reloads by itself whenever
 * the `source` object changes, so this is for the case where the URL is stable
 * but what it serves is not — the preview playlist after trims are submitted.
 */
function reload(): void {
    if (props.source) void controller.value?.load(props.source);
}

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

const lifecycle = computed(() => state.value.lifecycle);

defineExpose({
    controller,
    lifecycle,
    getCurrentTime,
    getDuration,
    seek,
    togglePlay,
    isPlaying,
    reload,
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
            v-if="source"
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
                    /*
                     * The aside pads itself by 4 on the side facing the handle.
                     * Without the same here the player's card sat flush against
                     * the divider while the aside's card stood well clear of it,
                     * which read as the divider being off-centre.
                     */
                    activeTab === 'trim' && showAside ? 'pr-4' : '',
                ]"
                :style="playerColStyle"
            >
                <!--
                    Above the player, inside its column — where the session's
                    topline goes. Not a full-width bar above both columns any
                    more: that pushed the aside one row down and opened the
                    chapters pane with a band of empty space over it, and put the
                    session's name further from the thing it names than the app's
                    own name was.
                -->
                <div v-if="$slots['player-top']" class="shrink-0">
                    <slot name="player-top" />
                </div>

                <div
                    ref="playerShellRef"
                    :class="activeTab === 'trim'
                        ? 'session-trim-player-shell overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5'
                        : 'w-full overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5'"
                >
                    <LuminaryPlayer
                        ref="luminaryPlayerRef"
                        :source="source"
                    >
                        <!--
                            Audio-only renderings have nothing to show, so the
                            black rectangle gets a glyph rather than looking
                            like a player that failed to start.
                        -->
                        <div
                            v-if="state.isAudioOnly"
                            class="flex h-full w-full items-center justify-center"
                        >
                            <svg
                                class="h-16 w-16 text-slate-600"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                            >
                                <path d="M4 16V11a8 8 0 0 1 16 0v5" />
                                <rect x="2" y="14" width="4" height="7" rx="2" />
                                <rect x="18" y="14" width="4" height="7" rx="2" />
                            </svg>
                        </div>
                    </LuminaryPlayer>
                </div>
                <!--
                    Below-player row: Angle / Audio / Quality dropdowns, on the
                    left edge the session title used to hold. The title moved to
                    the topline above the player, and these selects took the
                    alignment rather than staying pinned right against nothing.
                -->
                <div
                    v-if="showPlaybackControlsRow || $slots['below-player']"
                    class="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3"
                >
                    <div
                        v-if="$slots['below-player']"
                        class="min-w-0 flex-[1_1_16rem]"
                    >
                        <slot name="below-player" />
                    </div>
                    <div
                        v-if="showPlaybackControlsRow"
                        class="flex flex-wrap items-center gap-x-4 gap-y-2"
                        :class="$slots['below-player'] ? 'shrink-0 ml-auto justify-end' : 'min-w-0'"
                    >
                        <span
                            v-if="showAngleRow"
                            class="inline-flex shrink-0 items-center gap-1.5"
                        >
                            <label class="playback-slot-label shrink-0">Angle:</label>
                            <FormSelect
                                variant="playback"
                                presentation="custom"
                                wrapper-class="min-w-[7rem] max-w-[min(100%,14rem)]"
                                :model-value="state.activeAngleId ?? ''"
                                :options="angleOptions"
                                aria-label="Camera angle"
                                @update:model-value="controller?.setAngle(String($event))"
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
                            v-else-if="showPlayerAudioSelect"
                            class="inline-flex shrink-0 items-center gap-1.5"
                        >
                            <label class="playback-slot-label shrink-0">Audio:</label>
                            <FormSelect
                                variant="playback"
                                presentation="custom"
                                :model-value="state.activeAudioTrackId ?? ''"
                                :options="playerAudioOptions"
                                aria-label="Audio track"
                                @update:model-value="controller?.setAudioTrack(String($event))"
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
                                :model-value="state.activeQualityId"
                                :options="qualityOptions"
                                aria-label="Quality"
                                @update:model-value="controller?.setQuality(String($event))"
                            />
                        </span>
                        <!--
                            The player draws no chrome over the picture, so the
                            way in sits with the other playback controls. It
                            also answers a double-click on the video itself.
                        -->
                        <button
                            v-if="canPlay"
                            type="button"
                            class="playback-slot-button"
                            aria-label="Full screen"
                            title="Full screen"
                            @click="enterFullscreen"
                        >
                            <svg
                                class="h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden="true"
                            >
                                <path
                                    d="M4 9V4h5v2H6v3zM15 4h5v5h-2V6h-3zM6 15v3h3v2H4v-5zM18 15h2v5h-5v-2h3z"
                                />
                            </svg>
                        </button>
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
                    ? 'gap-2 pl-4 pr-5 pt-3 pb-2 trim-aside'
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
 * the column width would exceed the row's height; the player then shrinks
 * proportionally rather than overflowing.
 */
.session-trim-player-shell {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 100%;
}
.session-trim-player-shell :deep(.lmp-root) {
    height: 100%;
}
/*
 * `cover` fills the 16/9 strip with a source that is not 16:9, which is what
 * this shell wants — but entering fullscreen does not move the element out of
 * the shell, so the rule kept matching and filled a screen-shaped box instead,
 * cropping everything outside the overlap. Fullscreen has to letterbox; that is
 * the point of it. The player marks itself either way, so exclude both forms.
 */
.session-trim-player-shell :deep(.lmp-video) {
    height: 100%;
    object-fit: cover;
}
.session-trim-player-shell :deep(.lmp-root:fullscreen .lmp-video),
.session-trim-player-shell :deep(.lmp-root.lmp-is-fullscreen .lmp-video) {
    object-fit: contain;
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
