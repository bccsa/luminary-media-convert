<script setup lang="ts">
/**
 * The native player's host component: the same props, emits and exposed surface as `player-web`'s
 * `LuminaryPlayer`, so a host swaps one for the other through `virtual:video-player` alone.
 *
 * Bridge v1 shows video only in native full-screen, so inline this is the host's poster with a play
 * button that plays and presents; audio plays inline.
 */
import { computed, inject, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import {
    createInitialState,
    type PlayerController,
    type PlayerError,
    type PlayerSource,
    type PlayerState,
} from '@luminary-media-converter/player-core';
import { createNativePlayer, type NativePlayer } from '@luminary-media-converter/player-native';
import { AppResumeKey, NativePluginKey } from './nativePlugin';

const props = defineProps<{
    source: PlayerSource;
    poster?: string;
    preferredLanguage?: string;
}>();

const emit = defineEmits<{
    timeupdate: [currentTime: number, duration: number];
    loadedmetadata: [];
    ended: [];
}>();

const plugin = inject(NativePluginKey)!;
const onAppResume = inject(AppResumeKey, undefined);

const native = shallowRef<NativePlayer | null>(null);
const live = shallowRef<Readonly<PlayerState>>(createInitialState());
const startError = shallowRef<PlayerError | null>(null);
const presentation = shallowRef<'inline' | 'fullscreen' | 'pip'>('inline');
const controller = computed<PlayerController | null>(() => native.value?.controller ?? null);

/** The controller's state; a player that could not even be created says so the same way. */
const state = computed<Readonly<PlayerState>>(() =>
    startError.value ? { ...live.value, lifecycle: 'error', error: startError.value } : live.value,
);

let unmounted = false;
const teardowns: (() => void)[] = [];

onMounted(async () => {
    let created: NativePlayer;
    try {
        created = await createNativePlayer({
            plugin,
            onAppResume,
            controller: { prefetch: { enabled: false } },
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
        plugin.addListener('loadedmetadata', (payload) => mine(payload) && emit('loadedmetadata')),
        plugin.addListener('presentationchange', (payload) => {
            if (mine(payload)) presentation.value = payload.state;
        }),
    ];
    teardowns.push(() => listeners.forEach((listening) => void listening.then((listener) => listener.remove())));
    await created.controller.load(props.source);
});

watch(
    () => props.source,
    (source) => void controller.value?.load(source),
);

onBeforeUnmount(() => {
    unmounted = true;
    teardowns.splice(0).forEach((teardown) => teardown());
    controller.value?.destroy();
});

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
    if (native.value) await plugin.enterFullscreen({ playerId: native.value.playerId });
}
async function exitFullscreen() {
    if (native.value) await plugin.exitFullscreen({ playerId: native.value.playerId });
}
/** Video plays in native full-screen; audio-only has no view, so it just plays where it is. */
async function playFromPoster() {
    await play();
    if (!state.value.isAudioOnly) await enterFullscreen();
}

const caption = computed(() => {
    const s = state.value;
    if (s.lifecycle === 'error') return s.error?.message ?? 'Error';
    if (s.lifecycle !== 'ready') return s.lifecycle;
    const time = `${s.currentTime.toFixed(1)} / ${Number.isFinite(s.duration) ? s.duration.toFixed(1) : 'live'} s`;
    return `${s.playing ? 'playing' : 'paused'} · ${time} · ${presentation.value}`;
});

defineExpose({ controller, state, play, pause, seek, enterFullscreen, exitFullscreen });
</script>

<template>
    <div class="native-player">
        <img v-if="poster" class="native-player__poster" :src="poster" alt="" />
        <!-- Audio-only shows the poster under a note, as the web player does. -->
        <svg v-if="state.isAudioOnly" class="native-player__glyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z" />
        </svg>
        <button
            class="native-player__play"
            type="button"
            :disabled="state.lifecycle !== 'ready'"
            aria-label="Play"
            @click="playFromPoster"
        >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        </button>
        <div class="native-player__caption">{{ caption }}</div>
    </div>
</template>

<style scoped>
.native-player {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    overflow: hidden;
}
.native-player__poster {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.8;
}
.native-player__glyph {
    position: absolute;
    inset: 22% auto auto 50%;
    transform: translateX(-50%);
    width: 4rem;
    height: 4rem;
    fill: rgba(255, 255, 255, 0.85);
    filter: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.55));
}
.native-player__play {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: 72px;
    height: 72px;
    border: none;
    border-radius: 50%;
    background: rgba(28, 28, 30, 0.9);
    fill: #fff;
    display: grid;
    place-items: center;
}
.native-player__play svg {
    width: 36px;
    height: 36px;
}
.native-player__play:disabled {
    opacity: 0.4;
}
.native-player__caption {
    position: absolute;
    left: 12px;
    bottom: 10px;
    right: 12px;
    font: 12px ui-monospace, Menlo, monospace;
    color: #c7c7cc;
}
</style>
