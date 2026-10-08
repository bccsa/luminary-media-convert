<script setup lang="ts">
/**
 * The Luminary web player on Video.js 10: `player-core` playback inside v10's packaged video skin.
 *
 * A `PlayerController` over an `HlsJsVideoAdapter` munges the master (LMCENC decrypt, angle
 * extraction, quality capping) and hands hls.js a blob playlist plus an in-memory key. The skin is
 * v10's own, unmodified; the props that shaped the Video.js 8 chrome (`controls`) are accepted so a
 * host compiles unchanged, but the packaged skin cannot honour them — see the migration notes.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import '@videojs/html/media/hlsjs-video';
import {
    AUDIO_ONLY_ANGLE_ID,
    PlayerController,
    findPreferredTrack,
} from '@luminary-media-converter/player-core';
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
import { createKeepAlive, SILENT_AUDIO_DATA_URI, type KeepAlive } from '../ui/keepAlive';
import { imageAttempts, toPlayerImage, type PlayerImageInput } from '../image';
import { isYouTubeUrl } from '../youtube';
import AudioVideoToggle from './AudioVideoToggle.vue';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /** UI strings merged over the English defaults. */
    messages?: Partial<PlayerMessages>;
    /**
     * Accepted for compatibility with the Video.js 8 player. The packaged v10 skin has a fixed
     * control set, so only `audioVideoToggle` still has an effect.
     */
    controls?: Partial<PlayerControlsOptions>;
    /** Artwork under the picture, until the first frame and while audio-only. */
    poster?: PlayerImageInput;
    /** Not supported yet on the v10 player; YouTube sources raise a `media` error. */
    youtubeEmbedUrl?: string;
    /** Audio language to select automatically; a viewer's own choice outranks it. */
    preferredLanguage?: string;
    /** Options handed to the default `PlayerController`. */
    controllerOptions?: Partial<PlayerControllerOptions>;
    /** @internal Test seam — substitutes controller construction. */
    createController?: (media: HlsJsVideoElement) => PlayerControllerApi;
}

const props = defineProps<Props>();

/** Playback events raised in every source mode, for hosts that persist a resume point. */
const emit = defineEmits<{
    timeupdate: [currentTime: number, duration: number];
    loadedmetadata: [];
    ended: [];
}>();

const mediaEl = shallowRef<HlsJsVideoElement | null>(null);
const keepAliveEl = ref<HTMLAudioElement | null>(null);
const playerEl = ref<HTMLElement | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);
const isFullscreen = ref(false);
const frameWidth = ref(0);
let frameObserver: ResizeObserver | null = null;
let keepAlive: KeepAlive | null = null;

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const mergedControls = computed(() => mergeControls(props.controls));
const isYouTube = computed(() => isYouTubeUrl(props.source.masterUrl));

