<script setup lang="ts">
/**
 * The legacy player: `player-core` playback inside the Luminary app's Video.js
 * chrome.
 *
 * Same contract as `player-web`'s `LuminaryPlayer` — same props, same slots,
 * same `defineExpose` surface — so an app can swap one for the other. What
 * differs is who draws the controls: here video.js owns the whole chrome, in
 * every mode, and this component's CSS repositions its stock components into
 * the Luminary skin. There is no custom fullscreen overlay and no double-tap
 * gesture, because video.js already has both.
 *
 * Two source modes:
 *
 * - **LMC** — the pipeline this repo exists for. A `PlayerController` over a
 *   `VideoJsAdapter` munges the master (LMCENC decrypt, angle extraction,
 *   quality capping) and hands the engine a blob playlist plus an in-memory
 *   key.
 * - **YouTube** — a URL `videojs-youtube` can play. The whole LMC pipeline is
 *   bypassed: no controller is built, the exposed `controller` stays null and
 *   `state` stays at its initial snapshot. This mirrors the Luminary app, where
 *   YouTube playback is likewise a different animal wearing the same chrome.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import { AUDIO_ONLY_ANGLE_ID, PlayerController } from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerControllerOptions,
    PlayerError,
    PlayerSource,
} from '@luminary-media-converter/player-core';
import { VideoJsAdapter } from '../adapter/VideoJsAdapter';
import { usePlayerState } from '../composables/usePlayerState';
import { mergeMessages, type PlayerMessages } from '../messages';
import { mergeControls, type PlayerControlsOptions } from '../controls';
import { buildVideoJsOptions } from '../vjs/playerOptions';
import { installAutoHide } from '../vjs/autoHide';
import { TRANSPARENT_POSTER } from '../vjs/poster';
import { createKeepAlive, SILENT_AUDIO_DATA_URI, type KeepAlive } from '../vjs/keepAlive';
import { findPreferredTrack } from '../audioTrackLanguage';
import { isYouTubeUrl, toVideoJsYouTubeUrl } from '../youtube';
import AudioVideoToggle from './AudioVideoToggle.vue';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /**
     * Resolved UI strings merged over the built-in English defaults. Use this
     * for apps keeping the default surface; use the `coming-soon` / `error`
     * scoped slots to render your own instead.
     *
     * video.js localizes its own control bar separately, through its `languages`
     * option — these strings cover only what this component draws.
     */
    messages?: Partial<PlayerMessages>;
    /**
     * Which controls to offer, and how far the skip buttons move. Sparse —
     * anything omitted keeps the library default.
     *
     * Read once, when the player is constructed: video.js fixes its control-bar
     * children at that point, so changing this afterwards does nothing until
     * the component is remounted.
     */
    controls?: Partial<PlayerControlsOptions>;
    /**
     * Artwork drawn *behind* the picture, filling the frame until the first
     * video frame arrives.
     *
     * Legacy-only, and not part of the `player-web` contract. It is a plain
     * `<img>` under a transparent player rather than video.js's own poster,
     * because video.js letterboxes a poster inside the video box while the
     * Luminary app covers the whole frame with it.
     */
    poster?: string;
    /**
     * Language to select automatically among the stream's audio tracks, as a
     * two- or three-letter code (`en`, `eng`, `en-US` — all normalized).
     *
     * Legacy-only, and matched leniently on purpose: browsers disagree about
     * whether a track's language is two-letter, three-letter terminological or
     * three-letter bibliographic. See `audioTrackLanguage.ts`.
     *
     * Re-applied whenever the track list changes, when the prop changes, on
     * `loadeddata`, and on entering or leaving fullscreen — the last two
     * because a re-source and a fullscreen transition are both points where a
     * browser has been observed to reset the selection under us. Ignored in
     * YouTube mode, which has no track list to choose from.
     *
     * A viewer outranks it. The moment the active track becomes something this
     * auto-apply did not select and the preference does not name — the video.js
     * audio menu, or a host calling `setAudioTrack` — the auto-apply suspends
     * itself and every re-application above becomes a no-op, so a language
     * chosen by hand survives the next `loadeddata` and the next fullscreen
     * transition. It re-arms on a new `source` or a new value of this prop,
     * both of which are the host asking again.
     */
    preferredLanguage?: string;
    /**
     * Options handed to the default `PlayerController` — chunk-warming
     * prefetch tuning and its debug logging live here. Read once, when the
     * controller is built; ignored when `createController` is supplied,
     * since that caller constructs the controller itself.
     */
    controllerOptions?: PlayerControllerOptions;
    /**
     * @internal Test seam — substitutes controller construction. Not part of
     * the supported API; the default builds
     * `PlayerController(VideoJsAdapter)` over the video.js player this
     * component owns.
     *
     * The element passed is the tech's live `<video>`, resolved off the player
     * at the moment the controller is built rather than captured once — a
     * YouTube round trip swaps the tech, and the element video.js was mounted
     * on is detached by then. The default implementation ignores it (every
     * video.js API hangs off the player, not the element); it is handed over
     * only to keep the signature identical to `player-web`'s, so one test
     * harness drives both.
     */
    createController?: (video: HTMLVideoElement) => PlayerControllerApi;
}

