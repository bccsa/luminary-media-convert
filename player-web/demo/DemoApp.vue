<script setup lang="ts">
/**
 * Dev-only harness for the legacy (Video.js) player.
 *
 * Paste any master playlist URL — plain or LMCENC-encrypted, byte-range or not
 * — plus an optional 32-hex-char session key, and it plays through the real
 * `LuminaryPlayer` → `PlayerController` → `VideoJsAdapter` path, in the Luminary
 * app's chrome. A YouTube URL in the same field switches the component into
 * YouTube mode, where the LMC pipeline is bypassed entirely.
 *
 * Unlike the `player-web` harness there is no host transport here: this player
 * draws a full control bar over the picture, which is the whole point of it.
 * The selectors below remain, because they drive `setAngle` / `setQuality` /
 * `setAudioTrack` through the video.js path.
 *
 * Not shipped anywhere: served only by `npm -w player-web-legacy run demo`.
 */
import { computed, reactive, ref, shallowRef, watchEffect } from 'vue';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import { isYouTubeUrl } from '../src/youtube';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

const STORAGE_KEY = 'luminary-legacy-player-demo';

const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
            url?: string;
            keyHex?: string;
            poster?: string;
            preferredLanguage?: string;
            prefetchDebug?: boolean;
        };
    } catch {
        return {};
    }
})();

const form = reactive({
    url: saved.url ?? '',
    keyHex: saved.keyHex ?? '',
    poster: saved.poster ?? '',
    preferredLanguage: saved.preferredLanguage ?? '',
    // Default ON here: watching the warming work is half of what this
    // harness is for. The library default is off.
    prefetchDebug: saved.prefetchDebug ?? true,
});

const source = shallowRef<PlayerSource | null>(null);
const poster = ref('');
const preferredLanguage = ref('');
const player = ref<InstanceType<typeof LuminaryPlayer> | null>(null);
const formError = ref('');

const controllerOptions = shallowRef<{ prefetch: { debug: boolean } }>({
    prefetch: { debug: form.prefetchDebug },
});
const playerKey = ref(0);

function load() {
    const url = form.url.trim();
    const keyHex = form.keyHex.trim().toLowerCase();
    if (!url) {
        formError.value = 'A master playlist URL is required.';
        return;
    }
    if (keyHex && !/^[0-9a-f]{32}$/.test(keyHex)) {
        formError.value = 'The key must be 32 hex characters (16-byte AES-128 key).';
        return;
    }
    formError.value = '';
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            url,
            keyHex,
            poster: form.poster.trim(),
            preferredLanguage: form.preferredLanguage.trim(),
            prefetchDebug: form.prefetchDebug,
        }),
    );
    // Controller options are read once at construction, so a change to them is
    // the one thing that needs a remount — and only then. Every other Load
    // leaves the component mounted and lets the `source` watch reload in place,
    // which is the path a host actually takes and therefore the one worth
    // exercising here (mode switches, angle rebuilds, the load-generation
    // guard); remounting unconditionally would hide all of it behind a fresh
    // player every time.
    if (form.prefetchDebug !== controllerOptions.value.prefetch.debug) {
        controllerOptions.value = { prefetch: { debug: form.prefetchDebug } };
        playerKey.value++;
    }
    poster.value = form.poster.trim();
    preferredLanguage.value = form.preferredLanguage.trim();
    source.value = { masterUrl: url, ...(keyHex ? { keyHex } : {}) };
}

const state = computed(() => player.value?.state ?? null);
const youtubeMode = computed(() => isYouTubeUrl(source.value?.masterUrl ?? ''));

// Selector models kept in sync with the player's own idea of what is active.
const angleModel = ref('');
const qualityModel = ref('auto');
const audioModel = ref('');

watchEffect(() => {
    angleModel.value = state.value?.activeAngleId ?? '';
    qualityModel.value = state.value?.activeQualityId ?? 'auto';
    audioModel.value = state.value?.activeAudioTrackId ?? '';
});

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
        <h1>Luminary legacy (Video.js) player — test harness</h1>

        <form class="demo-form" @submit.prevent="load">
            <label>
                Master playlist URL — or a YouTube link, which switches the
                player into YouTube mode
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
            <label>
                Poster image URL (optional) — drawn behind the transparent player
                <input
                    v-model="form.poster"
                    type="text"
                    placeholder="https://example.com/artwork.jpg"
                    spellcheck="false"
                />
            </label>
            <label>
                Preferred audio language (optional) — "en", "eng" or "en-US"
                <input
                    v-model="form.preferredLanguage"
                    type="text"
                    placeholder="en"
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
                :poster="poster || undefined"
                :preferred-language="preferredLanguage || undefined"
                :controller-options="controllerOptions"
            />

            <p v-if="youtubeMode" class="demo-hint">
                YouTube mode: the LMC pipeline is bypassed, so the exposed
                controller is <code>null</code> and the state readout below stays
                at its initial values. The chrome is fully functional.
            </p>

            <div v-if="state && !youtubeMode" class="demo-controls">
                <label v-if="(state.angles?.length ?? 0) > 1">
                    Angle
                    <select v-model="angleModel" @change="onAngle">
                        <option v-for="a in state.angles" :key="a.id" :value="a.id">
                            {{ a.name }}
                        </option>
                    </select>
                </label>
                <label v-if="(state.qualities?.length ?? 0) > 1">
                    Quality
                    <select v-model="qualityModel" @change="onQuality">
                        <option value="auto">auto</option>
                        <option v-for="q in state.qualities" :key="q.id" :value="q.id">
                            {{ q.label }}
                        </option>
                    </select>
                </label>
                <label v-if="(state.audioTracks?.length ?? 0) > 1">
                    Audio
                    <select v-model="audioModel" @change="onAudio">
                        <option v-for="t in state.audioTracks" :key="t.id" :value="t.id">
                            {{ t.label || t.id }}
                        </option>
                    </select>
                </label>
                <button type="button" @click="player?.enterFullscreen()">Fullscreen</button>
            </div>

            <dl v-if="state" class="demo-state">
                <div>
                    <dt>lifecycle</dt>
                    <dd>{{ state.lifecycle }}</dd>
                </div>
                <div>
                    <dt>time</dt>
                    <dd>{{ fmt(state.currentTime) }} / {{ fmt(state.duration) }} s</dd>
                </div>
                <div>
                    <dt>buffered to</dt>
                    <dd>{{ fmt(state.bufferedEnd) }} s</dd>
                </div>
                <div>
                    <dt>audio only</dt>
                    <dd>{{ state.isAudioOnly }}</dd>
                </div>
                <div v-if="state.error">
                    <dt>error</dt>
                    <dd>{{ state.error.code }}: {{ state.error.message }}</dd>
                </div>
            </dl>

            <p class="demo-hint">
                Encrypted output should produce <em>no</em> request carrying the
                key and no <code>luminary://</code> request at all — the key is
                served to VHS from memory. Chunk warming shows up as a single
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