const UNSUPPORTED_YOUTUBE: PlayerError = {
    code: 'media',
    fatal: true,
    message: 'YouTube sources are not supported by the Video.js 10 player yet',
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

let loadGeneration = 0;

async function loadSource(source: PlayerSource): Promise<void> {
    const media = mediaEl.value;
    if (!media) return;
    const generation = ++loadGeneration;
    sourceError.value = null;

    if (isYouTubeUrl(source.masterUrl)) {
        controller.value?.destroy();
        controller.value = null;
        sourceError.value = UNSUPPORTED_YOUTUBE;
        return;
    }

    controller.value ??= (props.createController ?? defaultCreateController)(media);
    await controller.value.load(source);
    if (generation !== loadGeneration) return;
    applyPreferredLanguage();
}

// --- preferred audio language ----------------------------------------------

let autoAppliedTrackId: string | null = null;
let preferredSuspended = false;

/**
 * Selects the track matching `preferredLanguage`, unless the viewer has taken the decision away:
 * the moment the active track becomes something neither this function chose nor the preference
 * names, it stands down until the host asks again (a new `source` or `preferredLanguage`).
 */
function applyPreferredLanguage(): void {
    if (isYouTube.value || preferredSuspended) return;
    const instance = controller.value;
    const preferred = props.preferredLanguage;
    if (!instance || !preferred) return;

    const snapshot = state.value;
    const target = findPreferredTrack(snapshot.audioTracks, preferred);
    if (!target) return;
    autoAppliedTrackId = target;
    if (target === snapshot.activeAudioTrackId) return;
    instance.setAudioTrack(target);
}

watch([() => props.source, () => props.preferredLanguage], () => {
    preferredSuspended = false;
    autoAppliedTrackId = null;
});

watch(
    [() => state.value.activeAudioTrackId, () => state.value.audioTracks],
    ([id, tracks], [, previousTracks]) => {
        // An active track arriving with a new list is a default, not a choice.
        if (tracks !== previousTracks) return;
        if (preferredSuspended || !id) return;
        const preferred = props.preferredLanguage;
        if (!preferred || id === autoAppliedTrackId) return;
        if (id === findPreferredTrack(tracks, preferred)) return;
        preferredSuspended = true;
    }
);

watch([() => state.value.audioTracks, () => props.preferredLanguage], applyPreferredLanguage);

// --- engine-driven selections ----------------------------------------------

/**
 * Mirrors a selection made in the skin's audio menu back into the controller. The menu writes
 * `track.enabled` on the element's list behind the controller's back, so without this
 * `activeAudioTrackId` would sit on whatever was selected before. Ids are joined by position: the
 * adapter builds its list from this same list in this same order, and the length check keeps a
 * half-rebuilt list from being joined to the old one.
 */
function onEngineAudioTrackChange(): void {
    const instance = controller.value;
    const tracks = mediaEl.value?.audioTracks;
    if (isYouTube.value || !instance || !tracks) return;
    const known = state.value.audioTracks;
    if (known.length !== tracks.length) return;
    let i = 0;
    for (const track of tracks) {
        if (track.enabled) {
            const id = known[i]?.id;
            if (id && id !== state.value.activeAudioTrackId) instance.setAudioTrack(id);
            return;
        }
        i++;
    }
}

/** Mirrors a selection made in the skin's captions menu back into the controller. */
function onEngineTextTrackChange(): void {
    const instance = controller.value;
    const tracks = mediaEl.value?.textTracks;
    if (isYouTube.value || !instance || !tracks) return;
    let showing: string | null = null;
    for (const track of tracks) {
        if (track.kind === 'subtitles' && track.mode === 'showing') {
            showing = track.id || null;
            break;
        }
    }
    if (showing !== state.value.activeSubtitleTrackId) instance.setSubtitleTrack(showing);
}

// --- lifecycle ------------------------------------------------------------

const mediaListeners: [string, EventListener][] = [];
let audioTrackList: EventTarget | undefined;
let textTrackList: EventTarget | undefined;

onMounted(() => {
    const media = mediaEl.value;
    if (!media) return;

    const on = (type: string, handler: EventListener): void => {
        media.addEventListener(type, handler);
        mediaListeners.push([type, handler]);
    };
    on('play', () => keepAlive?.sync(true));
    on('playing', () => keepAlive?.sync(true));
    on('pause', () => keepAlive?.sync(false));
    on('ended', () => {
        keepAlive?.sync(false);
        emit('ended');
    });
    on('timeupdate', () => emit('timeupdate', media.currentTime || 0, media.duration || 0));
    on('loadedmetadata', () => emit('loadedmetadata'));
    on('loadeddata', applyPreferredLanguage);

    keepAlive = createKeepAlive(keepAliveEl.value);

    audioTrackList = media.audioTracks as unknown as EventTarget | undefined;
    audioTrackList?.addEventListener('change', onEngineAudioTrackChange);
    textTrackList = media.textTracks as unknown as EventTarget | undefined;
    textTrackList?.addEventListener('change', onEngineTextTrackChange);

    const frame = playerEl.value;
    if (frame && typeof ResizeObserver !== 'undefined') {
        frameObserver = new ResizeObserver(([entry]) => {
            if (entry) frameWidth.value = entry.contentRect.width;
        });
        frameObserver.observe(frame);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    void loadSource(props.source);
});

watch(
    () => state.value.lifecycle,
    (lifecycle) => {
        // A fatal error is not a transport event: `pause` never fires, and the silence would
        // loop on holding an audio session open for playback that has stopped existing.
        if (lifecycle === 'error') keepAlive?.sync(false);
    }
);

watch(
    () => props.source,
    (next) => void loadSource(next)
);

onBeforeUnmount(() => {
    for (const [type, handler] of mediaListeners) mediaEl.value?.removeEventListener(type, handler);
    mediaListeners.length = 0;
    audioTrackList?.removeEventListener('change', onEngineAudioTrackChange);
    textTrackList?.removeEventListener('change', onEngineTextTrackChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    frameObserver?.disconnect();
    frameObserver = null;
    keepAlive?.dispose();
    keepAlive = null;
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

const displayedError = computed(() => sourceError.value ?? state.value.error);

const errorText = computed(() => {
    const code = displayedError.value?.code;
    const key = code ? ERROR_MESSAGE_KEYS[code] : undefined;
    return key ? msg.value[key] : msg.value.errorGeneric;
});

function retry(): void {
    void loadSource(props.source);
}

// --- fullscreen and the media surface ---------------------------------------

interface PlayerStore {
    requestFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
}

const store = (): PlayerStore | undefined => (playerEl.value as unknown as { store?: PlayerStore } | null)?.store;

function onFullscreenChange(): void {
    isFullscreen.value = document.fullscreenElement !== null;
}

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

// --- audio / video toggle -------------------------------------------------

/** Offered only when pressing it would go somewhere; see the Video.js 8 component for the reasoning. */
const showAudioVideoToggle = computed(() => {
    if (!mergedControls.value.audioVideoToggle) return false;
    if (isYouTube.value || controller.value === null) return false;
    const snapshot = state.value;
    if (snapshot.lifecycle !== 'ready') return false;
    if (!snapshot.angles.some((angle) => angle.id === AUDIO_ONLY_ANGLE_ID)) return false;
    const inAudioOnly = snapshot.isAudioOnly || snapshot.activeAngleId === AUDIO_ONLY_ANGLE_ID;
    return !inAudioOnly || snapshot.angles.some((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
});

const isAudioOnly = computed(
    () =>
        controller.value !== null &&
        (state.value.isAudioOnly || state.value.activeAngleId === AUDIO_ONLY_ANGLE_ID)
);

// --- artwork ----------------------------------------------------------------

const artworkImage = computed(() => toPlayerImage(props.poster));
const artworkAttempts = computed(() => imageAttempts(artworkImage.value));
const artworkAttemptIndex = ref(0);

watch(
    () => JSON.stringify(artworkAttempts.value),
    () => {
        artworkAttemptIndex.value = 0;
    }
);

const artworkAttempt = computed(() => artworkAttempts.value[artworkAttemptIndex.value] ?? null);

/** Onto the fallback, and past it to nothing: a broken-image glyph is worse. */
function onArtworkError(): void {
    artworkAttemptIndex.value += 1;
}

const artworkSizes = computed(() => {
    const given = artworkImage.value?.sizes;
    if (given) return given;
    if (isFullscreen.value || frameWidth.value <= 0) return '100vw';
    return `${Math.round(frameWidth.value)}px`;
});

const showArtworkLayer = computed(() => isAudioOnly.value || artworkAttempt.value !== null);

defineExpose({ controller, state, enterFullscreen, exitFullscreen, seek, play, pause });
</script>

<template>
    <div class="lmpl-root">
        <video-player ref="playerEl" class="lmpl-video-player">
            <video-skin class="lmpl-skin">
                <!-- Slotted into the skin's container, so the artwork goes fullscreen with the picture. -->
                <div
                    v-if="showArtworkLayer"
                    class="lmpl-artwork"
                    :class="{ 'lmpl-artwork-audio': isAudioOnly }"
                    aria-hidden="true"
                >
                    <img
                        v-if="artworkAttempt"
                        :key="artworkAttemptIndex"
                        class="lmpl-artwork-img"
                        :srcset="artworkAttempt.srcset"
                        :sizes="artworkAttempt.srcset ? artworkSizes : undefined"
                        :src="artworkAttempt.src"
                        alt=""
                        draggable="false"
                        @error="onArtworkError"
                    />
                    <!-- heroicons 24/solid "musical-note", as on the audio/video toggle -->
                    <svg
                        v-if="isAudioOnly"
                        class="lmpl-audio-glyph"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            fill-rule="evenodd"
                            d="M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.402-4.909l2.31-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z"
                            clip-rule="evenodd"
                        />
                    </svg>
                </div>
                <hlsjs-video ref="mediaEl" playsinline preload="auto"></hlsjs-video>
            </video-skin>
        </video-player>

        <!-- Keeps the iOS audio session open across a re-source; see ui/keepAlive.ts. -->
        <audio
            ref="keepAliveEl"
            class="lmpl-keep-alive"
            loop
            muted
            preload="auto"
            :src="SILENT_AUDIO_DATA_URI"
        ></audio>

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

        <transition name="lmpl-fade">
            <AudioVideoToggle
                v-if="showAudioVideoToggle"
                :state="state"
                :controller="controller"
                :messages="msg"
            />
        </transition>
    </div>
</template>

<style>
@import '../styles.css';
</style>
