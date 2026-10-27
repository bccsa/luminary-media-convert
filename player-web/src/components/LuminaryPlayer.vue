<script setup lang="ts">
/**
 * The simple web player: `player-core` playback inside Video.js 10's stock video skin.
 *
 * A `PlayerController` over an `HlsJsVideoAdapter` munges the master (LMCENC decrypt, angle
 * extraction, quality capping) and hands hls.js a blob playlist plus an in-memory key. It serves the
 * encoder's preview and the Luminary CMS's; the Luminary app draws its own controls on this engine.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import '@videojs/html/media/hlsjs-video';
import { PlayerController } from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerControllerOptions,
    PlayerError,
    PlayerSource,
} from '@luminary-media-converter/player-core';
import { HlsJsVideoAdapter } from '../adapter/HlsJsVideoAdapter';
import type { HlsJsVideoElement } from '../adapter/hlsTypes';
import { BlobServeStrategy } from '../serve/BlobServeStrategy';
import { usePlayerState } from '../composables/usePlayerState';
import { mergeMessages, type PlayerMessages } from '../messages';
import { mergeControls, type PlayerControlsOptions } from '../controls';
import { isYouTubeUrl } from '../youtube';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /** UI strings merged over the English defaults. */
    messages?: Partial<PlayerMessages>;
    /** Language of the skin's own control names, e.g. `fr`; the page's `lang` when omitted. */
    lang?: string;
    /** Which controls to offer. Anything omitted keeps the default. */
    controls?: Partial<PlayerControlsOptions>;
    /**
     * How the picture fills the frame while windowed: `contain` letterboxes, `cover` fills and crops.
     * Fullscreen always letterboxes.
     */
    windowedFit?: 'contain' | 'cover';
    /** Options handed to the default `PlayerController`. */
    controllerOptions?: Partial<PlayerControllerOptions>;
    /** @internal Test seam — substitutes controller construction. */
    createController?: (media: HlsJsVideoElement) => PlayerControllerApi;
}

const props = defineProps<Props>();

/** Playback events, for hosts that persist a resume point. */
const emit = defineEmits<{
    timeupdate: [currentTime: number, duration: number];
    loadedmetadata: [];
    ended: [];
}>();

const mediaEl = shallowRef<HlsJsVideoElement | null>(null);
const playerEl = ref<HTMLElement | null>(null);
const skinEl = ref<HTMLElement | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);
const isFullscreen = ref(false);

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const mergedControls = computed(() => mergeControls(props.controls));
const bare = computed(() => !mergedControls.value.windowedControls && !isFullscreen.value);

const UNSUPPORTED_YOUTUBE: PlayerError = {
    code: 'media',
    fatal: true,
    message: 'YouTube sources are not supported by this player',
};
const sourceError = shallowRef<PlayerError | null>(null);

function defaultCreateController(media: HlsJsVideoElement): PlayerControllerApi {
    const serveStrategy =
        props.controllerOptions?.serveStrategy ??
        new BlobServeStrategy({ fetchImpl: props.controllerOptions?.fetchImpl });
    const liveSource = serveStrategy instanceof BlobServeStrategy ? serveStrategy : undefined;
    return new PlayerController(new HlsJsVideoAdapter(media, { liveSource }), {
        ...props.controllerOptions,
        serveStrategy,
    });
}

// --- source loading -------------------------------------------------------

async function loadSource(source: PlayerSource): Promise<void> {
    const media = mediaEl.value;
    if (!media) return;
    sourceError.value = null;

    if (isYouTubeUrl(source.masterUrl)) {
        controller.value?.destroy();
        controller.value = null;
        sourceError.value = UNSUPPORTED_YOUTUBE;
        return;
    }

    controller.value ??= (props.createController ?? defaultCreateController)(media);
    await controller.value.load(source);
}

watch(
    () => props.source,
    (source) => void loadSource(source)
);

// --- the stock skin --------------------------------------------------------

/**
 * The skin draws into its own shadow root, so the rules that leave its controls out go there. Its error
 * dialog is always left out: the `error` panel below speaks instead, and a host can replace that one.
 * A submenu's item is found by its label token: items and submenus are linked only by a random id.
 */
const SKIN_RULES = `
media-error-dialog { display: none !important; }
:host(.lmpl-bare) media-controls { display: none !important; }
:host(.lmpl-no-audio-menu) media-menu-item:has(> media-text[token="menu.audio"]) { display: none !important; }
:host(.lmpl-no-captions) media-captions-button,
:host(.lmpl-no-captions) media-menu-item:has(> media-text[token="menu.captions"]) { display: none !important; }
`;

async function styleSkin(): Promise<void> {
    await customElements.whenDefined('video-skin');
    const root = skinEl.value?.shadowRoot;
    if (!root || root.querySelector('style[data-lmpl]')) return;
    const style = document.createElement('style');
    style.dataset.lmpl = '';
    style.textContent = SKIN_RULES;
    root.appendChild(style);
}

const skinClasses = computed(() => ({
    'lmpl-bare': bare.value,
    'lmpl-no-audio-menu': !mergedControls.value.audioMenu,
    'lmpl-no-captions': !mergedControls.value.subtitlesMenu,
}));

