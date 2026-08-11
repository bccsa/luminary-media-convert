<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { PlayerController } from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerError,
    PlayerSource,
} from '@luminary-media-converter/player-core';
import { HlsJsAdapter } from '../adapter/HlsJsAdapter';
import { usePlayerState } from '../composables/usePlayerState';
import { useFullscreenOrientation } from '../composables/useFullscreenOrientation';
import ScrubThumbnail from './ScrubThumbnail.vue';
import { mergeMessages, type PlayerMessages } from '../messages';
import type { PlayerControlsOptions } from '../controls';
import FullscreenControls from './FullscreenControls.vue';
import '../styles.css';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /**
     * Resolved UI strings merged over the built-in English defaults. Use this
     * for apps keeping the default surface; use the `coming-soon` / `error`
     * scoped slots to render your own instead.
     */
    messages?: Partial<PlayerMessages>;
    /**
     * Which fullscreen controls to offer, and how far the skip buttons move.
     * Sparse — anything omitted keeps the library default, which is what this
     * player did before the option existed.
     *
     * A host with its own track selectors beside the player can drop the
     * duplicate audio menu with `{ audioMenu: false }` — bearing in mind those
     * selectors are unreachable in fullscreen, so doing it leaves a viewer no
     * way to change language without leaving.
     */
    controls?: Partial<PlayerControlsOptions>;
    /**
     * Show a scrub preview over the picture, at this position in seconds.
     *
     * Off unless set, and it has to be, because outside fullscreen this player
     * draws no chrome over the video at all — that is the rule the encoder
     * relies on to put its own controls beside the frame rather than on it. So
     * the windowed preview is not something the player decides to show; a host
     * with its own timeline says "the pointer is at 01:24" and this draws the
     * frame for it, bottom-centre. `null` or omitted draws nothing.
     *
     * Nothing is drawn either when the source has no thumbnail sidecar — see
     * {@link PlayerSource.sidecars}.
     *
     * In fullscreen the player owns the scrubber and follows it itself; this is
     * ignored there, so a host can leave it bound without conditioning on mode.
     */
    previewTime?: number | null;
    /**
     * @internal Test seam — substitutes controller construction. Not part of
     * the supported API; the default builds `PlayerController(HlsJsAdapter)`.
     */
    createController?: (video: HTMLVideoElement) => PlayerControllerApi;
}

const props = defineProps<Props>();

const containerEl = ref<HTMLElement | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const { isFullscreen, mode, enter, exit } = useFullscreenOrientation();

/**
 * The frame to draw over the picture, or null.
 *
 * Fullscreen is excluded because the controls in that mode follow their own
 * scrubber; two previews for one video, in different places, would be a bug
 * that looked like a feature.
 */
const windowedPreviewCue = computed(() => {
    if (isFullscreen.value) return null;
    const at = props.previewTime;
    if (at === null || at === undefined || !Number.isFinite(at)) return null;
    if (!state.value.thumbnailsReady) return null;
    // Same end-exclusive nudge as the fullscreen scrubber: a host binding this
    // to its own timeline will hand us exactly `duration` at the right-hand end.
    const total = state.value.duration;
    const lookupAt = total > 0 ? Math.min(at, total - 0.001) : at;
    return controller.value?.thumbnailAt(lookupAt) ?? null;
});

function defaultCreateController(video: HTMLVideoElement): PlayerControllerApi {
    return new PlayerController(new HlsJsAdapter(video));
}

onMounted(() => {
    const video = videoEl.value;
    if (!video) return;
    const create = props.createController ?? defaultCreateController;
    controller.value = create(video);
    void controller.value.load(props.source);
});

watch(
    () => props.source,
    (next) => {
        void controller.value?.load(next);
    },
);

onBeforeUnmount(() => {
    controller.value?.destroy();
    controller.value = null;
});

// --- error surface --------------------------------------------------------

const ERROR_MESSAGE_KEYS: Partial<Record<PlayerError['code'], keyof PlayerMessages>> = {
    'unsupported-browser': 'errorUnsupportedBrowser',
    'key-required': 'errorKeyRequired',
    network: 'errorNetwork',
    media: 'errorMedia',
};

