<script setup lang="ts">
/**
 * Dev-only harness for the reference player.
 *
 * Paste any master playlist URL (plain or LMCENC-encrypted, byte-range or
 * not) and an optional 32-hex-char session key, and it plays through the real
 * `LuminaryPlayer` → `PlayerController` → `HlsJsAdapter` path — the same code
 * the encoder app ships. Useful for eyeballing output the app has no session
 * for, and for watching chunk warming fire in the network tab.
 *
 * Not shipped anywhere: served only by `npm -w player-web run demo`.
 */
import { computed, reactive, ref, shallowRef, watchEffect } from 'vue';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

const STORAGE_KEY = 'luminary-player-demo';

const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
            url?: string;
            keyHex?: string;
        };
    } catch {
        return {};
    }
})();

const form = reactive({
    url: saved.url ?? '',
    keyHex: saved.keyHex ?? '',
    // Default ON here: watching the warming work is half of what this
    // harness is for. The library default is off.
    prefetchDebug: (saved as { prefetchDebug?: boolean }).prefetchDebug ?? true,
});

const source = shallowRef<PlayerSource | null>(null);
const player = ref<InstanceType<typeof LuminaryPlayer> | null>(null);
const formError = ref('');

function load() {
    const url = form.url.trim();
    const keyHex = form.keyHex.trim().toLowerCase();
    if (!url) {
        formError.value = 'A master playlist URL is required.';
        return;
    }
    if (keyHex && !/^[0-9a-f]{32}$/.test(keyHex)) {
        formError.value =
            'The key must be 32 hex characters (16-byte AES-128 key).';
        return;
    }
    formError.value = '';
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ url, keyHex, prefetchDebug: form.prefetchDebug }),
    );
    // Controller options are read once at construction, so bump the key to
    // remount the player when they change between loads.
    controllerOptions.value = {
        prefetch: { debug: form.prefetchDebug },
    };
    playerKey.value++;
    source.value = { masterUrl: url, ...(keyHex ? { keyHex } : {}) };
}

const controllerOptions = shallowRef<{ prefetch: { debug: boolean } }>({
    prefetch: { debug: form.prefetchDebug },
});
const playerKey = ref(0);

const state = computed(() => player.value?.state ?? null);

// Selector models kept in sync with the player's own idea of what is active.
const angleModel = ref('');
const qualityModel = ref('auto');
const audioModel = ref('');

watchEffect(() => {
    angleModel.value = state.value?.activeAngleId ?? '';
    qualityModel.value = state.value?.activeQualityId ?? 'auto';
    audioModel.value = state.value?.activeAudioTrackId ?? '';
});

// Transport — the player deliberately draws no chrome outside fullscreen,
// so the harness provides its own, the way a host app would.
const scrubbing = ref(false);
const scrubPosition = ref(0);

const progressValue = computed(() =>
    scrubbing.value ? scrubPosition.value : (state.value?.currentTime ?? 0),
);

/** Buffered extent shaded into the range track, host-side. */
const progressStyle = computed(() => {
    const duration = state.value?.duration || 1;
    const played = (progressValue.value / duration) * 100;
    const buffered = ((state.value?.bufferedEnd ?? 0) / duration) * 100;
    return {
        background: `linear-gradient(to right,
            #2563eb 0% ${played}%,
            #4b5563 ${played}% ${Math.max(played, buffered)}%,
            #27272a ${Math.max(played, buffered)}% 100%)`,
    };
});

function onScrub(event: Event) {
    scrubbing.value = true;
    scrubPosition.value = Number((event.target as HTMLInputElement).value);
}

function onScrubEnd() {
    if (!scrubbing.value) return;
    player.value?.controller?.seek(scrubPosition.value);
    scrubbing.value = false;
}

function onAngle() {
    void player.value?.controller?.setAngle(angleModel.value);
}
function onQuality() {
    player.value?.controller?.setQuality(qualityModel.value);
}
function onAudio() {
    player.value?.controller?.setAudioTrack(audioModel.value);
}

const fmt = (n: number | undefined) => (n ?? 0).toFixed(1);
</script>

