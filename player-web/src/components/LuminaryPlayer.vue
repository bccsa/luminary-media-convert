<script setup lang="ts">
/**
 * The Luminary web player on Video.js 10: `player-core` playback inside controls laid out for it.
 *
 * A `PlayerController` over an `HlsJsVideoAdapter` munges the master (LMCENC decrypt, angle
 * extraction, quality capping) and hands hls.js a blob playlist plus an in-memory key. The chrome is
 * composed here from v10's `media-*` elements rather than taken from its packaged skin, because the
 * packaged skin's control set is fixed: it has no skip buttons, no way to leave a menu out and no
 * bare windowed frame. The default skin's stylesheet still draws the buttons, icons and menus.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
// The elements and icons the controls use, and no others; see the module for why not the packaged skin.
import '../ui/register';
import {
    AUDIO_ONLY_ANGLE_ID,
    PlayerController,
    chapterIndexAt,
    chapterSegments,
    findPreferredTrack,
} from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerControllerOptions,
    PlayerError,
    PlayerSource,
    ThumbnailSpriteCue,
} from '@luminary-media-converter/player-core';
import { HlsJsVideoAdapter } from '../adapter/HlsJsVideoAdapter';
import type { HlsJsVideoElement } from '../adapter/hlsTypes';
import { BlobServeStrategy } from '../serve/BlobServeStrategy';
import { usePlayerState } from '../composables/usePlayerState';
import { mergeMessages, type PlayerMessages } from '../messages';
import { mergeControls, type PlayerControlsOptions } from '../controls';
import { createKeepAlive, SILENT_AUDIO_DATA_URI, type KeepAlive } from '../ui/keepAlive';
import { buildControlsHtml } from '../ui/controlsHtml';
import { installAutoHide, type ControlsStore } from '../ui/autoHide';
import { stepVolume } from '../ui/volume';
import { chapterMask, formatChapterOf } from '../ui/chapterBar';
import {
    SCRUB_EDGE_PX,
    clampPreviewCentre,
    formatClock,
    isOnBar,
    pointerRatio,
    previewTimes,
    rosterFineStep,
    rosterStep,
    rosterTiles,
} from '../ui/scrubPreview';
import ScrubThumbnail from './ScrubThumbnail.vue';
import ScrubRoster from './ScrubRoster.vue';
import { imageAttempts, toPlayerImage, type PlayerImageInput } from '../image';
import { isYouTubeUrl } from '../youtube';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /** UI strings merged over the English defaults. */
    messages?: Partial<PlayerMessages>;
    /** Which controls to offer, and how far the skip buttons move. Anything omitted keeps the default. */
    controls?: Partial<PlayerControlsOptions>;
    /**
     * How the picture fills the frame while the player is windowed: `contain` letterboxes a source that is not the
     * frame's shape, `cover` fills the frame and crops what overflows. Fullscreen always letterboxes, whatever
     * this says — it is what fullscreen is for, and a cropped picture there would lose the edges of a screen-shaped
     * view. Set on the element's own `<video>`, which lives in its shadow DOM and so cannot be reached by a host's CSS.
     */
    windowedFit?: 'contain' | 'cover';
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
const containerEl = ref<HTMLElement | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);
const isFullscreen = ref(false);
const frameWidth = ref(0);
let frameObserver: ResizeObserver | null = null;
let keepAlive: KeepAlive | null = null;
let removeAutoHide: (() => void) | null = null;

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const mergedControls = computed(() => mergeControls(props.controls));
const isYouTube = computed(() => isYouTubeUrl(props.source.masterUrl));

/** Element ids in the controls (menu triggers point at their menus by id) must not collide between players. */
const instanceId = `lmpl-${Math.random().toString(36).slice(2, 9)}`;
const controlsHtml = computed(() => buildControlsHtml(mergedControls.value, instanceId));

/**
 * Clicking the picture plays and pauses, and a touch brings the controls up. A bare windowed frame
 * answers neither: the host's own interface is the transport, and a frame that also answered clicks
 * would be a second one. Fullscreen has no other transport, so it answers both.
 */
const gesturesOn = computed(() => mergedControls.value.windowedControls || isFullscreen.value);

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