const props = defineProps<Props>();

const videoEl = ref<HTMLVideoElement | null>(null);
const keepAliveEl = ref<HTMLAudioElement | null>(null);
const player = shallowRef<Player | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);

/**
 * True while the current source is a YouTube URL — see the module comment.
 *
 * Derived rather than assigned: the flag gates the audio/video toggle and the
 * preferred-language apply, both of which read it from handlers that fire at
 * arbitrary times, and an imperatively-set flag is only correct until someone
 * returns early on the path that sets it.
 */
const isYouTube = computed(() => isYouTubeUrl(props.source.masterUrl));

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const mergedControls = computed(() => mergeControls(props.controls));

let keepAlive: KeepAlive | null = null;
let removeAutoHide: (() => void) | null = null;
/**
 * The engine's audio-track list, held so the `change` subscription can be
 * detached on unmount. The list outlives individual sources, so it is
 * subscribed once rather than per load.
 */
let engineAudioTracks: VjsTrackList | null = null;

/**
 * The live `<video>` the tech is currently rendering into.
 *
 * Not the template ref: video.js replaces the element when it swaps techs, so
 * after a YouTube round trip the one this component mounted is detached and
 * anything reading from it is reading a corpse. The ref is the fallback for the
 * one moment the player has no tech element of its own yet.
 */
function mediaElement(instance: Player): HTMLVideoElement {
    const live = instance.el()?.querySelector('video');
    return (live as HTMLVideoElement | null) ?? (videoEl.value as HTMLVideoElement);
}

function defaultCreateController(video: HTMLVideoElement): PlayerControllerApi {
    void video;
    return new PlayerController(new VideoJsAdapter(player.value!), props.controllerOptions);
}

// --- source loading -------------------------------------------------------

/** How the YouTube tech registration is waited for; see `ensureYouTubeTech`. */
const YOUTUBE_TECH_POLL_MS = 10;
const YOUTUBE_TECH_TIMEOUT_MS = 1_000;

/** The in-flight (or settled) `videojs-youtube` import; single-flight. */
let youTubeTechImport: Promise<unknown> | null = null;

/**
 * The YouTube tech, imported the first time a YouTube URL is played.
 *
 * Lazy because most sources are not YouTube and the plugin pulls in the iframe
 * API; once loaded it stays, since re-importing a registered tech does nothing.
 * The promise is kept rather than a boolean so two overlapping loads await one
 * import instead of racing two.
 *
 * The plugin registers its tech as an import side effect, and setting a source
 * before video.js knows the tech exists has been seen to land as a plain
 * unplayable source. So registration is *checked* rather than slept on: polling
 * `getTech` costs a frame or two in the normal case, where a fixed sleep costs
 * its whole duration and still guarantees nothing. The bound exists because a
 * plugin that never registers must not hang the load forever — proceeding lets
 * video.js report an unplayable source, which is the honest outcome.
 */
async function ensureYouTubeTech(): Promise<void> {
    youTubeTechImport ??= import('videojs-youtube');
    await youTubeTechImport;

    const deadline = Date.now() + YOUTUBE_TECH_TIMEOUT_MS;
    while (!videojs.getTech('Youtube') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, YOUTUBE_TECH_POLL_MS));
    }
}

/**
 * Which `loadSource` call is the current one.
 *
 * Bumped at entry and re-checked after every await: the YouTube branch waits on
 * a dynamic import, and without this a slow YouTube load resuming after a newer
 * LMC source had already been handed to the player would re-src it back to the
 * video the host has moved on from. Disposal is a separate check — a stale call
 * and a dead player are different problems with the same answer.
 */
let loadGeneration = 0;

/**
 * Points the player at a source, switching modes if this one is a different
 * kind from the last.
 *
 * Mode changes both ways are supported over one player instance: video.js swaps
 * its tech on `src()`, so nothing has to be disposed. What does have to happen
 * is the controller: it is meaningless for YouTube and is destroyed on the way
 * in, and rebuilt on the way back out.
 */
