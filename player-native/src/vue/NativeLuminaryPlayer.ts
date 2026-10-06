/**
 * The native player's host component: the same props, emits and exposed surface as the web
 * `LuminaryPlayer`, so a host swaps one for the other by component alone.
 *
 * Bridge v1 shows video only in native full-screen, so inline this is the host's poster with a
 * play button that plays and presents; audio-only has no view, and plays where it is.
 *
 * Plain `defineComponent` with a render function rather than a single-file component, so the
 * package builds with `tsc` alone.
 */
import {
    computed,
    defineComponent,
    h,
    onBeforeUnmount,
    onMounted,
    shallowRef,
    watch,
    type PropType,
} from 'vue';
import {
    AUDIO_ONLY_ANGLE_ID,
    createInitialState,
    findPreferredTrack,
    type PlayerController,
    type PlayerControllerOptions,
    type PlayerError,
    type PlayerSource,
    type PlayerState,
    type Unsubscribe,
} from '@luminary-media-converter/player-core';
import type { LuminaryPlayerPlugin, NowPlaying } from '../bridge.js';
import { createNativePlayer, type NativePlayer } from '../createNativePlayer.js';
import { LuminaryPlayer } from '../plugin.js';
import { DEFAULT_NATIVE_MESSAGES, errorMessage, type NativePlayerMessages } from './messages.js';
import { VIDEOJS_PLAY_PATH, VIDEOJS_UNITS_PER_EM } from './videoJsIcons.js';

export type NativePresentation = 'inline' | 'fullscreen' | 'pip';

/**
 * A poster as `player-web` takes it: a URL, or what the browser can choose between. `src` is the
 * image the lock screen gets as artwork; `fallback` covers a failed load.
 */
export interface NativePosterImage {
    src?: string;
    srcset?: string;
    sizes?: string;
    fallback?: string;
}

/** What the default slot is handed, for a host drawing its own overlay on the poster. */
export interface NativeLuminaryPlayerSlotProps {
    state: Readonly<PlayerState>;
    presentation: NativePresentation;
}

/**
 * What a template ref to the component reaches: the web `LuminaryPlayer`'s surface. Typed by
 * hand, since `expose()` in a render-function component does not reach its instance type.
 */
export interface NativeLuminaryPlayerExposed {
    readonly controller: PlayerController | null;
    readonly state: Readonly<PlayerState>;
    /** Native draws the video in this component's frame; see the `inline` prop. */
    readonly inlineActive: boolean;
    /** Resolves false when playback was refused, as the web player's does; it never rejects. */
    play(): Promise<boolean>;
    pause(): void;
    seek(seconds: number): void;
    enterFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
}

/** What a host can switch off, as `player-web`'s `controls` prop. */
export interface NativeLuminaryPlayerControls {
    /** The audio / video toggle at the top right. Default true. */
    audioVideoToggle: boolean;
}

// heroicons, as `player-web` draws them: 24/outline "film" and 24/solid "musical-note".
const FILM_ICON =
    'M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5';
const NOTE_ICON =
    'M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.402-4.909l2.31-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z';

