<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue';
import type { S3Config, CreateSessionRequest } from '../types';
import FileDropZone from './FileDropZone.vue';

export interface SavedS3Config {
    id: string;
    name: string;
    endPoint: string;
    bucket: string;
}

const props = withDefaults(defineProps<{
    savedS3Configs?: SavedS3Config[];
    loadedS3Config?: S3Config | null;
    selectedS3ConfigId?: string;
}>(), {
    savedS3Configs: () => [],
    loadedS3Config: null,
    selectedS3ConfigId: '',
});

const selectedConfigId = ref(props.selectedS3ConfigId);

watch(() => props.selectedS3ConfigId, (id) => {
    selectedConfigId.value = id;
});

let suppressFieldWatch = false;

watch(() => props.loadedS3Config, (config) => {
    if (config) {
        suppressFieldWatch = true;
        Object.assign(s3, config);
        // Allow Vue reactivity to flush before re-enabling field watch
        setTimeout(() => { suppressFieldWatch = false; }, 0);
    }
});

const S3_STORAGE_KEY = 'luminary_s3_config';
const BYTE_RANGE_KEY = 'luminary_byte_range';
const MAX_FILE_SIZE_KEY = 'luminary_byte_range_max_mb';
const THUMBNAILS_KEY = 'luminary_thumbnails';
const ENCRYPTION_ENABLED_KEY = 'luminary_encryption_enabled';
const ENCRYPTION_KEY_URL_KEY = 'luminary_encryption_key_url';

const emit = defineEmits<{
    submit: [payload: { config: CreateSessionRequest; file: File }];
    loadS3Config: [configId: string];
    saveS3Config: [data: { name: string; endPoint: string; port?: number; useSSL?: boolean; bucket: string; region?: string; pathPrefix?: string; accessKey: string; secretKey: string }];
}>();

const showSaveDialog = ref(false);
const saveConfigName = ref('');

function canSaveS3() {
    return s3.endPoint && s3.bucket && s3.accessKey && s3.secretKey && !selectedConfigId.value;
}

