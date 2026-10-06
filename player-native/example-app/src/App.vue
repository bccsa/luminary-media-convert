<script setup lang="ts">
/**
 * The player lab. It knows the player only through `virtual:video-player`'s contract, as the
 * Luminary app will: `inject(VideoPlayerKey)`, then `<component :is>` of what the service returns.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import { VideoPlayerKey, type PlaybackMode, type PlayerHandle } from '@/build-time/contracts/plugin-registry';
import { NativePluginKey } from '@/players/nativePlugin';
import { SimulatedNativePlugin } from '@/players/SimulatedNativePlugin';
import HealthBoard from '@/lab/HealthBoard.vue';
import StressPanel from '@/lab/StressPanel.vue';
import { probe, type Observation } from '@/lab/probe';
import { DEFAULT_YOUTUBE, presets } from '@/lab/sources';
import { landedAt, type Intensity, type StressContext } from '@/lab/stress';

const service = inject(VideoPlayerKey)!;
const nativePlugin = inject(NativePluginKey)!;
const simulated = nativePlugin instanceof SimulatedNativePlugin ? nativePlugin : null;

// Settings, remembered between visits.
const STORAGE = 'player-lab';
const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, string>;
    } catch {
        return {};
    }
})();
const available = service.modes.filter((m) => m.available).map((m) => m.id);
// `VITE_LAB_MODE` picks the first mode in a build with no one to tap a tab (a simulator run).
const firstMode = saved.mode ?? (import.meta.env.VITE_LAB_MODE as string | undefined);
const mode = ref<PlaybackMode>(available.includes(firstMode as PlaybackMode) ? (firstMode as PlaybackMode) : available[0]!);
const presetId = ref(saved.presetId ?? 'sample');
/** Native only: the video is drawn by the platform behind the page, which then leaves its backgrounds clear. */
const inlineVideo = ref(Boolean(saved.inlineVideo));
const inlineActive = computed(() => mode.value === 'native' && inlineVideo.value);
watchEffect(() => document.documentElement.classList.toggle('lab-inline', inlineActive.value));
const customUrl = ref(saved.customUrl ?? '');
const customKey = ref(saved.customKey ?? '');
/** An HTTPS-served embed page, for a WebView whose own origin YouTube refuses (iOS). */
const youtubeEmbedUrl = import.meta.env.VITE_YOUTUBE_EMBED_URL as string | undefined;
const youtubeUrl = ref(saved.youtubeUrl ?? DEFAULT_YOUTUBE);
watch([mode, presetId, customUrl, customKey, youtubeUrl, inlineVideo], () =>
    localStorage.setItem(STORAGE, JSON.stringify({
        mode: mode.value,
        presetId: presetId.value,
        customUrl: customUrl.value,
        customKey: customKey.value,
        youtubeUrl: youtubeUrl.value,
        inlineVideo: inlineVideo.value,
    })),
);

const sourcePresets = presets();
const nonce = ref(0);
const source = computed<PlayerSource>(() => {
    void nonce.value; // A reload is a new source object for the same stream.
    if (mode.value === 'youtube') return { masterUrl: youtubeUrl.value };
    const preset = sourcePresets.find((p) => p.id === presetId.value) ?? sourcePresets[0]!;
    if (preset.id === 'custom') {
        return { masterUrl: customUrl.value.trim(), ...(customKey.value.trim() ? { keyHex: customKey.value.trim().toLowerCase() } : {}) };
    }
    return { masterUrl: preset.masterUrl, ...(preset.keyHex ? { keyHex: preset.keyHex } : {}) };
});

const playerComponent = computed(() => service.component(mode.value));
const playerKey = ref(0);
const player = shallowRef<PlayerHandle | null>(null);
const handle = () => player.value;

// What the probe sees.
let lastTime = 0;
let lastDuration = 0;
let lastAdvanceAt = 0;
/** When the engine last said it had an item's metadata: a load is ready only once this is newer. */
let metadataAt = 0;
let loadStartedAt = 0;

/** A load, remount or mode switch begins: readiness has to be earned again. */
function beginLoad(): void {
    loadStartedAt = performance.now();
    lastTime = 0;
    lastDuration = 0;
    probe.data.last = null;
    probe.disrupted();
}

/**
 * Ready means the engine has the item: a `loadedmetadata` since the load began, and (where there is
 * one) the controller's lifecycle. The controller alone turns ready once a load is handed to the
 * engine, before the engine has anything.
 */
function observe(): Observation {
    const current = player.value;
    const state = current?.controller ? current.state : null;
    const playing = state ? state.playing : performance.now() - lastAdvanceAt < 1200;
    const ready = metadataAt > loadStartedAt && (!state || state.lifecycle === 'ready');
    return {
        currentTime: state ? state.currentTime : lastTime,
        duration: state ? state.duration : lastDuration,
        playing,
        ready,
        metadataAt,
        state,
    };
}