/** The `<video>` the element renders into, in its shadow root, where a host's CSS cannot reach. */
function innerVideo(): HTMLVideoElement | null {
    const el = mediaEl.value as unknown as { target?: HTMLVideoElement | null; shadowRoot?: ShadowRoot | null } | null;
    return el?.target ?? el?.shadowRoot?.querySelector('video') ?? null;
}

const fit = computed(() => (isFullscreen.value ? 'contain' : (props.windowedFit ?? 'contain')));

function applyFit(): void {
    const video = innerVideo();
    if (video) video.style.objectFit = fit.value;
}

watch(fit, applyFit);

// --- fullscreen --------------------------------------------------------------

interface PlayerStore {
    requestFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
}

const store = (): PlayerStore | undefined => (playerEl.value as unknown as { store?: PlayerStore } | null)?.store;

function onFullscreenChange(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const element = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    isFullscreen.value = element !== null && !!playerEl.value?.contains(element);
}

/** For a host with its own fullscreen button, which a bare windowed frame has no other button for. */
async function enterFullscreen(): Promise<void> {
    try {
        await store()?.requestFullscreen();
    } catch {
        /* denied by the browser (no user gesture, policy) — stay inline */
    }
}

function exitFullscreen(): void {
    // Rejected when nothing is fullscreen, and nobody would catch it.
    if (isFullscreen.value) void store()?.exitFullscreen();
}

/** The bare frame's only gesture; with controls on, the skin's own gestures answer. */
function onFrameDoubleClick(): void {
    if (!bare.value) return;
    void enterFullscreen();
}

// --- transport, for hosts ----------------------------------------------------

/** A time the element can be handed: real, and not before the start of the media. */
function seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || !mediaEl.value) return;
    mediaEl.value.currentTime = seconds;
}

/** Starts playback and reports whether the browser allowed it; a refusal is expected, not an error. */
async function play(): Promise<boolean> {
    try {
        await mediaEl.value?.play();
        return true;
    } catch {
        return false;
    }
}

function pause(): void {
    mediaEl.value?.pause();
}

// --- lifecycle ---------------------------------------------------------------

const mediaListeners: [string, EventListener][] = [];

onMounted(() => {
    const media = mediaEl.value;
    if (!media) return;
    const on = (type: string, handler: EventListener): void => {
        media.addEventListener(type, handler);
        mediaListeners.push([type, handler]);
    };
    on('timeupdate', () => emit('timeupdate', media.currentTime, media.duration));
    on('loadedmetadata', () => {
        applyFit();
        emit('loadedmetadata');
    });
    on('ended', () => emit('ended'));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    void styleSkin();
    void loadSource(props.source);
});

onBeforeUnmount(() => {
    for (const [type, handler] of mediaListeners) mediaEl.value?.removeEventListener(type, handler);
    mediaListeners.length = 0;
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    controller.value?.destroy();
    controller.value = null;
});

// --- error surface -------------------------------------------------------------

const ERROR_MESSAGE_KEYS: Partial<Record<PlayerError['code'], keyof PlayerMessages>> = {
    'unsupported-browser': 'errorUnsupportedBrowser',
    'key-required': 'errorKeyRequired',
    network: 'errorNetwork',
    media: 'errorMedia',
};

const displayedError = computed(() => sourceError.value ?? state.value.error);

const errorText = computed(() => {
    const code = displayedError.value?.code;
    const key = code ? ERROR_MESSAGE_KEYS[code] : undefined;
    return key ? msg.value[key] : msg.value.errorGeneric;
});

function retry(): void {
    void loadSource(props.source);
}

defineExpose({ controller, state, enterFullscreen, exitFullscreen, seek, play, pause });
</script>

<template>
    <div
        class="lmpl-root"
        :class="{ 'lmpl-windowed-bare': bare, 'lmpl-is-fullscreen': isFullscreen }"
        @dblclick="onFrameDoubleClick"
    >
        <video-player ref="playerEl" class="lmpl-video-player" :lang="lang">
            <!-- Inert while bare, so nothing on the frame can take focus or swallow the host's keys. -->
            <video-skin
                ref="skinEl"
                class="lmpl-skin"
                :class="skinClasses"
                :style="{ '--media-object-fit': fit }"
                :inert="bare"
            >
                <hlsjs-video ref="mediaEl" class="lmpl-media" playsinline preload="auto"></hlsjs-video>
            </video-skin>
        </video-player>

        <div class="lmpl-slot">
            <slot :state="state" :controller="controller"></slot>
        </div>

        <template v-if="state.lifecycle === 'waiting-for-master'">
            <slot name="coming-soon" :state="state">
                <div class="lmpl-panel lmpl-coming-soon">
                    <p class="lmpl-panel-text">{{ msg.comingSoon }}</p>
                </div>
            </slot>
        </template>

        <template v-else-if="state.lifecycle === 'error' || sourceError">
            <slot name="error" :state="state" :error="displayedError" :retry="retry">
                <div class="lmpl-panel lmpl-error">
                    <p class="lmpl-panel-text">{{ errorText }}</p>
                    <button type="button" class="lmpl-btn lmpl-retry" @click="retry">
                        {{ msg.retry }}
                    </button>
                </div>
            </slot>
        </template>
    </div>
</template>

<style>
/*
 * `@import`ed from a style block rather than `import`ed from a script, because TypeScript keeps a
 * side-effect `import` in the emitted `.d.ts`, where a consumer type-checking with
 * `skipLibCheck: false` then fails to resolve `.css`.
 */
@import '../styles.css';
</style>