async function loadSource(source: PlayerSource): Promise<void> {
    const instance = player.value;
    if (!instance) return;

    const generation = ++loadGeneration;
    const superseded = (): boolean => generation !== loadGeneration || player.value !== instance;

    if (isYouTubeUrl(source.masterUrl)) {
        if (controller.value) {
            controller.value.destroy();
            controller.value = null;
        }
        await ensureYouTubeTech();
        if (superseded()) return;
        instance.src({ type: 'video/youtube', src: toVideoJsYouTubeUrl(source.masterUrl) });
        return;
    }

    if (!controller.value) {
        const create = props.createController ?? defaultCreateController;
        controller.value = create(mediaElement(instance));
    }
    const active = controller.value;
    // Awaited rather than fired and forgotten so this branch sits in the
    // generation chain too: the track list only exists once the load has
    // settled, and applying a language preference on behalf of a source the
    // host has already replaced is exactly the bug the token exists to stop.
    await active.load(source);
    if (superseded()) return;
    applyPreferredLanguage();
}

// --- preferred audio language --------------------------------------------

/**
 * The track id the auto-apply last selected, and whether a viewer has since
 * overruled it.
 *
 * Both are plain locals rather than refs: nothing renders from them, and a
 * reactive read inside `applyPreferredLanguage` would put the suspension flag
 * into the dependency set of every watcher that calls it.
 */
let autoAppliedTrackId: string | null = null;
let preferredSuspended = false;

/**
 * Selects the track matching `preferredLanguage`, if there is one and the
 * viewer has not taken the decision away from us.
 *
 * This runs on every track-list change, on `loadeddata` and on every fullscreen
 * transition, because each of those is a point where a browser has been seen to
 * reset the selection. That frequency is also why it has to know when to stop:
 * re-applying unconditionally would silently undo a language the viewer picked
 * from the audio menu, on the next fullscreen toggle. So the selection it makes
 * is remembered, and the moment the active track becomes something neither this
 * function chose nor the preference names, it suspends until the host asks
 * again (a new `source`, or a new `preferredLanguage`).
 */
function applyPreferredLanguage(): void {
    if (isYouTube.value || preferredSuspended) return;
    const instance = controller.value;
    const preferred = props.preferredLanguage;
    if (!instance || !preferred) return;

    const snapshot = state.value;
    const target = findPreferredTrack(snapshot.audioTracks, preferred);
    if (!target) return;
    // Recorded even when nothing is issued: the track is the auto-applied one
    // either way, and the watcher below tells "we put it there" apart from
    // "someone else did" purely by this id.
    autoAppliedTrackId = target;
    if (target === snapshot.activeAudioTrackId) return;
    instance.setAudioTrack(target);
}

/**
 * Re-arms the auto-apply. A new source or a new preference is the host stating
 * an intent afresh, which outranks a selection made against the old one.
 *
 * Declared before the watchers that re-apply, so that when `preferredLanguage`
 * changes this runs first in the same flush and the new value is applied rather
 * than swallowed by a suspension the old value earned.
 */
watch([() => props.source, () => props.preferredLanguage], () => {
    preferredSuspended = false;
    autoAppliedTrackId = null;
});

/**
 * Detects a selection this component did not make — the video.js audio menu, or
 * a host calling `setAudioTrack` itself — and stands down.
 *
 * A switch *to* the preferred language is not an override; it is agreement, and
 * suspending on it would give up on re-asserting the preference for no reason.
 */
watch(
    () => state.value.activeAudioTrackId,
    (id) => {
        if (preferredSuspended || !id) return;
        const preferred = props.preferredLanguage;
        if (!preferred || id === autoAppliedTrackId) return;
        if (id === findPreferredTrack(state.value.audioTracks, preferred)) return;
        preferredSuspended = true;
    },
);

watch([() => state.value.audioTracks, () => props.preferredLanguage], applyPreferredLanguage);

// --- engine-driven selections ---------------------------------------------

/** One entry of `player.audioTracks()`; video.js's own types name none of these. */
interface VjsTrackList {
    readonly length: number;
    [index: number]: { enabled?: boolean } | undefined;
    on(type: string, fn: () => void): void;
    off(type: string, fn: () => void): void;
}

function audioTrackList(): VjsTrackList | null {
    try {
        const tracks = player.value?.audioTracks?.();
        return (tracks as unknown as VjsTrackList | undefined) ?? null;
    } catch {
        return null;
    }
}