function onTimeupdate(currentTime: number, duration: number): void {
    if (currentTime > lastTime) lastAdvanceAt = performance.now();
    lastTime = currentTime;
    if (Number.isFinite(duration) && duration > 0) {
        lastDuration = duration;
        // YouTube's tech is known to drop `loadedmetadata`; a duration is as good a sign there.
        if (!player.value?.controller && metadataAt < loadStartedAt) metadataAt = performance.now();
    }
    probe.timeupdate();
    probe.observe(observe());
}

function onLoadedmetadata(): void {
    metadataAt = performance.now();
    probe.observe(observe());
}

const polling = setInterval(() => probe.observe(observe()), 100);
// For a debugger attached over DevTools (a phone's WebView included): what the probe sees, live.
(window as unknown as { __lab: object }).__lab = { probe, observe, handle };
onBeforeUnmount(() => clearInterval(polling));

/** Measures the load the lab just started, without waiting on it. */
function measureStartup(label: string): Promise<number | null> {
    beginLoad();
    return probe.expect('startup', label, (o) => o.ready);
}

onMounted(() => {
    probe.start();
    void measureStartup('first load');
});

async function setMode(next: PlaybackMode): Promise<number | null> {
    probe.abandonPending();
    beginLoad();
    mode.value = next;
    await nextTick();
    beginLoad();
    return probe.expect('mode', `mode ${next}`, (o) => o.ready);
}

function reload(): void {
    beginLoad();
    nonce.value++;
}

async function remount(): Promise<number | null> {
    probe.abandonPending();
    playerKey.value++;
    await nextTick();
    return measureStartup('remount');
}

function chooseMode(next: PlaybackMode): void {
    if (next !== mode.value) void setMode(next);
}

function applySource(): void {
    probe.abandonPending();
    void measureStartup('source change');
    nonce.value++;
}

// Transport.
const state = computed(() => (player.value?.controller ? player.value.state : null));
function play() {
    void player.value?.play();
    void probe.expect('play', 'play', (o) => o.playing);
}
function pause() {
    player.value?.pause();
    void probe.expect('pause', 'pause', (o) => !o.playing);
}
function skip(seconds: number) {
    const target = Math.max(0, observe().currentTime + seconds);
    const playing = observe().playing;
    player.value?.seek(target);
    // Only a playing player shows a seek landing; a paused one only echoes the request.
    if (playing) void probe.expect('seek', `seek to ${target.toFixed(0)}s`, landedAt(target));
}
function setAngle(id: string) {
    const since = performance.now();
    void player.value?.controller?.setAngle(id);
    void probe.expect('angle', `angle ${id}`, (o) => o.state?.activeAngleId === id && o.metadataAt > since);
}
function setQuality(id: string) {
    player.value?.controller?.setQuality(id);
    void probe.expect('quality', `quality ${id}`, (o) => o.state?.activeQualityId === id);
}
function setAudio(id: string) {
    player.value?.controller?.setAudioTrack(id);
    void probe.expect('audio', `language ${id}`, (o) => o.state?.activeAudioTrackId === id);
}

// Log.
const log = ref<string[]>([]);
function addLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    log.value = [...log.value.slice(-199), `${stamp} ${line}`];
}

function stressContext(intensity: Intensity, signal: AbortSignal, progress: (f: number) => void): StressContext {
    return {
        signal,
        intensity,
        probe,
        handle,
        mode: () => mode.value,
        modes: () => available,
        setMode,
        reload,
        remount,
        log: addLog,
        progress,
    };
}

const latency = ref(simulated?.latencyScale ?? 1);
watch(latency, (value) => {
    if (simulated) simulated.latencyScale = value;
});
</script>