const errorText = computed(() => {
    const code = state.value.error?.code;
    const key = code ? ERROR_MESSAGE_KEYS[code] : undefined;
    return key ? msg.value[key] : msg.value.errorGeneric;
});

function retry(): void {
    void controller.value?.load(props.source);
}

// --- fullscreen -----------------------------------------------------------

/** Custom controls are ours to draw only when we own the fullscreen element. */
const showCustomControls = computed(() => isFullscreen.value && mode.value === 'element');

async function enterFullscreen(): Promise<void> {
    const container = containerEl.value;
    const video = videoEl.value;
    if (!container || !video) return;
    try {
        await enter(container, video);
    } catch {
        /* denied by the browser (no user gesture, policy) — stay inline */
    }
}

function exitFullscreen(): void {
    void exit();
}

function toggleFullscreen(): void {
    if (isFullscreen.value) exitFullscreen();
    else void enterFullscreen();
}

/**
 * Double-click / double-tap toggles fullscreen.
 *
 * The gesture stays with the player because it belongs to the video surface;
 * the button that does the same thing does not, and lives in the host app's
 * controls.
 *
 * Bound to the root rather than to the video, because the fullscreen overlay
 * covers the video whenever it is showing — bound any lower, the gesture would
 * work only in the moments the controls happened to be hidden. Anything the
 * viewer can actually operate is exempt, so double-clicking play/pause is two
 * play/pauses and nothing more.
 *
 * Touch is detected by hand rather than left to `dblclick`, which mobile
 * browsers fire late, inconsistently, or not at all. Where a browser does both,
 * `handledAt` swallows the synthesised click that follows the taps.
 */
const DOUBLE_TAP_MS = 300;
let lastTapAt = 0;
let handledAt = 0;

function isOnControl(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        target.closest('button, input, select, textarea, a, [role="slider"]') !== null
    );
}

function onDoubleClick(event: MouseEvent): void {
    if (isOnControl(event.target)) return;
    if (Date.now() - handledAt < DOUBLE_TAP_MS * 2) return;
    toggleFullscreen();
}

function onPointerUp(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || isOnControl(event.target)) return;
    const now = Date.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
        lastTapAt = 0;
        handledAt = now;
        toggleFullscreen();
        return;
    }
    lastTapAt = now;
}

defineExpose({ controller, state, enterFullscreen, exitFullscreen });
</script>

<template>
    <div
        ref="containerEl"
        class="lmp-root"
        :class="{ 'lmp-is-fullscreen': isFullscreen }"
        @dblclick="onDoubleClick"
        @pointerup="onPointerUp"
    >
        <video ref="videoEl" class="lmp-video" playsinline webkit-playsinline></video>

        <div class="lmp-slot">
            <slot :state="state" :controller="controller"></slot>
        </div>

        <!--
            Bottom-centre over the picture, and only when a host asked for it.
        -->
        <div v-if="windowedPreviewCue" class="lmp-windowed-preview">
            <ScrubThumbnail :cue="windowedPreviewCue" :width="176" />
        </div>

        <template v-if="state.lifecycle === 'waiting-for-master'">
            <slot name="coming-soon" :state="state">
                <div class="lmp-panel lmp-coming-soon">
                    <p class="lmp-panel-text">{{ msg.comingSoon }}</p>
                </div>
            </slot>
        </template>

        <template v-else-if="state.lifecycle === 'error'">
            <slot name="error" :state="state" :error="state.error" :retry="retry">
                <div class="lmp-panel lmp-error">
                    <p class="lmp-panel-text">{{ errorText }}</p>
                    <button type="button" class="lmp-btn lmp-retry" @click="retry">
                        {{ msg.retry }}
                    </button>
                </div>
            </slot>
        </template>

        <FullscreenControls
            v-if="showCustomControls && controller"
            :state="state"
            :messages="msg"
            :controller="controller"
            :controls="controls"
            @exit="exitFullscreen"
        />
    </div>
</template>