<template>
    <main class="demo">
        <h1>Luminary reference player — test harness</h1>

        <form class="demo-form" @submit.prevent="load">
            <label>
                Master playlist URL
                <input
                    v-model="form.url"
                    type="text"
                    placeholder="http://localhost:9000/bucket/prefix/master.m3u8"
                    spellcheck="false"
                />
            </label>
            <label>
                Session key (optional, 32 hex chars)
                <input
                    v-model="form.keyHex"
                    type="text"
                    placeholder="unmasked AES-128 key for encrypted output"
                    spellcheck="false"
                />
            </label>
            <label class="demo-check">
                <input v-model="form.prefetchDebug" type="checkbox" />
                Log chunk warming to the console (applies on Load)
            </label>
            <button type="submit">Load</button>
            <p v-if="formError" class="demo-error">{{ formError }}</p>
        </form>

        <template v-if="source">
            <LuminaryPlayer
                ref="player"
                :key="playerKey"
                :source="source"
                :controller-options="controllerOptions"
            />

            <div v-if="state" class="demo-transport">
                <button
                    type="button"
                    class="demo-play"
                    @click="player?.controller?.togglePlay()"
                >
                    {{ state.playing ? 'Pause' : 'Play' }}
                </button>
                <span class="demo-time">{{ fmt(progressValue) }}</span>
                <input
                    class="demo-progress"
                    type="range"
                    min="0"
                    :max="state.duration || 0"
                    step="0.1"
                    :value="progressValue"
                    :style="progressStyle"
                    @input="onScrub"
                    @change="onScrubEnd"
                    @pointerup="onScrubEnd"
                />
                <span class="demo-time">{{ fmt(state.duration) }}</span>
            </div>

            <div v-if="state" class="demo-controls">
                <label v-if="(state.angles?.length ?? 0) > 1">
                    Angle
                    <select v-model="angleModel" @change="onAngle">
                        <option
                            v-for="a in state.angles"
                            :key="a.id"
                            :value="a.id"
                        >
                            {{ a.name }}
                        </option>
                    </select>
                </label>
                <label v-if="(state.qualities?.length ?? 0) > 1">
                    Quality
                    <select v-model="qualityModel" @change="onQuality">
                        <option value="auto">auto</option>
                        <option
                            v-for="q in state.qualities"
                            :key="q.id"
                            :value="q.id"
                        >
                            {{ q.label }}
                        </option>
                    </select>
                </label>
                <label v-if="(state.audioTracks?.length ?? 0) > 1">
                    Audio
                    <select v-model="audioModel" @change="onAudio">
                        <option
                            v-for="t in state.audioTracks"
                            :key="t.id"
                            :value="t.id"
                        >
                            {{ t.label || t.id }}
                        </option>
                    </select>
                </label>
                <button type="button" @click="player?.enterFullscreen()">
                    Fullscreen
                </button>
            </div>

            <dl v-if="state" class="demo-state">
                <div>
                    <dt>lifecycle</dt>
                    <dd>{{ state.lifecycle }}</dd>
                </div>
                <div>
                    <dt>time</dt>
                    <dd>
                        {{ fmt(state.currentTime) }} /
                        {{ fmt(state.duration) }} s
                    </dd>
                </div>
                <div>
                    <dt>buffered to</dt>
                    <dd>{{ fmt(state.bufferedEnd) }} s</dd>
                </div>
                <div v-if="state.error">
                    <dt>error</dt>
                    <dd>{{ state.error.code }}: {{ state.error.detail }}</dd>
                </div>
            </dl>

            <p class="demo-hint">
                Chunk warming: watch the network tab for a single
                <code>Range: bytes=0-65535</code> request per
                <code>media/…</code> chunk, fired as the buffer front nears the
                previous chunk's end.
            </p>
        </template>
    </main>
</template>

<style>
body {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #111;
    color: #eee;
}
.demo {
    max-width: 960px;
    margin: 0 auto;
    padding: 1.5rem;
}
.demo h1 {
    font-size: 1.1rem;
    font-weight: 600;
}
.demo-form {
    display: grid;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
}
.demo-form label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #aaa;
}
.demo-form input {
    padding: 0.5rem 0.65rem;
    border: 1px solid #333;
    border-radius: 6px;
    background: #1c1c1c;
    color: #eee;
    font: inherit;
}
.demo-form button,
.demo-controls button {
    justify-self: start;
    padding: 0.45rem 1.1rem;
    border: 1px solid #444;
    border-radius: 6px;
    background: #2563eb;
    color: #fff;
    font: inherit;
    cursor: pointer;
}
.demo-error {
    color: #f87171;
    font-size: 0.85rem;
    margin: 0;
}
.demo-check {
    display: flex !important;
    grid-auto-flow: column;
    align-items: center;
    gap: 0.5rem !important;
    flex-direction: row;
}
.demo-transport {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
}
.demo-play {
    min-width: 4.5rem;
    padding: 0.45rem 0;
    border: 1px solid #444;
    border-radius: 6px;
    background: #333;
    color: #fff;
    font: inherit;
    cursor: pointer;
}
.demo-time {
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    color: #aaa;
    min-width: 3.2rem;
    text-align: center;
}
.demo-progress {
    flex: 1;
    height: 6px;
    appearance: none;
    -webkit-appearance: none;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
}
.demo-progress::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    border: none;
}
.demo-progress::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    border: none;
}
.demo-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: end;
    margin-top: 1rem;
}
.demo-controls label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #aaa;
}
.demo-controls select {
    padding: 0.4rem 0.5rem;
    border: 1px solid #333;
    border-radius: 6px;
    background: #1c1c1c;
    color: #eee;
    font: inherit;
}
.demo-controls button {
    background: #333;
}
.demo-state {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    margin-top: 1rem;
    font-size: 0.85rem;
}
.demo-state div {
    display: grid;
    gap: 0.15rem;
}
.demo-state dt {
    color: #888;
}
.demo-state dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
}
.demo-hint {
    margin-top: 1.25rem;
    font-size: 0.8rem;
    color: #777;
}
.demo-hint code {
    color: #aaa;
}
</style>
