<script setup lang="ts">
import { reactive, watch, computed } from 'vue';
import type { Rendition, S3Config, CreateSessionRequest, Credentials } from '../types';
import FileDropZone from './FileDropZone.vue';

const S3_STORAGE_KEY = 'luminary_s3_config';
const ENCODING_STORAGE_KEY = 'luminary_encoding_config';

const emit = defineEmits<{
    submit: [payload: { config: CreateSessionRequest; credentials: Credentials; file: File }];
}>();

const file = defineModel<File | null>('file', { default: null });

const credentials = reactive<Credentials>({
    username: '',
    password: '',
});

const apiBaseUrl = defineModel<string>('apiBaseUrl', { default: 'http://localhost:3000' });

function defaultVideoRendition(): Rendition {
    return { width: 1920, height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128, audioCodec: 'aac' };
}

function defaultAudioRendition(): Rendition {
    return { audioBitrateKbps: 128, audioCodec: 'aac' };
}

interface EncodingConfig {
    type: 'video' | 'audio';
    segmentDuration: number;
    renditions: Rendition[];
}

function loadEncodingConfig(): EncodingConfig {
    try {
        const raw = localStorage.getItem(ENCODING_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { type: 'video', segmentDuration: 6, renditions: [defaultVideoRendition()] };
}

const saved = loadEncodingConfig();
const encodingType = reactive<{ value: 'video' | 'audio' }>({ value: saved.type });
const segmentDuration = reactive<{ value: number }>({ value: saved.segmentDuration });
const renditions = reactive<Rendition[]>(saved.renditions);

watch(() => encodingType.value, (newType) => {
    renditions.splice(0, renditions.length, newType === 'video' ? defaultVideoRendition() : defaultAudioRendition());
});

function addRendition() {
    renditions.push(encodingType.value === 'video' ? defaultVideoRendition() : defaultAudioRendition());
}

function removeRendition(index: number) {
    if (renditions.length > 1) renditions.splice(index, 1);
}

function saveEncodingConfig() {
    const config: EncodingConfig = {
        type: encodingType.value,
        segmentDuration: segmentDuration.value,
        renditions: [...renditions],
    };
    localStorage.setItem(ENCODING_STORAGE_KEY, JSON.stringify(config));
}

function clearEncodingConfig() {
    localStorage.removeItem(ENCODING_STORAGE_KEY);
    encodingType.value = 'video';
    segmentDuration.value = 6;
    renditions.splice(0, renditions.length, defaultVideoRendition());
}

function loadS3Config(): S3Config {
    try {
        const raw = localStorage.getItem(S3_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {
        endPoint: '',
        bucket: '',
        accessKey: '',
        secretKey: '',
        useSSL: true,
    };
}

const s3 = reactive<S3Config>(loadS3Config());

function saveS3Config() {
    localStorage.setItem(S3_STORAGE_KEY, JSON.stringify({ ...s3 }));
}

function clearS3Config() {
    localStorage.removeItem(S3_STORAGE_KEY);
    Object.assign(s3, { endPoint: '', port: undefined, useSSL: true, bucket: '', region: undefined, accessKey: '', secretKey: '', pathPrefix: undefined });
}

const canSubmit = computed(() => {
    if (!file.value) return false;
    if (!credentials.username || !credentials.password) return false;
    if (!s3.endPoint || !s3.bucket || !s3.accessKey || !s3.secretKey) return false;
    if (renditions.length === 0) return false;
    if (encodingType.value === 'video') {
        return renditions.every(r => r.width && r.height && r.videoBitrateKbps && r.audioBitrateKbps);
    }
    return renditions.every(r => r.audioBitrateKbps);
});

function onSubmit() {
    if (!canSubmit.value || !file.value) return;
    saveS3Config();
    saveEncodingConfig();

    const config: CreateSessionRequest = {
        type: encodingType.value,
        renditions: renditions.map(r => {
            const out: Rendition = { audioBitrateKbps: r.audioBitrateKbps };
            if (r.audioCodec) out.audioCodec = r.audioCodec;
            if (encodingType.value === 'video') {
                out.width = r.width;
                out.height = r.height;
                out.videoBitrateKbps = r.videoBitrateKbps;
            }
            return out;
        }),
        segmentDuration: segmentDuration.value,
        s3: { ...s3 },
    };

    emit('submit', { config, credentials: { ...credentials }, file: file.value });
}
</script>

<template>
    <form @submit.prevent="onSubmit" class="space-y-6">
        <!-- API Connection -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">API Connection</legend>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Base URL</label>
                    <input v-model="apiBaseUrl" type="text" class="input" placeholder="http://localhost:3000" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Username</label>
                    <input v-model="credentials.username" type="text" class="input" autocomplete="username" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Password</label>
                    <input v-model="credentials.password" type="password" class="input" autocomplete="current-password" />
                </div>
            </div>
        </fieldset>

        <!-- File -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Source File</legend>
            <FileDropZone @update:file="f => (file = f)" />
        </fieldset>

        <!-- Encoding -->
        <fieldset class="space-y-3">
            <div class="flex items-center justify-between">
                <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Encoding</legend>
                <button type="button" @click="clearEncodingConfig" class="btn-sm text-red-400 hover:text-red-300">Clear saved</button>
            </div>
            <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-sm">
                    <input type="radio" v-model="encodingType.value" value="video" class="accent-indigo-500" />
                    Video
                </label>
                <label class="flex items-center gap-2 text-sm">
                    <input type="radio" v-model="encodingType.value" value="audio" class="accent-indigo-500" />
                    Audio
                </label>
                <div class="ml-auto flex items-center gap-2">
                    <label class="text-xs text-zinc-500">Segment duration (s)</label>
                    <input v-model.number="segmentDuration.value" type="number" min="1" class="input w-20 text-center" />
                </div>
            </div>
        </fieldset>

        <!-- Renditions -->
        <fieldset class="space-y-3">
            <div class="flex items-center justify-between">
                <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Renditions</legend>
                <button type="button" @click="addRendition" class="btn-sm">+ Add</button>
            </div>
            <div
                v-for="(r, i) in renditions"
                :key="i"
                class="flex flex-wrap items-end gap-3 rounded-md bg-zinc-900/60 p-3"
            >
                <template v-if="encodingType.value === 'video'">
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500">Width</label>
                        <input v-model.number="r.width" type="number" min="1" class="input w-24" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500">Height</label>
                        <input v-model.number="r.height" type="number" min="1" class="input w-24" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500">Video kbps</label>
                        <input v-model.number="r.videoBitrateKbps" type="number" min="1" class="input w-28" />
                    </div>
                </template>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Audio kbps</label>
                    <input v-model.number="r.audioBitrateKbps" type="number" min="1" class="input w-28" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Audio codec</label>
                    <select v-model="r.audioCodec" class="input w-24">
                        <option value="aac">AAC</option>
                        <option value="mp3">MP3</option>
                    </select>
                </div>
                <button
                    v-if="renditions.length > 1"
                    type="button"
                    @click="removeRendition(i)"
                    class="mb-0.5 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </fieldset>

        <!-- S3 Configuration -->
        <fieldset class="space-y-3">
            <div class="flex items-center justify-between">
                <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">S3 Storage</legend>
                <button type="button" @click="clearS3Config" class="btn-sm text-red-400 hover:text-red-300">Clear saved</button>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div class="sm:col-span-2">
                    <label class="mb-1 block text-xs text-zinc-500">Endpoint</label>
                    <input v-model="s3.endPoint" type="text" class="input" placeholder="s3.amazonaws.com" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Port</label>
                    <input v-model.number="s3.port" type="number" class="input" placeholder="443" />
                </div>
                <div class="flex items-end pb-1">
                    <label class="flex items-center gap-2 text-sm">
                        <input type="checkbox" v-model="s3.useSSL" class="accent-indigo-500" />
                        Use SSL
                    </label>
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Bucket</label>
                    <input v-model="s3.bucket" type="text" class="input" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Region</label>
                    <input v-model="s3.region" type="text" class="input" placeholder="us-east-1" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Access Key</label>
                    <input v-model="s3.accessKey" type="text" class="input" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Secret Key</label>
                    <input v-model="s3.secretKey" type="password" class="input" />
                </div>
                <div class="sm:col-span-2 lg:col-span-4">
                    <label class="mb-1 block text-xs text-zinc-500">Path Prefix</label>
                    <input v-model="s3.pathPrefix" type="text" class="input" placeholder="optional/prefix" />
                </div>
            </div>
        </fieldset>

        <!-- Submit -->
        <button
            type="submit"
            :disabled="!canSubmit"
            :class="[
                'w-full rounded-lg px-6 py-3 text-sm font-semibold transition-colors',
                canSubmit
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
            ]"
        >
            Start Encoding Session
        </button>
    </form>
</template>
