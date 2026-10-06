<script setup lang="ts">
/**
 * The lab's native player: `player-native`'s `NativeLuminaryPlayer`, driving the plugin the lab
 * injects (the Capacitor one on a device, the simulated one elsewhere), with the lab's caption
 * drawn over the poster. The exposed surface is the component's, passed through.
 */
import { computed, inject, onMounted, ref, shallowRef } from 'vue';
import { createInitialState, type PlayerSource } from '@luminary-media-converter/player-core';
import {
    NativeLuminaryPlayer,
    type NativeLuminaryPlayerExposed,
    type NativeLuminaryPlayerSlotProps,
} from '@luminary-media-converter/player-native/vue';
import { AppResumeKey, NativePluginKey } from './nativePlugin';

defineProps<{
    source: PlayerSource;
    poster?: string;
    preferredLanguage?: string;
    /** Native draws the video in the page, behind this component: it draws nothing opaque there. */
    inline?: boolean;
}>();

const emit = defineEmits<{
    timeupdate: [currentTime: number, duration: number];
    loadedmetadata: [];
    ended: [];
}>();

const plugin = inject(NativePluginKey)!;
const onAppResume = inject(AppResumeKey, undefined);

const inner = shallowRef<NativeLuminaryPlayerExposed | null>(null);

// Whether native can send playback to a device nearby at all, as the plugin reports it: the host's
// own control only shows while a device is in range, but the lab always offers it, to look for one.
const castSupported = ref(false);
onMounted(() => {
    void plugin.getInfo().then((info) => (castSupported.value = info.capabilities.airPlay === true)).catch(() => {});
});

function caption({ state, presentation }: NativeLuminaryPlayerSlotProps): string {
    if (state.lifecycle === 'error') return state.error?.message ?? 'Error';
    if (state.lifecycle !== 'ready') return state.lifecycle;
    const time = `${state.currentTime.toFixed(1)} / ${Number.isFinite(state.duration) ? state.duration.toFixed(1) : 'live'} s`;
    return `${state.playing ? 'playing' : 'paused'} · ${time} · ${presentation}`;
}

defineExpose({
    controller: computed(() => inner.value?.controller ?? null),
    state: computed(() => inner.value?.state ?? createInitialState()),
    play: () => inner.value?.play(),
    pause: () => inner.value?.pause(),
    seek: (seconds: number) => inner.value?.seek(seconds),
    enterFullscreen: () => inner.value?.enterFullscreen(),
    exitFullscreen: () => inner.value?.exitFullscreen(),
    muted: computed(() => inner.value?.muted ?? false),
    canMute: computed(() => inner.value?.canMute ?? false),
    canPictureInPicture: computed(() => inner.value?.canPictureInPicture ?? false),
    canAirPlay: castSupported,
    airPlayAvailable: computed(() => inner.value?.airPlayAvailable ?? false),
    airPlayActive: computed(() => inner.value?.airPlayActive ?? false),
    showAirPlayPicker: () => inner.value?.showAirPlayPicker(),
    setMuted: (muted: boolean) => inner.value?.setMuted(muted),
    startPictureInPicture: () => inner.value?.startPictureInPicture(),
});
</script>

<template>
    <NativeLuminaryPlayer
        ref="inner"
        :source="source"
        :poster="poster"
        :preferred-language="preferredLanguage"
        :inline="inline"
        :now-playing="{ title: 'Player Lab' }"
        :plugin="plugin"
        :on-app-resume="onAppResume"
        @timeupdate="(time: number, duration: number) => emit('timeupdate', time, duration)"
        @loadedmetadata="emit('loadedmetadata')"
        @ended="emit('ended')"
    >
        <template #default="slot">
            <div class="native-player__caption">{{ caption(slot) }}</div>
        </template>
    </NativeLuminaryPlayer>
</template>

<style scoped>
.native-player__caption {
    position: absolute;
    left: 12px;
    bottom: 10px;
    right: 12px;
    font: 12px ui-monospace, Menlo, monospace;
    color: #c7c7cc;
}
</style>