function findExistingByName(name: string): SavedS3Config | undefined {
    return props.savedS3Configs.find(
        (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
}

function onSaveS3Config() {
    if (!saveConfigName.value.trim() || !canSaveS3()) return;

    const existing = findExistingByName(saveConfigName.value.trim());
    if (existing && !confirm(`A config named "${existing.name}" already exists. Overwrite it?`)) {
        return;
    }

    emit('saveS3Config', {
        name: saveConfigName.value.trim(),
        endPoint: s3.endPoint,
        port: s3.port,
        useSSL: s3.useSSL,
        bucket: s3.bucket,
        region: s3.region,
        pathPrefix: s3.pathPrefix,
        accessKey: s3.accessKey,
        secretKey: s3.secretKey,
        ...(existing ? { _overwriteId: existing.id } : {}),
    });
    showSaveDialog.value = false;
    saveConfigName.value = '';
}

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

// Reset dropdown to "Enter manually" when user edits any S3 field
watch(s3, () => {
    if (!suppressFieldWatch && selectedConfigId.value) {
        selectedConfigId.value = '';
    }
});

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

function loadThumbnails(): boolean {
    try {
        const raw = localStorage.getItem(THUMBNAILS_KEY);
        if (raw != null) return raw === 'true';
    } catch { /* ignore */ }
    return true;
}

const thumbnails = ref(loadThumbnails());

function loadEncryptionEnabled(): boolean {
    try {
        const raw = localStorage.getItem(ENCRYPTION_ENABLED_KEY);
        if (raw != null) return raw === 'true';
    } catch { /* ignore */ }
    return true;
}

function loadEncryptionKeyUrl(): string {
    try {
        return localStorage.getItem(ENCRYPTION_KEY_URL_KEY) ?? '';
    } catch { /* ignore */ }
    return '';
}

const encryptionEnabled = ref(loadEncryptionEnabled());
const encryptionKeyUrl = ref(loadEncryptionKeyUrl());

function saveS3Config() {
    localStorage.setItem(S3_STORAGE_KEY, JSON.stringify({ ...s3 }));
    localStorage.setItem(BYTE_RANGE_KEY, String(byteRange.value));
    localStorage.setItem(MAX_FILE_SIZE_KEY, String(byteRangeMaxFileSizeMB.value || 500));
    localStorage.setItem(THUMBNAILS_KEY, String(thumbnails.value));
    localStorage.setItem(ENCRYPTION_ENABLED_KEY, String(encryptionEnabled.value));
    localStorage.setItem(ENCRYPTION_KEY_URL_KEY, encryptionKeyUrl.value);
}

function clearS3Config() {
    localStorage.removeItem(S3_STORAGE_KEY);
    localStorage.removeItem(BYTE_RANGE_KEY);
    localStorage.removeItem(MAX_FILE_SIZE_KEY);
    localStorage.removeItem(THUMBNAILS_KEY);
    localStorage.removeItem(ENCRYPTION_ENABLED_KEY);
    localStorage.removeItem(ENCRYPTION_KEY_URL_KEY);
    Object.assign(s3, { endPoint: '', port: undefined, useSSL: true, bucket: '', region: undefined, accessKey: '', secretKey: '', pathPrefix: undefined });
    byteRange.value = true;
    byteRangeMaxFileSizeMB.value = 500;
    thumbnails.value = true;
    encryptionEnabled.value = true;
    encryptionKeyUrl.value = '';
}

const canSubmit = computed(() => {
    if (!file.value) return false;
    if (!s3.endPoint || !s3.bucket || !s3.accessKey || !s3.secretKey) return false;
    if (encryptionEnabled.value && !encryptionKeyUrl.value.trim()) return false;
    return true;
});

function onSubmit() {
    if (!canSubmit.value || !file.value) return;
    saveS3Config();

    const config: CreateSessionRequest = {
        s3: { ...s3 },
        byteRange: byteRange.value,
        byteRangeMaxFileSizeMB: byteRange.value ? (byteRangeMaxFileSizeMB.value || 500) : undefined,
        thumbnails: thumbnails.value,
        encryption: {
            enabled: encryptionEnabled.value,
            keyUrl: encryptionEnabled.value ? encryptionKeyUrl.value.trim() : undefined,
        },
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
                <div class="flex gap-2">
                    <button
                        v-if="canSaveS3()"
                        type="button"
                        @click="showSaveDialog = true"
                        class="btn-sm text-indigo-400 hover:text-indigo-300"
                    >
                        Save config
                    </button>
                    <button type="button" @click="clearS3Config" class="btn-sm text-red-400 hover:text-red-300">Clear</button>
                </div>
            </div>
            <!-- Save config dialog -->
            <div v-if="showSaveDialog" class="mb-2 flex items-end gap-2 rounded-lg border border-indigo-800/40 bg-indigo-950/20 p-3">
                <div class="flex-1">
                    <label class="mb-1 block text-xs text-zinc-500">Config name</label>
                    <input
                        v-model="saveConfigName"
                        type="text"
                        class="input"
                        placeholder="e.g. Production S3"
                        @keyup.enter="onSaveS3Config"
                    />
                </div>
                <button
                    type="button"
                    :disabled="!saveConfigName.trim()"
                    @click="onSaveS3Config"
                    :class="[
                        'rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
                        saveConfigName.trim()
                            ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                            : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                    ]"
                >
                    Save
                </button>
                <button
                    type="button"
                    @click="showSaveDialog = false; saveConfigName = ''"
                    class="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 cursor-pointer"
                >
                    Cancel
                </button>
            </div>
            <div v-if="savedS3Configs.length > 0" class="mb-2">
                <label class="mb-1 block text-xs text-zinc-500">Saved Configuration</label>
                <select
                    v-model="selectedConfigId"
                    @change="selectedConfigId && emit('loadS3Config', selectedConfigId)"
                    class="input w-full"
                >
                    <option value="">Enter manually</option>
                    <option v-for="cfg in savedS3Configs" :key="cfg.id" :value="cfg.id">
                        {{ cfg.name }} ({{ cfg.endPoint }}/{{ cfg.bucket }})
                    </option>
                </select>
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
                    <input v-model="s3.accessKey" type="text" autocomplete="off" class="input" />
                </div>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Secret Key</label>
                    <input v-model="s3.secretKey" type="password" autocomplete="off" class="input" />
                </div>
                <div class="sm:col-span-2 lg:col-span-4">
                    <label class="mb-1 block text-xs text-zinc-500">Path Prefix</label>
                    <input v-model="s3.pathPrefix" type="text" class="input" placeholder="optional/prefix" />
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-4">
                <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" v-model="byteRange" class="accent-indigo-500" />
                    Byte-range segments
                </label>
                <div v-if="byteRange" class="flex items-center gap-2">
                    <label class="text-xs text-zinc-500">Max file size (MB)</label>
                    <input v-model.number="byteRangeMaxFileSizeMB" type="number" min="1" class="input w-24" placeholder="500" />
                </div>
                <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" v-model="thumbnails" class="accent-indigo-500" />
                    Scrubbing thumbnails
                </label>
            </div>
        </fieldset>

        <!-- HLS Encryption -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">HLS Encryption</legend>
            <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" v-model="encryptionEnabled" class="accent-indigo-500" />
                Enable AES-128 encryption
            </label>
            <div v-if="encryptionEnabled">
                <label class="mb-1 block text-xs text-zinc-500">Key URL (production key-serving endpoint)</label>
                <input
                    v-model="encryptionKeyUrl"
                    type="text"
                    class="input"
                    placeholder="https://myapp.example.com/keys/{sessionId}"
                />
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