<template>
    <main class="lab" :class="{ 'lab--inline': inlineActive }">
        <header class="lab__head">
            <h1>Player Lab</h1>
            <span class="badge">{{ service.target }} build</span>
        </header>

        <div class="segmented">
            <button
                v-for="option in service.modes"
                :key="option.id"
                type="button"
                :class="{ selected: option.id === mode }"
                :disabled="!option.available"
                :title="option.reason"
                @click="chooseMode(option.id)"
            >
                {{ option.label }}
            </button>
        </div>

        <label v-if="mode === 'native'" class="inline-toggle">
            <input v-model="inlineVideo" type="checkbox" />
            Video in the page (native, behind a see-through page)
        </label>

        <div class="player">
            <component
                :is="playerComponent"
                :key="`${mode}-${playerKey}`"
                ref="player"
                :source="source"
                :youtube-embed-url="youtubeEmbedUrl"
                :inline="inlineActive"
                @timeupdate="onTimeupdate"
                @loadedmetadata="onLoadedmetadata"
            />
        </div>

        <div class="row">
            <button class="capsule" type="button" @click="play">Play</button>
            <button class="capsule" type="button" @click="pause">Pause</button>
            <button class="capsule" type="button" @click="skip(-10)">−10 s</button>
            <button class="capsule" type="button" @click="skip(10)">+10 s</button>
            <button class="capsule" type="button" @click="player?.enterFullscreen()">Full screen</button>
        </div>

        <template v-if="state">
            <div v-if="state.angles.length > 1" class="group">
                <span class="group__label">Angle</span>
                <button
                    v-for="angle in state.angles"
                    :key="angle.id"
                    class="capsule"
                    :class="{ 'capsule--prominent': angle.id === state.activeAngleId }"
                    type="button"
                    @click="setAngle(angle.id)"
                >
                    {{ angle.name }}
                </button>
            </div>
            <div v-if="state.qualities.length" class="group">
                <span class="group__label">Quality</span>
                <button class="capsule" :class="{ 'capsule--prominent': state.activeQualityId === 'auto' }" type="button" @click="setQuality('auto')">Auto</button>
                <button
                    v-for="quality in state.qualities"
                    :key="quality.id"
                    class="capsule"
                    :class="{ 'capsule--prominent': quality.id === state.activeQualityId }"
                    type="button"
                    @click="setQuality(quality.id)"
                >
                    {{ quality.label }}
                </button>
            </div>
            <div v-if="state.audioTracks.length" class="group">
                <span class="group__label">Audio</span>
                <button
                    v-for="track in state.audioTracks"
                    :key="track.id"
                    class="capsule"
                    :class="{ 'capsule--prominent': track.id === state.activeAudioTrackId }"
                    type="button"
                    @click="setAudio(track.id)"
                >
                    {{ track.label }}
                </button>
            </div>
            <p class="status">{{ state.lifecycle }} · {{ state.currentTime.toFixed(1) }} / {{ Number.isFinite(state.duration) ? state.duration.toFixed(1) : 'live' }} s · buffered {{ state.bufferedEnd.toFixed(1) }} s</p>
        </template>

        <details class="card">
            <summary>Source</summary>
            <template v-if="mode === 'youtube'">
                <label>YouTube link<input v-model="youtubeUrl" spellcheck="false" /></label>
            </template>
            <template v-else>
                <label>
                    Stream
                    <select v-model="presetId">
                        <option v-for="preset in sourcePresets" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
                    </select>
                </label>
                <template v-if="presetId === 'custom'">
                    <label>Master URL<input v-model="customUrl" spellcheck="false" placeholder="http://192.168.1.10:9000/media/…/master.m3u8" /></label>
                    <label>Key (32 hex, optional)<input v-model="customKey" spellcheck="false" /></label>
                </template>
                <p v-if="presetId === 'sample'" class="hint">
                    Served by this dev server from <code>spike/make-sample-stream.py</code>'s output; run that once first.
                </p>
            </template>
            <button class="capsule capsule--prominent" type="button" @click="applySource">Load</button>
            <label v-if="simulated && mode === 'native'">
                Simulated device speed: {{ latency }}× slower
                <input v-model.number="latency" type="range" min="0.5" max="20" step="0.5" />
            </label>
        </details>

        <section class="card">
            <StressPanel :context="stressContext" />
        </section>

        <details class="card">
            <summary>Log ({{ log.length }})</summary>
            <pre class="log">{{ log.join('\n') }}</pre>
        </details>

        <HealthBoard :probe="probe" @reset="probe.reset()" />
    </main>
</template>

<style scoped>
.lab {
    max-width: 720px;
    margin: 0 auto;
    padding: calc(12px + env(safe-area-inset-top)) 12px 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 100vh;
    box-sizing: border-box;
}
.lab__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
}
.lab__head h1 {
    margin: 0;
    font-size: 28px;
}
.badge {
    font-size: 12px;
    color: #8e8e93;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.inline-toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    color: #3a3a3c;
}
/* The page leaves the picture's place clear: everything around it keeps the lab's own background. */
.lab--inline > *:not(.player) {
    background: #f2f2f7;
}
.lab--inline .player {
    background: transparent;
}
.player {
    background: #000;
    border-radius: 12px;
    overflow: hidden;
}
.row,
.group {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.group__label {
    width: 64px;
    font-size: 12px;
    color: #8e8e93;
    text-transform: uppercase;
}
.status {
    margin: 0;
    font: 12px ui-monospace, Menlo, monospace;
    color: #8e8e93;
}
.card {
    background: #fff;
    border-radius: 12px;
    padding: 12px 14px;
}
.card summary {
    font-weight: 600;
    cursor: pointer;
}
.card label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 10px 0;
    font-size: 13px;
    color: #3c3c43;
}
.card input:not([type='range']),
.card select {
    font: inherit;
    font-size: 15px;
    padding: 8px 10px;
    border: 1px solid #d1d1d6;
    border-radius: 8px;
    background: #fff;
}
.hint {
    font-size: 12px;
    color: #8e8e93;
}
.log {
    max-height: 260px;
    overflow: auto;
    font-size: 11px;
    white-space: pre-wrap;
}
</style>
