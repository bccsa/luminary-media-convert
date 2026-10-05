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
    createInitialState,
    findPreferredTrack,
    type PlayerController,
    type PlayerError,
    type PlayerSource,
    type PlayerState,
    type Unsubscribe,
} from '@luminary-media-converter/player-core';
import type { LuminaryPlayerPlugin, NowPlaying } from '../bridge.js';
import { createNativePlayer, type NativePlayer } from '../createNativePlayer.js';
import { LuminaryPlayer } from '../plugin.js';

export type NativePresentation = 'inline' | 'fullscreen' | 'pip';

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
    play(): Promise<void> | undefined;
    pause(): void;
    seek(seconds: number): void;
    enterFullscreen(): Promise<void>;
    exitFullscreen(): Promise<void>;
}

const PLAY_ICON = 'M8 5.5v13l10.5-6.5z';
const NOTE_ICON = 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3z';

export const NativeLuminaryPlayer = defineComponent({
    name: 'NativeLuminaryPlayer',
    props: {
        source: { type: Object as PropType<PlayerSource>, required: true },
        poster: { type: String, default: undefined },
        /**
         * The audio language to select, matched as the web player matches it (`en`, `eng` and
         * `en-US` are one language). Applied when the track list arrives, until the viewer picks
         * another; a new source or a new preference applies it again.
         */
        preferredLanguage: { type: String, default: undefined },
        /** What the lock screen and Control Center show. The poster is the artwork when it has none. */
        nowPlaying: { type: Object as PropType<NowPlaying>, default: undefined },
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

        const nowPlaying = computed<NowPlaying | undefined>(() => {
            const given = props.nowPlaying;
            if (!given) return undefined;
            return given.artworkUrl || !props.poster ? given : { ...given, artworkUrl: props.poster };
        });

        let unmounted = false;
        const teardowns: (() => void)[] = [];

        onMounted(async () => {
            let created: NativePlayer;
            try {
                created = await createNativePlayer({
                    plugin: props.plugin,
                    onAppResume: props.onAppResume,
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

        function play() {
            return controller.value?.play();
        }
        function pause() {
            controller.value?.pause();
        }
        function seek(seconds: number) {
            controller.value?.seek(seconds);
        }
        async function enterFullscreen() {
            if (native.value) await props.plugin.enterFullscreen({ playerId: native.value.playerId });
        }
        async function exitFullscreen() {
            if (native.value) await props.plugin.exitFullscreen({ playerId: native.value.playerId });
        }
        /** Video plays in native full-screen; audio-only has no view, so it just plays where it is. */
        async function playFromPoster() {
            await play();
            if (!state.value.isAudioOnly) await enterFullscreen();
        }

        expose({ controller, state, play, pause, seek, enterFullscreen, exitFullscreen });

        return () =>
            h('div', { class: 'native-luminary-player', style: STYLES.root }, [
                props.poster ? h('img', { src: props.poster, alt: '', style: STYLES.poster }) : null,
                // Audio-only shows the poster under a note, as the web player does.
                state.value.isAudioOnly ? icon(NOTE_ICON, STYLES.glyph) : null,
                h(
                    'button',
                    {
                        type: 'button',
                        'aria-label': 'Play',
                        disabled: state.value.lifecycle !== 'ready',
                        style: { ...STYLES.play, opacity: state.value.lifecycle === 'ready' ? 1 : 0.4 },
                        onClick: () => void playFromPoster(),
                    },
                    [icon(PLAY_ICON, STYLES.playIcon)],
                ),
                slots.default?.({ state: state.value, presentation: presentation.value }),
            ]);
    },
});

function icon(path: string, style: Record<string, string>) {
    return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', style }, [h('path', { d: path })]);
}

const STYLES = {
    root: { position: 'relative', aspectRatio: '16 / 9', background: '#000', overflow: 'hidden' },
    poster: {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        opacity: '0.8',
    },
    glyph: {
        position: 'absolute',
        inset: '22% auto auto 50%',
        transform: 'translateX(-50%)',
        width: '4rem',
        height: '4rem',
        fill: 'rgba(255, 255, 255, 0.85)',
        filter: 'drop-shadow(0 1px 6px rgba(0, 0, 0, 0.55))',
    },
    play: {
        position: 'absolute',
        inset: '50% auto auto 50%',
        transform: 'translate(-50%, -50%)',
        width: '72px',
        height: '72px',
        border: 'none',
        borderRadius: '50%',
        background: 'rgba(28, 28, 30, 0.9)',
        fill: '#fff',
        display: 'grid',
        placeItems: 'center',
        padding: '0',
    },
    playIcon: { width: '36px', height: '36px' },
} satisfies Record<string, Record<string, string>>;