/**
 * Listens to the element's audio and text track lists, for a choice made in the player's own menus.
 * `<hlsjs-video>` builds new lists with each engine and has none before one exists, so this runs on every
 * load, not once at mount: bound once, a language picked in the card would reach the engine but never the
 * controller, and the player's state would go on saying English.
 */
function bindTrackLists(): void {
    audioTrackList?.removeEventListener('change', onEngineAudioTrackChange);
    textTrackList?.removeEventListener('change', onEngineTextTrackChange);
    const media = mediaEl.value;
    audioTrackList = media?.audioTracks as unknown as EventTarget | undefined;
    textTrackList = media?.textTracks as unknown as EventTarget | undefined;
    audioTrackList?.addEventListener('change', onEngineAudioTrackChange);
    textTrackList?.addEventListener('change', onEngineTextTrackChange);
}

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

    on('loadstart', bindTrackLists);
    bindTrackLists();
    applyFit();
    on('loadstart', applyFit);

    const frame = playerEl.value;
    if (frame && typeof ResizeObserver !== 'undefined') {
        frameObserver = new ResizeObserver(([entry]) => {
            if (entry) frameWidth.value = entry.contentRect.width;
        });
        frameObserver.observe(frame);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    if (containerEl.value) removeAutoHide = installAutoHide(containerEl.value, store, undefined, () => pin.value !== null);
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
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    removeAutoHide?.();
    removeAutoHide = null;
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

interface PlayerStore extends ControlsStore {
    requestFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
    volume: number;
    muted: boolean;
    setVolume(volume: number): number;
    setMuted(muted: boolean): boolean;
}

const store = (): PlayerStore | undefined => (playerEl.value as unknown as { store?: PlayerStore } | null)?.store;

/** The `<video>` the element renders into; see {@link HlsJsVideoAdapter}'s own lookup for why it is found this way. */
function innerVideo(): HTMLVideoElement | null {
    const el = mediaEl.value as unknown as { target?: HTMLVideoElement | null; shadowRoot?: ShadowRoot | null } | null;
    return el?.target ?? el?.shadowRoot?.querySelector('video') ?? null;
}

function applyFit(): void {
    const video = innerVideo();
    if (video) video.style.objectFit = isFullscreen.value ? 'contain' : (props.windowedFit ?? 'contain');
}

watch([isFullscreen, () => props.windowedFit], applyFit);

function onFullscreenChange(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    isFullscreen.value = (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
    // Fullscreen is always landscape: portrait is the host app's own page. A guarded no-op where the
    // browser cannot lock (iOS Safari), and the lock is let go when fullscreen ends.
    const orientation = (screen as Screen & { orientation?: { lock?: (type: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (isFullscreen.value) void orientation?.lock?.('landscape')?.catch(() => {});
    else orientation?.unlock?.();
    // A control clicked in fullscreen keeps focus once the bare frame hides it again, and a focused
    // control swallows every key but Tab: the host's shortcuts would stay dead until something else
    // took focus.
    if (isFullscreen.value || mergedControls.value.windowedControls) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && containerEl.value?.contains(active)) active.blur();
}

/**
 * The volume card's plus and minus buttons, caught on the container rather than bound one by one:
 * the controls are markup, not Vue elements, and a card in the top layer is still inside it for events.
 * Raising the volume of a muted player unmutes it, which is what pressing plus means.
 */
function onControlsClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-volume-step]') : null;
    const player = store();
    if (!target || !player) return;
    const media = mediaEl.value;
    if (!media) return;
    const direction = target.dataset.volumeStep === '-1' ? -1 : 1;
    // Read and written on the element, which is the truth: the store follows it a moment later, and a
    // press in that moment would step from a volume that is already out of date, or ask the store to unmute
    // a player it believes is not muted.
    if (direction === 1 && media.muted) media.muted = false;
    player.setVolume(stepVolume(media.volume, direction));
}

/**
 * A double-click toggles fullscreen anywhere on the picture, in both directions. What is refused is a
 * double-click on an actual control, where it is two presses of that control rather than a gesture on
 * the picture. Not v10's own double-tap, which seeks when it lands on the left or right third.
 */
function onFrameDoubleClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.lmpl-cluster, .lmpl-bottom, .media-popup, .lmpl-roster')) return;
    if (isFullscreen.value) exitFullscreen();
    else void enterFullscreen();
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

// --- audio-only -------------------------------------------------------------

/** Whether the picture is off — the audio-only rendering is what is playing. Read from the controller, so it survives a reload. */
const isAudioOnly = computed(
    () =>
        controller.value !== null &&
        (state.value.isAudioOnly || state.value.activeAngleId === AUDIO_ONLY_ANGLE_ID)
);

// --- scrub preview ----------------------------------------------------------

interface ScrubState {
    cue: ThumbnailSpriteCue | null;
    label: string;
    /** The time the pointer names, in seconds. */
    time: number;
    /** The press is held: the frame under it is where the video would jump to. */
    held: boolean;
    /** Centre of the preview, in px from the container's left edge. */
    left: number;
    /** Gap, in px, between the container's bottom edge and the preview's. */
    bottom: number;
    /** Title of the chapter the previewed moment is in; empty when there are no chapters. */
    chapter: string;
    /** While the press is held, the strip of frames around the playhead that replaces the single frame. */
    roster: {
        tiles: { key: string; left: number; cue: ThumbnailSpriteCue | null }[];
        /** Where the marker sits, in px from the roster's left. */
        markerX: number;
        tileWidth: number;
        /** Gap, in px, between the container's bottom edge and the roster's: none, it rises from the edge over the controls. */
        bottom: number;
        /** How far the roster reaches up: the strip above the timeline's resting place plus everything under it. */
        height: number;
        /** The room between the timeline's resting place and the bottom edge, which the roster covers. */
        gap: number;
        /** Gap, in px, between the container's bottom edge and the time label above the timeline. */
        labelBottom: number;
    } | null;
}

const scrub = shallowRef<ScrubState | null>(null);

/** The title of the chapter a moment is in, or nothing when the video has no chapters or the moment is before the first. */
function chapterTitleAt(time: number): string {
    const chapters = state.value.chapters;
    const index = chapterIndexAt(chapters, time);
    return index < 0 ? '' : (chapters[index]?.title ?? '');
}

/** The timeline cut at the chapter starts; one plain bar when there are fewer than two chapters. */
const chapterBarMask = computed(() => chapterMask(chapterSegments(state.value.chapters, state.value.duration)));

/** "Chapter 4 of 7" above the timeline, for the chapter the playhead is in; nothing without chapters. */
const chapterNowText = computed(() => {
    const chapters = state.value.chapters;
    if (chapters.length < 2) return '';
    const index = chapterIndexAt(chapters, state.value.currentTime);
    if (index < 0) return '';
    const title = chapters[index]?.title ?? '';
    return `${formatChapterOf(msg.value.chapterOf, index + 1, chapters.length)}${title ? ` · ${title}` : ''}`;
});
watch(
    chapterNowText,
    (text) => {
        const el = containerEl.value?.querySelector<HTMLElement>('.lmpl-chapter-now');
        if (!el) return;
        el.textContent = text;
        el.hidden = !text;
    },
    { flush: 'post' }
);

/**
 * Scales with the player, like the controls: a thumbnail sized for a phone is a stamp on a 2000px screen.
 * A sixth of the width, between the 168px the Video.js 8 player used and a size past which the sprite's own
 * 160px frames only blur.
 */
const scrubWidth = computed(() => Math.round(Math.min(340, Math.max(168, frameWidth.value / 6))));

/** Room the preview keeps above the bar. */
const SCRUB_GAP_PX = 14;

/** Room between the timeline and its time label. */
const LABEL_GAP_PX = 8;

/**
 * The slider is taller than the track it draws, so the track sits this far, per unit of the controls' scale,
 * above the slider's bottom edge. The timeline lifts by the roster's height less this, so its track rests
 * against the roster's top rather than floating above it.
 */
const TRACK_INSET_PX = 12.5;

/**
 * The roster's height: that of the frame the hover preview shows, so the picture does not change size
 * between hovering the timeline and holding it. Frames are 16:9.
 */
const rosterHeight = computed(() => Math.round((scrubWidth.value * 9) / 16));

/** Whether a roster is on show: the timeline has made way for it, so the layout follows this and not the pointer. */
const rosterShown = computed(() => scrub.value?.roster != null || pin.value !== null);

function hideScrub(): void {
    if (scrub.value) scrub.value = null;
}

/**
 * Whether a press that began on the bar is still held. Tracked here rather than read from Video.js's
 * `data-dragging`, and not inferred from pointer capture: engines differ in both, and a drag that wanders
 * off the bar must keep its preview for as long as the button is down, wherever the pointer goes.
 */
let scrubbing = false;

/** The press ended, or was taken from us: nothing is being scrubbed any more. */
function endScrub(event?: PointerEvent): void {
    scrubbing = false;
    // A press that opened the roster leaves it open: the viewer lifted a finger to look, not to be done.
    const roster = scrub.value?.roster;
    if (roster && event?.type === 'pointerup') {
        pin.value = { bottom: roster.bottom, labelBottom: roster.labelBottom, gap: roster.gap };
        pinAnchor.value = scrub.value?.time ?? null;
        armAnchorTimeout();
    }
    hideScrub();
}

/**
 * Follows the pointer over, or dragging, the timeline: where the viewer is about to land, which is not
 * where the video is. Driven from the container's pointer events rather than the slider's own, because
 * they cover a mouse hovering and a finger dragging alike, and a dragged slider holds the pointer
 * captured, so its events keep arriving after the pointer has left it.
 *
 * Offered only once there are frames to show: without them the timeline's own time readout stays.
 */
function updateScrub(event: PointerEvent): void {
    // The pinned roster is dragged by its own handlers; what happens on it is not a press on the timeline.
    if (event.target instanceof Element && event.target.closest('.lmpl-roster')) return;
    const container = containerEl.value;
    const slider = container?.querySelector<HTMLElement>('.lmpl-time-slider');
    const media = mediaEl.value;
    const instance = controller.value;
    if (!container || !slider || !media || !instance || !state.value.thumbnailsReady) return hideScrub();

    // Live has no length to scrub across.
    const duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0) return hideScrub();

    const bar = slider.getBoundingClientRect();
    const onBar = isOnBar(event.clientX, event.clientY, bar);
    // A press anywhere but the roster and the timeline (the fast way, which the roster is there to refine) closes a pinned roster.
    if (event.type === 'pointerdown' && pin.value && !onBar) closePin();
    if (event.type === 'pointerdown' && onBar) scrubbing = true;
    if (!scrubbing && !slider.hasAttribute('data-dragging') && !onBar) return hideScrub();

    const ratio = pointerRatio(event.clientX, bar);
    if (ratio === null) return hideScrub();
    const { time, lookup } = previewTimes(ratio, duration);

    const frame = container.getBoundingClientRect();
    const held = scrubbing || slider.hasAttribute('data-dragging');
    // With a roster pinned, hovering the bar has nothing to add: it is already showing the frames.
    if (pin.value && !held) return hideScrub();
    // The timeline slides up out of the way while held, so its resting position is read only when it is at rest.
    if (!rosterShown.value) {
        restBarTop = bar.top;
        restBarBottom = bar.bottom;
    }
    const roster =
        held && mergedControls.value.scrubRoster
            ? buildRoster(instance, time, event.clientX - frame.left, frame.width, duration, rosterStep(duration), frame.bottom - restBarBottom)
            : null;
    scrub.value = {
        // A lookup that lands in a gap in the cues keeps the frame already on show: a preview that blanks
        // for a moment between two frames reads as a fault, and a stale frame a hair away is not.
        cue: instance.thumbnailAt(lookup) ?? scrub.value?.cue ?? null,
        label: formatClock(time, duration >= 3600),
        chapter: chapterTitleAt(time),
        time,
        held,
        left: clampPreviewCentre(event.clientX - frame.left, scrubWidth.value, SCRUB_EDGE_PX, frame.width - SCRUB_EDGE_PX),
        bottom: frame.bottom - bar.top + SCRUB_GAP_PX,
        roster: roster && {
            tiles: roster.tiles,
            markerX: roster.markerX,
            tileWidth: roster.tileWidth,
            bottom: 0,
            height: roster.height,
            gap: frame.bottom - restBarBottom,
            labelBottom:
                frame.bottom -
                (restBarTop - (rosterHeight.value - TRACK_INSET_PX * controlsScale(slider))) +
                LABEL_GAP_PX,
        },
    };
}

/**
 * The scrubbed frame drawn over the whole picture. A crop of a sheet cannot be `cover`ed directly, so the
 * element is the crop's own size and scaled up to the frame, as the hover thumbnail is scaled to its width.
 */
function pictureStyle(cue: ThumbnailSpriteCue): Record<string, string> {
    if (!cue.w || !cue.h) {
        return {
            width: '100%',
            height: '100%',
            backgroundImage: `url("${cue.spriteUrl}")`,
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
        };
    }
    const frame = containerEl.value?.getBoundingClientRect();
    const scale = frame ? Math.min(frame.width / cue.w, frame.height / cue.h) : 1;
    return {
        width: `${cue.w}px`,
        height: `${cue.h}px`,
        backgroundImage: `url("${cue.spriteUrl}")`,
        backgroundPosition: `-${cue.x}px -${cue.y}px`,
        backgroundRepeat: 'no-repeat',
        transform: `scale(${scale})`,
        transformOrigin: 'center',
    };
}

/** The frame laid over the picture: the one a held press names, or the one a pinned roster is dragged to. */
const pictureCue = computed(() => {
    if (!mergedControls.value.scrubPicture) return null;
    if (scrub.value?.held) return scrub.value.cue;
    return pinDrag.value?.moved ? (pinnedView.value?.cue ?? null) : null;
});

/** The controls' current scale, which grows with the player's width. */
function controlsScale(el: Element): number {
    return parseFloat(getComputedStyle(el).getPropertyValue('--lmpl-s')) || 1;
}

/** Where the timeline's top and bottom edges sat before it made way for the roster. */
let restBarTop = 0;
let restBarBottom = 0;

/**
 * The strip of frames for a held press: the tile size comes from the sprite's own frame shape, the marker
 * stays under the pointer, and each slot looks its frame up by the time it stands for.
 */
function buildRoster(
    instance: PlayerControllerApi,
    time: number,
    pointerX: number,
    width: number,
    duration: number,
    step: number,
    gap: number
): {
    tiles: { key: string; left: number; cue: ThumbnailSpriteCue | null }[];
    markerX: number;
    tileWidth: number;
    height: number;
    step: number;
} | null {
    const sample = instance.thumbnailAt(0);
    if (!sample || !sample.w || !sample.h) return null;
    // The roster rises from the bottom edge over the controls, and its frames fill all of that.
    const height = rosterHeight.value + gap;
    const tileWidth = Math.max(24, Math.round((height * sample.w) / sample.h));
    const markerX = Math.min(width, Math.max(0, pointerX));
    const tiles = rosterTiles(time, markerX, width, tileWidth, step, duration).map((tile) => ({
        // A different step makes the same index a different slot, so the step is part of the identity.
        key: `${step}:${tile.index}`,
        left: tile.left,
        cue: instance.thumbnailAt(tile.time),
    }));
    return { tiles, markerX, tileWidth, height, step };
}


// --- pinned roster ------------------------------------------------------------

/**
 * A roster left open after the press ends. It is centred on the playhead and follows playback, and it can
 * itself be dragged, the slow and precise way through the video (the timeline is the fast one): the strip moves with the finger,
 * the picture shows the frame it is passing, and the video goes there when the finger comes up. A tap on a
 * frame goes to that frame. It stays until closed — a press outside it, a new source, or a change of layout.
 */
const pin = shallowRef<{ bottom: number; labelBottom: number; gap: number } | null>(null);

interface PinDrag {
    startX: number;
    lastX: number;
    time: number;
    moved: boolean;
}
const pinDrag = shallowRef<PinDrag | null>(null);

/** The playhead, read every frame while a roster is pinned: `timeupdate` is a few times a second, which steps the strip. */
const pinNow = ref(0);
let pinFrame = 0;

function trackPlayhead(): void {
    const media = mediaEl.value;
    if (media && Number.isFinite(media.currentTime)) pinNow.value = media.currentTime;
    pinFrame = requestAnimationFrame(trackPlayhead);
}

watch(
    () => pin.value !== null,
    (open) => {
        cancelAnimationFrame(pinFrame);
        if (open) trackPlayhead();
    }
);
onBeforeUnmount(() => cancelAnimationFrame(pinFrame));

/** Where the roster stays, after a seek, until the video has caught up; else it would snap back to the old time. */
const pinAnchor = ref<number | null>(null);
let anchorTimer: ReturnType<typeof setTimeout> | undefined;

function armAnchorTimeout(): void {
    if (anchorTimer) clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => (pinAnchor.value = null), 1500);
}

watch(pinNow, (now) => {
    if (pinAnchor.value !== null && Math.abs(now - pinAnchor.value) < 0.75) pinAnchor.value = null;
});

function closePin(): void {
    pin.value = null;
    pinDrag.value = null;
    pinAnchor.value = null;
    if (anchorTimer) clearTimeout(anchorTimer);
}

watch([isFullscreen, frameWidth, () => props.source], closePin);
onBeforeUnmount(() => anchorTimer && clearTimeout(anchorTimer));

const pinnedView = computed(() => {
    const placed = pin.value;
    const instance = controller.value;
    const duration = state.value.duration;
    const width = frameWidth.value;
    if (!placed || scrub.value?.roster || !instance || !(duration > 0) || !(width > 0)) return null;
    const drag = pinDrag.value;
    const time = drag?.time ?? pinAnchor.value ?? pinNow.value;
    const step = rosterFineStep(duration);
    const built = buildRoster(instance, time, width / 2, width, duration, step, placed.gap);
    if (!built) return null;
    return {
        ...built,
        ...placed,
        time,
        label: formatClock(time, duration >= 3600),
        chapter: chapterTitleAt(time),
        cue: instance.thumbnailAt(Math.min(time, Math.max(0, duration - 0.001))),
    };
});

function onPinDown(event: PointerEvent): void {
    const view = pinnedView.value;
    if (!view) return;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    pinDrag.value = {
        startX: event.clientX,
        lastX: event.clientX,
        time: view.time,
        moved: false,
    };
}

function onPinMove(event: PointerEvent): void {
    const drag = pinDrag.value;
    const duration = state.value.duration;
    if (!drag || !(duration > 0)) return;
    const view = pinnedView.value;
    if (!view) return;
    // The strip follows the finger one-to-one, at a scale that never changes during the drag.
    const time = drag.time - (event.clientX - drag.lastX) / (view.tileWidth / view.step);
    pinDrag.value = {
        ...drag,
        lastX: event.clientX,
        time: Math.min(Math.max(0, time), Math.max(0, duration - 0.001)),
        moved: drag.moved || Math.abs(event.clientX - drag.startX) > 4,
    };
}

function onPinUp(event: PointerEvent): void {
    const drag = pinDrag.value;
    const view = pinnedView.value;
    pinDrag.value = null;
    if (!drag || !view || event.type !== 'pointerup') return;
    let target = drag.time;
    if (!drag.moved) {
        // A tap: the frame under the finger, read off the strip's own scale.
        const frame = containerEl.value?.getBoundingClientRect();
        const duration = state.value.duration;
        target = view.time + (event.clientX - (frame?.left ?? 0) - view.markerX) / (view.tileWidth / view.step);
        target = Math.min(Math.max(0, target), Math.max(0, duration - 0.001));
    }
    pinAnchor.value = target;
    armAnchorTimeout();
    seek(target);
}

/**
 * Fetches the first sprite sheet the moment there is one, so the first hover is not a blank frame
 * waiting on an image. Later sheets load as the pointer reaches them.
 */
watch(
    () => state.value.thumbnailsReady,
    (ready) => {
        if (!ready) return;
        const first = controller.value?.thumbnailAt(0);
        if (first) new Image().src = first.spriteUrl;
    }
);

watch(
    () => props.source,
    () => hideScrub()
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
    <div
        class="lmpl-root"
        :class="{
            'lmpl-windowed-bare': !mergedControls.windowedControls,
            'lmpl-is-fullscreen': isFullscreen,
            'lmpl-has-quality-choice': state.qualities.length > 1,
            'lmpl-has-audio-choice': state.audioTracks.length > 1,
            'lmpl-has-subtitles': state.subtitleTracks.length > 0,
            'lmpl-has-thumbs': state.thumbnailsReady,
            'lmpl-scrubbing': rosterShown,
            'lmpl-previewing': scrub !== null,
        }"
        :style="{
            '--lmpl-roster-h': `${rosterHeight}px`,
            '--lmpl-track-inset': `${TRACK_INSET_PX}px`,
            '--lmpl-chapter-mask': chapterBarMask || undefined,
        }"
    >
        <video-player ref="playerEl" class="lmpl-video-player">
            <media-container
                ref="containerEl"
                class="media-skin media-container lmpl-container"
                data-theme="default"
                data-preset="video"
                @dblclick="onFrameDoubleClick"
                @click="onControlsClick"
                @pointermove="updateScrub"
                @pointerdown.capture="updateScrub"
                @pointerleave="hideScrub"
                @pointerup.capture="endScrub"
                @pointercancel.capture="endScrub"
            >
                <!-- Inside the container, so the artwork goes fullscreen with the picture. -->
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
                <hlsjs-video ref="mediaEl" class="lmpl-media" playsinline preload="auto"></hlsjs-video>

                <media-gesture v-if="gesturesOn" type="tap" action="togglePaused" pointer="mouse" region="center"></media-gesture>
                <media-gesture v-if="gesturesOn" type="tap" action="toggleControls" pointer="touch"></media-gesture>

                <media-controls class="lmpl-controls" v-html="controlsHtml"></media-controls>

                <!-- While held, the frame being scrubbed over the picture: a fast-forward, VHS style. -->
                <div v-if="pictureCue" class="lmpl-scrub-picture" aria-hidden="true">
                    <div class="lmpl-scrub-picture-frame" :style="pictureStyle(pictureCue)"></div>
                </div>

                <div
                    v-if="scrub && !scrub.roster"
                    class="lmpl-scrub-preview"
                    :style="{ left: `${scrub.left}px`, bottom: `${scrub.bottom}px` }"
                >
                    <ScrubThumbnail :cue="scrub.cue" :label="scrub.label" :chapter="scrub.chapter" :width="scrubWidth" />
                </div>
                <template v-if="pinnedView">
                    <ScrubRoster
                        :tiles="pinnedView.tiles"
                        :tile-width="pinnedView.tileWidth"
                        :height="pinnedView.height"
                        :marker-x="pinnedView.markerX"
                        :bottom="pinnedView.bottom"
                        interactive
                        @pointerdown.stop="onPinDown"
                        @pointermove.stop="onPinMove"
                        @pointerup.stop="onPinUp"
                        @pointercancel.stop="onPinUp"
                        @click.stop
                    />
                    <div
                        class="lmpl-scrub-preview lmpl-scrub-label"
                        :style="{ left: `${pinnedView.markerX}px`, bottom: `${pinnedView.labelBottom}px` }"
                    >
                        <span class="lmpl-thumb-time"
                            >{{ pinnedView.label }}<span v-if="pinnedView.chapter" class="lmpl-thumb-chapter">{{ pinnedView.chapter }}</span></span
                        >
                    </div>
                </template>
                <template v-if="scrub?.roster">
                    <ScrubRoster
                        :tiles="scrub.roster.tiles"
                        :tile-width="scrub.roster.tileWidth"
                        :height="scrub.roster.height"
                        :marker-x="scrub.roster.markerX"
                        :bottom="scrub.roster.bottom"
                    />
                    <div
                        class="lmpl-scrub-preview lmpl-scrub-label"
                        :style="{ left: `${scrub.left}px`, bottom: `${scrub.roster.labelBottom}px` }"
                    >
                        <span class="lmpl-thumb-time"
                            >{{ scrub.label }}<span v-if="scrub.chapter" class="lmpl-thumb-chapter">{{ scrub.chapter }}</span></span
                        >
                    </div>
                </template>
            </media-container>
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
    </div>
</template>

<style>
/*
 * Stylesheet order is load-bearing: the default skin's rules come first and `styles.css` overrides
 * them. They are `@import`ed from a style block rather than `import`ed from a script, because
 * TypeScript preserves a side-effect `import` in the emitted `.d.ts`, where a consumer type-checking
 * with `skipLibCheck: false` then fails to resolve `.css`.
 */
@import '../generated/skin.css';
@import '../styles.css';
</style>