export const NativeLuminaryPlayer = defineComponent({
    name: 'NativeLuminaryPlayer',
    props: {
        source: { type: Object as PropType<PlayerSource>, required: true },
        poster: { type: [String, Object] as PropType<string | NativePosterImage>, default: undefined },
        /**
         * The audio language to select, matched as the web player matches it (`en`, `eng` and
         * `en-US` are one language). Applied when the track list arrives, until the viewer picks
         * another; a new source or a new preference applies it again.
         */
        preferredLanguage: { type: String, default: undefined },
        /** What the lock screen and Control Center show. The poster is the artwork when it has none. */
        nowPlaying: { type: Object as PropType<NowPlaying>, default: undefined },
        /** Strings to override, as `player-web`'s `messages` prop. */
        messages: { type: Object as PropType<Partial<NativePlayerMessages>>, default: undefined },
        /** What the controller is given, as `player-web`'s `controllerOptions`: `fetchImpl`, prefetch. */
        controllerOptions: { type: Object as PropType<Partial<PlayerControllerOptions>>, default: undefined },
        /**
         * Draw the video in this component's own frame, in the page, where native can (the
         * `inlineVideo` capability); the component then draws nothing opaque over it: no poster,
         * no play button, only the error and Coming soon panels. Where native cannot, it is
         * ignored and the component behaves as it always has (poster, play, native full-screen).
         * The page must leave everything behind the frame transparent.
         */
        inline: { type: Boolean, default: false },
        /** Controls to switch off, as `player-web`'s `controls` prop. */
        controls: { type: Object as PropType<Partial<NativeLuminaryPlayerControls>>, default: undefined },
        /** The plugin to drive; the Capacitor one unless a host supplies another. */
        plugin: { type: Object as PropType<LuminaryPlayerPlugin>, default: () => LuminaryPlayer },
        /** See `NativePlayerOptions.onAppResume`. */
        onAppResume: {
            type: Function as PropType<(listener: () => void) => Unsubscribe>,
            default: undefined,
        },
    },
    emits: {
        timeupdate: (_currentTime: number, _duration: number) => true,
        loadedmetadata: () => true,
        ended: () => true,
    },
    setup(props, { emit, expose, slots }) {
        const native = shallowRef<NativePlayer | null>(null);
        const live = shallowRef<Readonly<PlayerState>>(createInitialState());
        const startError = shallowRef<PlayerError | null>(null);
        const presentation = shallowRef<NativePresentation>('inline');
        const controller = computed<PlayerController | null>(() => native.value?.controller ?? null);

        /** The controller's state; a player that could not even be created says so the same way. */
        const state = computed<Readonly<PlayerState>>(() =>
            startError.value ? { ...live.value, lifecycle: 'error', error: startError.value } : live.value,
        );

        /** The one URL the poster stands for: what the lock screen can show. */
        const posterUrl = computed<string | undefined>(() => {
            const poster = props.poster;
            return typeof poster === 'string' ? poster : (poster?.src ?? poster?.fallback);
        });

        const nowPlaying = computed<NowPlaying | undefined>(() => {
            const given = props.nowPlaying;
            if (!given) return undefined;
            return given.artworkUrl || !posterUrl.value ? given : { ...given, artworkUrl: posterUrl.value };
        });

        let unmounted = false;
        const teardowns: (() => void)[] = [];

        onMounted(async () => {
            let created: NativePlayer;
            try {
                created = await createNativePlayer({
                    plugin: props.plugin,
                    onAppResume: props.onAppResume,
                    controller: props.controllerOptions,
                });
            } catch (error) {
                startError.value = {
                    code: 'unknown',
                    fatal: true,
                    message: `The native player could not start: ${(error as Error)?.message ?? String(error)}`,
                    cause: error,
                };
                return;
            }
            if (unmounted) {
                created.controller.destroy();
                return;
            }
            native.value = created;

            let lastTime = -1;
            let ended = false;
            teardowns.push(
                created.controller.subscribe((next) => {
                    live.value = next;
                    if (next.currentTime !== lastTime) {
                        lastTime = next.currentTime;
                        emit('timeupdate', next.currentTime, next.duration);
                    }
                    if (next.ended && !ended) emit('ended');
                    ended = next.ended;
                }),
            );
            // The adapter leaves these two to the host component, which listens on the plugin itself.
            const mine = (payload: { playerId: string }) => payload.playerId === created.playerId;
            const listeners = [
                props.plugin.addListener('loadedmetadata', (payload) => mine(payload) && emit('loadedmetadata')),
                props.plugin.addListener('presentationchange', (payload) => {
                    if (mine(payload)) presentation.value = payload.state;
                }),
            ];
            teardowns.push(() => listeners.forEach((listening) => void listening.then((listener) => listener.remove())));
            // Sent with the load, so it is set before it.
            created.adapter.setNowPlaying(nowPlaying.value);
            await created.controller.load(props.source);
        });

        watch(
            () => props.source,
            (source) => void controller.value?.load(source),
        );
        // Takes effect with the next load: the bridge carries it on `load`.
        watch(nowPlaying, (next) => native.value?.adapter.setNowPlaying(next));

        // --- video inside the page ---------------------------------------------------------------

        const rootEl = shallowRef<HTMLElement | null>(null);
        /** Native draws the video here, and the component stays out of its way. */
        const inlineActive = computed(() => props.inline && native.value?.adapter.inlineVideo === true);
        let sentFrame = '';
        let measureQueued = false;

        /** Tells native where the video goes: this element's frame, or nothing in audio-only. */
        function sendFrame(): void {
            measureQueued = false;
            const adapter = native.value?.adapter;
            const el = rootEl.value;
            if (!adapter || !inlineActive.value) return;
            const rect = el?.getBoundingClientRect();
            const frame =
                rect && rect.width > 0 && rect.height > 0 && !state.value.isAudioOnly
                    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
                    : null;
            const key = frame ? `${frame.x},${frame.y},${frame.width},${frame.height}` : '';
            if (key === sentFrame) return;
            sentFrame = key;
            adapter.setInlineFrame(frame);
        }
        /** At most once per frame: scrolling and transitions report in bursts. */
        function queueFrame(): void {
            if (measureQueued) return;
            measureQueued = true;
            requestAnimationFrame(sendFrame);
        }

        const frameWatchers: (() => void)[] = [];
        watch(
            [inlineActive, rootEl],
            ([active, el]) => {
                frameWatchers.splice(0).forEach((stop) => stop());
                if (!active || !el) return;
                const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queueFrame);
                observer?.observe(el);
                window.addEventListener('resize', queueFrame);
                // Capture: the page scrolls inside containers, which do not bubble `scroll`.
                window.addEventListener('scroll', queueFrame, true);
                window.addEventListener('transitionend', queueFrame, true);
                frameWatchers.push(() => {
                    observer?.disconnect();
                    window.removeEventListener('resize', queueFrame);
                    window.removeEventListener('scroll', queueFrame, true);
                    window.removeEventListener('transitionend', queueFrame, true);
                });
                queueFrame();
            },
            { flush: 'post' },
        );
        // Audio-only has no picture: the frame goes, and comes back with the video.
        watch(() => state.value.isAudioOnly, queueFrame);

        onBeforeUnmount(() => {
            frameWatchers.splice(0).forEach((stop) => stop());
            native.value?.adapter.setInlineFrame(null);
            sentFrame = '';
        });

        onBeforeUnmount(() => {
            unmounted = true;
            teardowns.splice(0).forEach((teardown) => teardown());
            controller.value?.destroy();
        });

        // --- preferred audio language: the web player's rule ---------------------------------

        /** The track the rule last selected, and whether the viewer has since picked another. */
        let autoAppliedTrackId: string | null = null;
        let preferredSuspended = false;

        function applyPreferredLanguage(): void {
            const active = controller.value;
            const preferred = props.preferredLanguage;
            if (preferredSuspended || !active || !preferred) return;
            const current = state.value;
            const target = findPreferredTrack(current.audioTracks, preferred);
            if (!target) return;
            autoAppliedTrackId = target;
            if (target !== current.activeAudioTrackId) active.setAudioTrack(target);
        }

        // Declared before the watchers that apply, so a new preference is applied rather than
        // swallowed by a suspension the old one earned.
        watch([() => props.source, () => props.preferredLanguage], () => {
            preferredSuspended = false;
            autoAppliedTrackId = null;
        });

        // A selection among the tracks already on offer that the rule did not make, and that is
        // not the preferred language either, is the viewer's: stand down. An active track that
        // arrives with a new list is the engine's default, not a choice.
        watch(
            [() => state.value.activeAudioTrackId, () => state.value.audioTracks],
            ([id, tracks], [, previousTracks]) => {
                if (tracks !== previousTracks || preferredSuspended || !id) return;
                const preferred = props.preferredLanguage;
                if (!preferred || id === autoAppliedTrackId) return;
                if (id === findPreferredTrack(tracks, preferred)) return;
                preferredSuspended = true;
            },
        );

        watch([() => state.value.audioTracks, () => props.preferredLanguage], applyPreferredLanguage);

        /**
         * As `player-web`'s: a refusal is an outcome, not an exception, so the caller can leave
         * the poster up rather than handle a rejection. `void player.play()` is how hosts call it.
         */
        async function play(): Promise<boolean> {
            try {
                await controller.value?.play();
                return true;
            } catch {
                return false;
            }
        }
        function pause() {
            controller.value?.pause();
        }
        function seek(seconds: number) {
            controller.value?.seek(seconds);
        }
        // A refused presentation is reported, not thrown: a player another create has replaced
        // rejects every call, and nothing on the page would catch it.
        async function enterFullscreen() {
            if (native.value) await report('enterFullscreen', props.plugin.enterFullscreen({ playerId: native.value.playerId }));
        }
        async function exitFullscreen() {
            if (native.value) await report('exitFullscreen', props.plugin.exitFullscreen({ playerId: native.value.playerId }));
        }
        function report(method: string, call: Promise<void>): Promise<void> {
            return call.catch((error: unknown) => console.warn(`[luminary-native] ${method} failed`, error));
        }
        /** Video plays in native full-screen; audio-only has no view, so it just plays where it is. */
        async function playFromPoster() {
            await play();
            if (!state.value.isAudioOnly) await enterFullscreen();
        }

        // An error, or a source that is not published yet, leaves full-screen on a frozen picture:
        // back to the page, where the panel says what happened (plan 05). Native does the same when
        // its own recovery gives up; this covers what is raised here, such as a reload that cannot
        // fetch, or a new source that is still being encoded.
        watch(
            () => state.value.lifecycle,
            (lifecycle) => {
                if ((lifecycle === 'error' || lifecycle === 'waiting-for-master') && presentation.value !== 'inline') {
                    void exitFullscreen();
                }
            },
        );

        /** Loads the source again: the error panel's "Try again", as on the web. */
        function retry() {
            void controller.value?.load(props.source);
        }

        expose({ controller, state, inlineActive, play, pause, seek, enterFullscreen, exitFullscreen });

        // --- the audio / video toggle: `player-web`'s AudioVideoToggle ----------------------

        // Only strings override: a sparse i18n object with an undefined entry keeps the default,
        // as `player-web`'s `mergeMessages` does.
        const messages = computed<NativePlayerMessages>(() => {
            const merged = { ...DEFAULT_NATIVE_MESSAGES };
            for (const key of Object.keys(DEFAULT_NATIVE_MESSAGES) as (keyof NativePlayerMessages)[]) {
                const value = props.messages?.[key];
                if (typeof value === 'string') merged[key] = value;
            }
            return merged;
        });
        const isAudio = computed(
            () => state.value.isAudioOnly || state.value.activeAngleId === AUDIO_ONLY_ANGLE_ID,
        );
        /** The last real angle seen playing: where the video half returns to. */
        let previousAngleId: string | null = null;
        watch(
            () => state.value.activeAngleId,
            (id) => {
                if (id && id !== AUDIO_ONLY_ANGLE_ID) previousAngleId = id;
            },
            { immediate: true },
        );

        /** Shown when there is an audio-only pseudo-angle, and a video one to come back to. */
        const showToggle = computed(() => {
            if (props.controls?.audioVideoToggle === false || controller.value === null) return false;
            const current = state.value;
            if (current.lifecycle !== 'ready') return false;
            if (!current.angles.some((angle) => angle.id === AUDIO_ONLY_ANGLE_ID)) return false;
            return !isAudio.value || current.angles.some((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
        });

        function toggleAudioVideo() {
            const active = controller.value;
            if (!active) return;
            if (!isAudio.value) {
                void active.setAngle(AUDIO_ONLY_ANGLE_ID);
                return;
            }
            const angles = state.value.angles.filter((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
            const target = previousAngleId ?? angles.find((angle) => angle.isDefault)?.id ?? angles[0]?.id;
            if (target) void active.setAngle(target);
        }

        function toggle() {
            const half = (active: boolean, icon: ReturnType<typeof h>) =>
                h('span', { style: { ...STYLES.toggleHalf, ...(active ? STYLES.toggleHalfActive : {}) } }, [icon]);
            const color = (active: boolean) => (active ? '#ffffff' : '#27272a');
            return h(
                'button',
                {
                    type: 'button',
                    'aria-label': isAudio.value ? messages.value.videoModeLabel : messages.value.audioModeLabel,
                    style: STYLES.toggle,
                    onClick: toggleAudioVideo,
                },
                [
                    half(!isAudio.value, heroicon(FILM_ICON, { ...STYLES.toggleIcon, color: color(!isAudio.value) }, 'stroke')),
                    half(isAudio.value, heroicon(NOTE_ICON, { ...STYLES.toggleIcon, color: color(isAudio.value) }, 'fill')),
                ],
            );
        }

        function panel() {
            const current = state.value;
            if (current.lifecycle === 'waiting-for-master') {
                return (
                    slots['coming-soon']?.({ state: current }) ??
                    h('div', { style: STYLES.panel }, [h('p', { style: STYLES.panelText }, messages.value.comingSoon)])
                );
            }
            if (current.lifecycle === 'error') {
                return (
                    slots.error?.({ state: current, error: current.error, retry }) ??
                    h('div', { style: STYLES.panel }, [
                        h('p', { style: STYLES.panelText }, errorMessage(messages.value, current.error)),
                        // Retrying needs a player; one that could not be created has nothing to retry with.
                        controller.value
                            ? h('button', { type: 'button', style: STYLES.retry, onClick: retry }, messages.value.retry)
                            : null,
                    ])
                );
            }
            return null;
        }

        // The poster's attributes, with the fallback swapped in once the image fails to load.
        const posterBroken = shallowRef(false);
        watch(() => props.poster, () => (posterBroken.value = false));
        const poster = computed(() => {
            const given = props.poster;
            if (!given) return null;
            if (typeof given === 'string') return { src: given };
            if (posterBroken.value) return given.fallback ? { src: given.fallback } : null;
            return { src: given.src ?? given.fallback, srcset: given.srcset, sizes: given.sizes };
        });
        function posterFailed(): void {
            posterBroken.value = true;
        }

        return () => {
            const ready = state.value.lifecycle === 'ready';
            const inline = inlineActive.value;
            return h('div', { class: 'native-luminary-player', style: inline ? STYLES.rootInline : STYLES.root, ref: rootEl }, [
                !inline && poster.value
                    ? h('img', { ...poster.value, alt: '', style: STYLES.poster, onError: posterFailed })
                    : null,
                // Audio-only shows the poster under a note, as the web player does.
                !inline && state.value.isAudioOnly ? heroicon(NOTE_ICON, STYLES.glyph, 'fill') : null,
                ready && !inline
                    ? h(
                          'button',
                          {
                              type: 'button',
                              'aria-label': messages.value.play,
                              style: STYLES.play,
                              onClick: () => void playFromPoster(),
                          },
                          [playGlyph()],
                      )
                    : null,
                h('div', { style: STYLES.slot }, slots.default?.({ state: state.value, presentation: presentation.value })),
                panel(),
                showToggle.value ? toggle() : null,
            ]);
        };
    },
});

/** A heroicon: the outline set strokes, the solid set fills. */
function heroicon(path: string, style: Record<string, string>, paint: 'stroke' | 'fill') {
    const attributes =
        paint === 'stroke'
            ? { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
            : { fill: 'currentColor', 'fill-rule': 'evenodd', 'clip-rule': 'evenodd' };
    return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', style }, [h('path', { d: path, ...attributes })]);
}

/** video.js's play glyph, in font units with y upwards, flipped into the SVG's y-down box. */
function playGlyph() {
    const em = VIDEOJS_UNITS_PER_EM;
    return h('svg', { viewBox: `0 0 ${em} ${em}`, 'aria-hidden': 'true', style: STYLES.playIcon }, [
        h('path', { d: VIDEOJS_PLAY_PATH, transform: `matrix(1 0 0 -1 0 ${em})`, fill: '#ffffff' }),
    ]);
}

/** `player-web`'s windowed frame, measured at phone width (plan 05): `styles.css` and video.js. */
const STYLES = {
    root: { position: 'relative', aspectRatio: '16 / 9', background: '#000', overflow: 'hidden' },
    /** Transparent: native draws the video behind it. */
    rootInline: { position: 'relative', aspectRatio: '16 / 9', background: 'transparent', overflow: 'hidden' },
    poster: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' },
    glyph: {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '4rem',
        height: '4rem',
        transform: 'translate(-50%, -50%)',
        color: 'rgba(255, 255, 255, 0.85)',
        filter: 'drop-shadow(0 1px 6px rgba(0, 0, 0, 0.55))',
    },
    // video.js's big play button: 3 × 1.63332 em at 30 px, corners 0.3 em, the skin's colour.
    play: {
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '90px',
        height: '49px',
        transform: 'translate(-50%, -50%)',
        border: 'none',
        borderRadius: '9px',
        background: 'rgba(39, 39, 42, 0.6)',
        display: 'grid',
        placeItems: 'center',
        padding: '0',
        cursor: 'pointer',
    },
    playIcon: { width: '48px', height: '48px' },
    slot: { position: 'absolute', inset: '0', pointerEvents: 'none' },
    panel: {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.875rem',
        padding: '1.5rem',
        textAlign: 'center',
        background: 'rgba(9, 9, 11, 0.72)',
        boxSizing: 'border-box',
        zIndex: '3',
    },
    panelText: { margin: '0', fontSize: '1rem', lineHeight: '1.4', color: '#fff' },
    retry: {
        appearance: 'none',
        border: '1px solid rgba(255, 255, 255, 0.16)',
        borderRadius: '6px',
        background: 'transparent',
        color: '#fff',
        font: 'inherit',
        padding: '0.45rem 0.9rem',
        cursor: 'pointer',
    },
    toggle: {
        position: 'absolute',
        top: '0.5rem',
        right: '0.5rem',
        zIndex: '4',
        display: 'flex',
        padding: '0',
        border: 'none',
        borderRadius: '0.5rem',
        backgroundColor: 'rgba(113, 113, 122, 0.7)',
        cursor: 'pointer',
    },
    toggleHalf: { display: 'flex', padding: '0.25rem', borderRadius: '0.5rem', backgroundColor: 'transparent' },
    toggleHalfActive: { backgroundColor: 'rgba(24, 24, 27, 0.6)' },
    toggleIcon: { display: 'block', height: '1.5rem', width: '1.5rem' },
} satisfies Record<string, Record<string, string>>;