/**
 * Mirrors a selection made in video.js's own audio menu back into the
 * controller.
 *
 * The menu writes `track.enabled` straight onto the engine's track list, behind
 * the controller's back, and `PlayerController.refreshAudioTracks` returns
 * early when the set of ids is unchanged — so `activeAudioTrackId` would sit on
 * whatever was selected before, and every consumer reading it (the host's own
 * selectors, the preferred-language suspension above) would be wrong. Routing
 * the choice back through `setAudioTrack` keeps one source of truth.
 *
 * Ids are taken from the controller's list by position rather than re-derived
 * from the engine track: the adapter builds that list from this same list in
 * this same order, so the index is the join, and there is no id rule to keep in
 * two places. The length check is what makes that join safe — this handler is
 * attached before the adapter's, so on a source change it can see the engine's
 * new list while the controller still holds the old one, and an index into two
 * different lists is a wrong answer rather than no answer.
 */
function onEngineAudioTrackChange(): void {
    const instance = controller.value;
    const tracks = audioTrackList();
    if (isYouTube.value || !instance || !tracks) return;

    const known = state.value.audioTracks;
    if (known.length !== tracks.length) return;

    for (let i = 0; i < tracks.length; i++) {
        if (!tracks[i]?.enabled) continue;
        // `setAudioTrack` enables the same track again, and video.js's own
        // `enabled` setter ignores a write that changes nothing — so no second
        // `change` is fired and the id comparison ends the cycle either way.
        const id = known[i]?.id;
        if (id && id !== state.value.activeAudioTrackId) instance.setAudioTrack(id);
        return;
    }
}

/**
 * Mirrors a selection made in video.js's own subtitles menu back into the
 * controller, on the same reasoning as the audio sync above.
 *
 * The showing track's `id` is the sidecar track id: the adapter passes it to
 * `addRemoteTextTrack`, so the value read back here is the one
 * `setSubtitleTrack` expects. Nothing showing means subtitles off, which is a
 * selection like any other and is reported as `null`.
 */
function onEngineTextTrackChange(): void {
    const instance = controller.value;
    const tracks = player.value?.textTracks?.() as unknown as
        | { readonly length: number; [index: number]: TextTrack | undefined }
        | undefined;
    if (isYouTube.value || !instance || !tracks) return;

    let showing: string | null = null;
    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track?.kind === 'subtitles' && track.mode === 'showing') {
            showing = track.id || null;
            break;
        }
    }
    // Same loop guard as the audio sync: applying this re-fires
    // `texttrackchange` with the same track showing, and the comparison stops
    // the second pass from doing anything.
    if (showing !== state.value.activeSubtitleTrackId) instance.setSubtitleTrack(showing);
}

// --- lifecycle ------------------------------------------------------------

onMounted(() => {
    const element = videoEl.value;
    if (!element) return;

    const instance = videojs(element, buildVideoJsOptions(mergedControls.value));
    player.value = instance;

    void installMobileUi(instance);

    // Transparent, so the host's poster shows through instead of video.js's
    // black box. See `vjs/poster.ts`.
    instance.poster(TRANSPARENT_POSTER);

    removeAutoHide = installAutoHide(instance);

    keepAlive = createKeepAlive(keepAliveEl.value);
    instance.on(['play', 'playing'], onPlaybackStarted);
    instance.on(['pause', 'ended'], onPlaybackStopped);

    instance.on('loadeddata', applyPreferredLanguage);
    instance.on('fullscreenchange', applyPreferredLanguage);
    instance.on('texttrackchange', onEngineTextTrackChange);

    engineAudioTracks = audioTrackList();
    engineAudioTracks?.on('change', onEngineAudioTrackChange);

    void loadSource(props.source);
});

/**
 * Rotation-driven fullscreen and orientation locking, the app's settings
 * verbatim.
 *
 * Imported dynamically, like `videojs-youtube`: a static import of a plugin
 * that has no types of its own puts the bare module specifier into this
 * component's emitted `.d.ts`, where a consumer type-checking with
 * `skipLibCheck: false` cannot resolve it. The `typeof` guard stays regardless —
 * the plugin registers itself as an import side effect, and a consumer bundling
 * with side effects stripped should lose the behaviour, not crash.
 */
async function installMobileUi(instance: Player): Promise<void> {
    await import('videojs-mobile-ui');
    if (player.value !== instance) return;
    if (typeof instance.mobileUi !== 'function') return;
    instance.mobileUi({
        fullscreen: {
            enterOnRotate: true,
            exitOnRotate: true,
            lockOnRotate: true,
            lockToLandscapeOnEnter: true,
            disabled: false,
        },
        touchControls: { disabled: true },
    });
}

