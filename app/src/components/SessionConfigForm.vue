<script setup lang="ts">
import { reactive, computed, ref } from 'vue';
import type { S3Config, CreateSessionRequest } from '../types';
import FileDropZone from './FileDropZone.vue';

const S3_STORAGE_KEY = 'luminary_s3_config';
const BYTE_RANGE_KEY = 'luminary_byte_range';
const MAX_FILE_SIZE_KEY = 'luminary_byte_range_max_mb';

const emit = defineEmits<{
    submit: [payload: { config: CreateSessionRequest; file: File }];
}>();

const file = defineModel<File | null>('file', { default: null });

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

function loadByteRange(): boolean {
    try {
        const raw = localStorage.getItem(BYTE_RANGE_KEY);
        if (raw != null) return raw === 'true';
    } catch { /* ignore */ }
    return true;
}

const byteRange = ref(loadByteRange());

function loadMaxFileSizeMB(): number {
    try {
        const raw = localStorage.getItem(MAX_FILE_SIZE_KEY);
        if (raw) {
            const val = parseInt(raw, 10);
            if (val > 0) return val;
        }
    } catch { /* ignore */ }
    return 500;
}

const byteRangeMaxFileSizeMB = ref(loadMaxFileSizeMB());

function saveS3Config() {
    localStorage.setItem(S3_STORAGE_KEY, JSON.stringify({ ...s3 }));
    localStorage.setItem(BYTE_RANGE_KEY, String(byteRange.value));
    localStorage.setItem(MAX_FILE_SIZE_KEY, String(byteRangeMaxFileSizeMB.value || 500));
}

function clearS3Config() {
    localStorage.removeItem(S3_STORAGE_KEY);
    localStorage.removeItem(BYTE_RANGE_KEY);
    localStorage.removeItem(MAX_FILE_SIZE_KEY);
    Object.assign(s3, { endPoint: '', port: undefined, useSSL: true, bucket: '', region: undefined, accessKey: '', secretKey: '', pathPrefix: undefined });
    byteRange.value = true;
    byteRangeMaxFileSizeMB.value = 500;
}

const canSubmit = computed(() => {
    if (!file.value) return false;
    if (!s3.endPoint || !s3.bucket || !s3.accessKey || !s3.secretKey) return false;
    return true;
});

function onSubmit() {
    if (!canSubmit.value || !file.value) return;
    saveS3Config();

    const config: CreateSessionRequest = {
        s3: { ...s3 },
        byteRange: byteRange.value,
        byteRangeMaxFileSizeMB: byteRange.value ? (byteRangeMaxFileSizeMB.value || 500) : undefined,
    };

    emit('submit', { config, file: file.value });
}
</script>

<template>
    <form @submit.prevent="onSubmit" class="space-y-6">
        <!-- File -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Source File</legend>
            <FileDropZone @update:file="f => (file = f)" />
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
            <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" v-model="byteRange" class="accent-indigo-500" />
                    Byte-range segments
                </label>
                <div v-if="byteRange" class="flex items-center gap-2">
                    <label class="text-xs text-zinc-500">Max file size (MB)</label>
                    <input v-model.number="byteRangeMaxFileSizeMB" type="number" min="1" class="input w-24" placeholder="500" />
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
            Upload &amp; Analyze
        </button>
    </form>
</template>