function onPlaybackStarted(): void {
    keepAlive?.sync(true);
}

function onPlaybackStopped(): void {
    keepAlive?.sync(false);
}

/**
 * The keep-alive follows the transport, and a fatal error is not a transport
 * event: the picture is gone, `pause` never fires, and the silence would loop
 * on holding an audio session open for playback that has stopped existing.
 *
 * Unmount is already covered — `keepAlive.dispose()` pauses and rewinds — so
 * this is the only other way out.
 */
watch(
    () => state.value.lifecycle,
    (lifecycle) => {
        if (lifecycle === 'error') keepAlive?.sync(false);
    },
);

watch(
    () => props.source,
    (next) => {
        void loadSource(next);
    },
);

onBeforeUnmount(() => {
    removeAutoHide?.();
    removeAutoHide = null;
    keepAlive?.dispose();
    keepAlive = null;

    engineAudioTracks?.off('change', onEngineAudioTrackChange);
    engineAudioTracks = null;

    // Order matters: the adapter detaches its handlers from a live player, and
    // a disposed player throws at the first of them.
    controller.value?.destroy();
    controller.value = null;
    player.value?.dispose();
    player.value = null;
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
    void loadSource(props.source);
}

// --- fullscreen -----------------------------------------------------------

/**
 * video.js owns fullscreen here — including the rotation handling from
 * `videojs-mobile-ui` — so these are thin pass-throughs kept for contract
 * parity with `player-web`, where a host places its own fullscreen button.
 */
async function enterFullscreen(): Promise<void> {
    try {
        await player.value?.requestFullscreen();
    } catch {
        /* denied by the browser (no user gesture, policy) — stay inline */
    }
}

function exitFullscreen(): void {
    void player.value?.exitFullscreen();
}

// --- audio / video toggle -------------------------------------------------

/**
 * Offered only when pressing it would go somewhere.
 *
 * A live controller on a playable LMC source is the precondition — YouTube has
 * no audio-only rendering to switch to, and before `ready` the angle list is not
 * known — but it is not sufficient: the pipeline synthesizes the audio-only
 * pseudo-angle from the master's audio groups, so a master with none carries no
 * {@link AUDIO_ONLY_ANGLE_ID} and the audio half has no destination. The
 * mirror case is a natively audio-only stream: it has nothing to go back to, so
 * the toggle only survives there if a real angle exists alongside.
 */
const showAudioVideoToggle = computed(() => {
    if (!mergedControls.value.audioVideoToggle) return false;
    if (isYouTube.value || controller.value === null) return false;

    const snapshot = state.value;
    if (snapshot.lifecycle !== 'ready') return false;
    if (!snapshot.angles.some((angle) => angle.id === AUDIO_ONLY_ANGLE_ID)) return false;

    const inAudioOnly =
        snapshot.isAudioOnly || snapshot.activeAngleId === AUDIO_ONLY_ANGLE_ID;
    return !inAudioOnly || snapshot.angles.some((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
});

defineExpose({ controller, state, enterFullscreen, exitFullscreen });
</script>

<template>
    <div class="lmpl-root">
        <img v-if="poster" class="lmpl-poster" :src="poster" alt="" />

        <div class="lmpl-video-player">
            <video
                ref="videoEl"
                class="video-js lmpl-video"
                playsinline
                webkit-playsinline
                controls
                preload="auto"
            ></video>
        </div>

        <!-- Keeps the iOS audio session open across a re-source; see vjs/keepAlive.ts. -->
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

        <template v-else-if="state.lifecycle === 'error'">
            <slot name="error" :state="state" :error="state.error" :retry="retry">
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
/*
 * Stylesheet order is load-bearing and this is where it is decided: the skin
 * overrides video.js's own rules, and `vite-plugin-css-injected-by-js` injects
 * in the order the bundler sees them, so the vendor sheets come first.
 *
 * They are `@import`ed from a style block rather than `import`ed from a script,
 * because TypeScript preserves a side-effect `import` in the emitted `.d.ts` —
 * where a consumer type-checking with `skipLibCheck: false` then fails to
 * resolve `.css`. A style block is invisible to declaration emit, and Vite
 * inlines these at build time exactly as it would a script import.
 */
@import 'video.js/dist/video-js.css';
@import 'videojs-mobile-ui/dist/videojs-mobile-ui.css';
@import '../styles.css';
</style>
