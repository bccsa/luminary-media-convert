<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue';
import type { S3Config, CreateSessionRequest } from '../types';
import FileDropZone from './FileDropZone.vue';
import FormSelect from './FormSelect.vue';

export interface SavedS3Config {
    id: string;
    name: string;
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    bucket: string;
    region?: string;
}

const props = withDefaults(defineProps<{
    savedS3Configs?: SavedS3Config[];
    loadedS3Config?: S3Config | null;
    selectedS3ConfigId?: string;
    creatingConfig?: boolean;
}>(), {
    savedS3Configs: () => [],
    loadedS3Config: null,
    selectedS3ConfigId: '',
    creatingConfig: false,
});

export type SubmitPayload =
    | { source: 'file'; config: CreateSessionRequest; file: File; s3ConfigId: string; sessionName: string }
    | { source: 'url'; config: CreateSessionRequest; url: string; filename?: string; s3ConfigId: string; sessionName: string };

const emit = defineEmits<{
    submit: [payload: SubmitPayload];
    loadS3Config: [configId: string];
    createS3Config: [data: { name: string; endPoint: string; port?: number; useSSL?: boolean; bucket: string; region?: string; accessKey: string; secretKey: string }];
}>();

const file = defineModel<File | null>('file', { default: null });
const pathPrefix = defineModel<string>('pathPrefix', { default: '' });

const sessionName = ref('');
const selectedConfigId = ref(props.selectedS3ConfigId);

// Source mode: file (tus upload) or url (server-side fetch)
const SOURCE_MODE_KEY = 'luminary_source_mode';
function loadSourceMode(): 'file' | 'url' {
    try {
        const raw = localStorage.getItem(SOURCE_MODE_KEY);
        if (raw === 'url' || raw === 'file') return raw;
    } catch { /* ignore */ }
    return 'file';
}
const sourceMode = ref<'file' | 'url'>(loadSourceMode());
const sourceUrl = ref('');
const urlFilename = ref('');

watch(sourceMode, (mode) => {
    try { localStorage.setItem(SOURCE_MODE_KEY, mode); } catch { /* ignore */ }
});

watch(() => props.selectedS3ConfigId, (id) => {
    selectedConfigId.value = id;
});

// New config inline form
const showNewConfigForm = ref(false);
const newConfig = reactive({
    name: '',
    endPoint: '',
    port: undefined as number | undefined,
    useSSL: true,
    bucket: '',
    region: '',
    accessKey: '',
    secretKey: '',
});

function resetNewConfig() {
    newConfig.name = '';
    newConfig.endPoint = '';
    newConfig.port = undefined;
    newConfig.useSSL = true;
    newConfig.bucket = '';
    newConfig.region = '';
    newConfig.accessKey = '';
    newConfig.secretKey = '';
}

function onCreateConfig() {
    if (!newConfig.name.trim() || !newConfig.endPoint.trim() || !newConfig.bucket.trim() || !newConfig.accessKey.trim() || !newConfig.secretKey.trim()) return;
    emit('createS3Config', {
        name: newConfig.name.trim(),
        endPoint: newConfig.endPoint.trim(),
        port: newConfig.port,
        useSSL: newConfig.useSSL,
        bucket: newConfig.bucket.trim(),
        region: newConfig.region.trim() || undefined,
        accessKey: newConfig.accessKey.trim(),
        secretKey: newConfig.secretKey.trim(),
    });
    showNewConfigForm.value = false;
    resetNewConfig();
}

// Encoding options (persisted to localStorage)
const BYTE_RANGE_KEY = 'luminary_byte_range';
const MAX_FILE_SIZE_KEY = 'luminary_byte_range_max_mb';
const THUMBNAILS_KEY = 'luminary_thumbnails';
const ENCRYPTION_ENABLED_KEY = 'luminary_encryption_enabled';
const ENCRYPTION_KEY_URL_KEY = 'luminary_encryption_key_url';
const SELECTED_S3_CONFIG_KEY = 'luminary_selected_s3_config';
const PATH_PREFIX_KEY = 'luminary_path_prefix';

function loadByteRange(): boolean {
    try { const raw = localStorage.getItem(BYTE_RANGE_KEY); if (raw != null) return raw === 'true'; } catch { /* ignore */ }
    return true;
}
function loadMaxFileSizeMB(): number {
    try { const raw = localStorage.getItem(MAX_FILE_SIZE_KEY); if (raw) { const val = parseInt(raw, 10); if (val > 0) return val; } } catch { /* ignore */ }
    return 500;
}
function loadThumbnails(): boolean {
    try { const raw = localStorage.getItem(THUMBNAILS_KEY); if (raw != null) return raw === 'true'; } catch { /* ignore */ }
    return true;
}
function loadEncryptionEnabled(): boolean {
    try { const raw = localStorage.getItem(ENCRYPTION_ENABLED_KEY); if (raw != null) return raw === 'true'; } catch { /* ignore */ }
    return true;
}
function loadEncryptionKeyUrl(): string {
    try { return sessionStorage.getItem(ENCRYPTION_KEY_URL_KEY) ?? ''; } catch { /* ignore */ }
    return '';
}

const byteRange = ref(loadByteRange());
const byteRangeMaxFileSizeMB = ref(loadMaxFileSizeMB());
const thumbnails = ref(loadThumbnails());
const encryptionEnabled = ref(loadEncryptionEnabled());
const encryptionKeyUrl = ref(loadEncryptionKeyUrl());

// Restore last selected config + path prefix
try {
    const lastConfigId = localStorage.getItem(SELECTED_S3_CONFIG_KEY);
    if (lastConfigId && !selectedConfigId.value) selectedConfigId.value = lastConfigId;
    pathPrefix.value = localStorage.getItem(PATH_PREFIX_KEY) ?? '';
} catch { /* ignore */ }

// Auto-load the restored config
watch(() => props.savedS3Configs, (configs) => {
    if (selectedConfigId.value && configs.length && !props.loadedS3Config) {
        const exists = configs.find(c => c.id === selectedConfigId.value);
        if (exists) emit('loadS3Config', selectedConfigId.value);
        else selectedConfigId.value = '';
    }
}, { immediate: true });

function savePreferences() {
    localStorage.setItem(BYTE_RANGE_KEY, String(byteRange.value));
    localStorage.setItem(MAX_FILE_SIZE_KEY, String(byteRangeMaxFileSizeMB.value || 500));
    localStorage.setItem(THUMBNAILS_KEY, String(thumbnails.value));
    localStorage.setItem(ENCRYPTION_ENABLED_KEY, String(encryptionEnabled.value));
    sessionStorage.setItem(ENCRYPTION_KEY_URL_KEY, encryptionKeyUrl.value);
    if (selectedConfigId.value) localStorage.setItem(SELECTED_S3_CONFIG_KEY, selectedConfigId.value);
    localStorage.setItem(PATH_PREFIX_KEY, pathPrefix.value);
}

const hasS3Config = computed(() => !!selectedConfigId.value && !!props.loadedS3Config);

const savedS3ConfigOptions = computed(() =>
    props.savedS3Configs.map((cfg) => ({
        value: cfg.id,
        label: `${cfg.name} (${cfg.endPoint}/${cfg.bucket})`,
    })),
);

const isValidUrl = computed(() => {
    const raw = sourceUrl.value.trim();
    if (!raw) return false;
    try {
        const u = new URL(raw);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
});

const canSubmit = computed(() => {
    if (!hasS3Config.value) return false;
    if (encryptionEnabled.value && !encryptionKeyUrl.value.trim()) return false;
    if (sourceMode.value === 'file') {
        if (!file.value) return false;
    } else {
        if (!isValidUrl.value) return false;
    }
    return true;
});

function onSubmit() {
    if (!canSubmit.value || !props.loadedS3Config) return;
    savePreferences();

    const s3: S3Config = {
        ...props.loadedS3Config,
        pathPrefix: pathPrefix.value.trim() || undefined,
    };

    const config: CreateSessionRequest = {
        s3,
        s3ConfigId: selectedConfigId.value,
        byteRange: byteRange.value,
        byteRangeMaxFileSizeMB: byteRange.value ? (byteRangeMaxFileSizeMB.value || 500) : undefined,
        thumbnails: thumbnails.value,
        encryption: {
            enabled: encryptionEnabled.value,
            keyUrl: encryptionEnabled.value ? encryptionKeyUrl.value.trim() : undefined,
        },
    };

    if (sourceMode.value === 'file' && file.value) {
        emit('submit', {
            source: 'file',
            config,
            file: file.value,
            s3ConfigId: selectedConfigId.value,
            sessionName: sessionName.value.trim(),
        });
    } else if (sourceMode.value === 'url') {
        emit('submit', {
            source: 'url',
            config,
            url: sourceUrl.value.trim(),
            filename: urlFilename.value.trim() || undefined,
            s3ConfigId: selectedConfigId.value,
            sessionName: sessionName.value.trim(),
        });
    }
}

function onSelectConfig() {
    if (selectedConfigId.value) {
        emit('loadS3Config', selectedConfigId.value);
    }
}

const canCreateConfig = computed(() =>
    newConfig.name.trim() && newConfig.endPoint.trim() && newConfig.bucket.trim()
    && newConfig.accessKey.trim() && newConfig.secretKey.trim()
    && !props.creatingConfig,
);
</script>

<template>
    <form @submit.prevent="onSubmit" class="space-y-10">
        <!-- Session name -->
        <section class="space-y-4">
            <div class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400"
                    aria-hidden="true"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                        />
                    </svg>
                </span>
                <div>
                    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Session name</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400">Optional — shown in your session history.</p>
                </div>
            </div>
            <input
                v-model="sessionName"
                type="text"
                class="input"
                placeholder="e.g. My project — episode 1"
            />
        </section>

        <div class="border-t border-slate-200/90 dark:border-slate-800" aria-hidden="true" />

        <!-- Storage destination -->
        <section class="space-y-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                    <span
                        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400"
                        aria-hidden="true"
                    >
                        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                            />
                        </svg>
                    </span>
                    <div>
                        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Storage destination</h2>
                        <p class="text-xs text-slate-500 dark:text-slate-400">S3 output bucket and key prefix for this session.</p>
                    </div>
                </div>
                <button
                    v-if="!showNewConfigForm"
                    type="button"
                    class="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                    @click="showNewConfigForm = true"
                >
                    New config
                </button>
            </div>

            <div
                v-if="showNewConfigForm"
                class="space-y-4 rounded-xl border border-indigo-200/80 bg-indigo-50/60 p-4 dark:border-indigo-500/30 dark:bg-indigo-950/25"
            >
                <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">New S3 configuration</h3>
                <div>
                    <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Name</label>
                    <input v-model="newConfig.name" type="text" class="input" placeholder="e.g. Production S3" />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div class="sm:col-span-2">
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Endpoint</label>
                        <input v-model="newConfig.endPoint" type="text" class="input" placeholder="s3.amazonaws.com" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Port</label>
                        <input v-model.number="newConfig.port" type="number" class="input" placeholder="443" />
                    </div>
                    <div class="flex items-end pb-1">
                        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                            <input v-model="newConfig.useSSL" type="checkbox" class="accent-indigo-500" />
                            Use SSL
                        </label>
                    </div>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Bucket</label>
                        <input v-model="newConfig.bucket" type="text" class="input" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Region</label>
                        <input v-model="newConfig.region" type="text" class="input" placeholder="us-east-1" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Access key</label>
                        <input
                            v-model="newConfig.accessKey"
                            type="text"
                            autocomplete="new-password"
                            data-1p-ignore
                            data-lpignore="true"
                            class="input"
                        />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Secret key</label>
                        <input
                            v-model="newConfig.secretKey"
                            type="text"
                            autocomplete="new-password"
                            data-1p-ignore
                            data-lpignore="true"
                            class="input"
                        />
                    </div>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        :disabled="!canCreateConfig"
                        class="rounded-xl px-4 py-2 text-xs font-semibold transition-colors"
                        :class="
                            canCreateConfig
                                ? 'cursor-pointer bg-indigo-600 text-white hover:bg-indigo-500'
                                : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500'
                        "
                        @click="onCreateConfig"
                    >
                        {{ creatingConfig ? 'Saving…' : 'Save config' }}
                    </button>
                    <button
                        type="button"
                        class="cursor-pointer rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                        @click="showNewConfigForm = false; resetNewConfig()"
                    >
                        Cancel
                    </button>
                </div>
            </div>

            <div
                v-else-if="savedS3Configs.length === 0"
                class="rounded-xl border border-dashed border-slate-300 bg-slate-50/80 p-6 text-center dark:border-slate-600 dark:bg-slate-900/50"
            >
                <p class="text-sm text-slate-600 dark:text-slate-400">No S3 configurations saved yet.</p>
                <button
                    type="button"
                    class="mt-3 cursor-pointer text-sm font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                    @click="showNewConfigForm = true"
                >
                    Create one now
                </button>
            </div>

            <div v-else class="grid gap-4 sm:grid-cols-2">
                <div>
                    <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">S3 configuration</label>
                    <FormSelect
                        v-model="selectedConfigId"
                        :options="savedS3ConfigOptions"
                        placeholder="Select a configuration…"
                        @change="onSelectConfig"
                    />
                </div>
                <div>
                    <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Path prefix</label>
                    <input
                        v-model="pathPrefix"
                        type="text"
                        class="input"
                        placeholder="/encoded/v1/year=2024/"
                    />
                    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Output keys are written under this prefix (optional).</p>
                </div>
            </div>

            <div
                v-if="hasS3Config"
                class="flex flex-col gap-4 rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 dark:border-slate-700 dark:bg-slate-900/30 sm:flex-row sm:flex-wrap sm:items-center"
            >
                <label class="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                    <input v-model="byteRange" type="checkbox" class="accent-indigo-500" />
                    Byte-range segments
                </label>
                <div v-if="byteRange" class="flex flex-wrap items-center gap-2">
                    <label class="text-xs font-medium text-slate-500 dark:text-slate-400">Max file size (MB)</label>
                    <input v-model.number="byteRangeMaxFileSizeMB" type="number" min="1" class="input w-28" placeholder="500" />
                </div>
                <label class="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                    <input v-model="thumbnails" type="checkbox" class="accent-indigo-500" />
                    Scrubbing thumbnails
                </label>
            </div>
        </section>

        <div class="border-t border-slate-200/90 dark:border-slate-800" aria-hidden="true" />

        <!-- Source ingest -->
        <section class="space-y-5">
            <div class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400"
                    aria-hidden="true"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                        />
                    </svg>
                </span>
                <div>
                    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Source ingest</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400">HTTPS URL fetch or resumable upload from your machine.</p>
                </div>
            </div>

            <div
                class="inline-flex w-full rounded-xl border border-slate-200 bg-slate-100/90 p-1 dark:border-slate-600 dark:bg-slate-900/80 sm:w-auto"
                role="group"
                aria-label="Ingest method"
            >
                <button
                    type="button"
                    :class="[
                        'min-w-0 flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer sm:flex-none sm:px-5',
                        sourceMode === 'url'
                            ? 'bg-indigo-600 text-white shadow-sm dark:bg-indigo-500'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                    ]"
                    :aria-pressed="sourceMode === 'url'"
                    @click="sourceMode = 'url'"
                >
                    HTTP(S) URL
                </button>
                <button
                    type="button"
                    :class="[
                        'min-w-0 flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer sm:flex-none sm:px-5',
                        sourceMode === 'file'
                            ? 'bg-indigo-600 text-white shadow-sm dark:bg-indigo-500'
                            : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                    ]"
                    :aria-pressed="sourceMode === 'file'"
                    @click="sourceMode = 'file'"
                >
                    Direct upload
                </button>
            </div>

            <FileDropZone v-if="sourceMode === 'file'" @update:file="f => (file = f)" />

            <div v-else class="space-y-3">
                <div>
                    <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Source URL</label>
                    <input
                        v-model="sourceUrl"
                        type="url"
                        class="input"
                        placeholder="https://example.com/recording.mp4"
                    />
                </div>
                <div>
                    <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Filename override (optional)</label>
                    <input v-model="urlFilename" type="text" class="input" placeholder="e.g. meeting.mp4" />
                </div>
                <p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Direct-download links work best (public files, presigned S3, or CDN). The server uses parallel range
                    requests when the origin supports them.
                </p>
            </div>

            <p class="text-xs text-slate-500 dark:text-slate-400">
                Common containers: MP4, MKV, MOV, WebM, and typical audio formats. Direct upload limit:
                <span class="font-medium text-slate-600 dark:text-slate-300">10 GB</span>
                per file unless your session quota is lower.
            </p>
        </section>

        <div class="border-t border-slate-200/90 dark:border-slate-800" aria-hidden="true" />

        <!-- HLS encryption -->
        <section v-if="hasS3Config" class="space-y-4">
            <div class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400"
                    aria-hidden="true"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                        />
                    </svg>
                </span>
                <div>
                    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">HLS encryption</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400">Optional AES-128 for segments (key URL required when enabled).</p>
                </div>
            </div>
            <label class="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                <input v-model="encryptionEnabled" type="checkbox" class="accent-indigo-500" />
                Enable AES-128 encryption
            </label>
            <div v-if="encryptionEnabled">
                <label class="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Key URL (production key endpoint)</label>
                <input
                    v-model="encryptionKeyUrl"
                    type="text"
                    class="input"
                    placeholder="https://myapp.example.com/keys/{sessionId}"
                />
            </div>
        </section>

        <!-- Submit -->
        <div
            class="flex flex-col gap-4 border-t border-slate-200/90 pt-6 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between"
        >
            <p class="flex max-w-xl items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
                <svg
                    class="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
                    />
                </svg>
                <span>
                    Creating a session starts ingest immediately. You can leave this page — uploads continue in the background.
                    Configure renditions after probe completes on the session screen.
                </span>
            </p>
            <button
                type="submit"
                :disabled="!canSubmit"
                :class="[
                    'w-full shrink-0 rounded-xl px-6 py-3.5 text-sm font-semibold shadow-sm transition-colors sm:w-auto sm:min-w-[11rem]',
                    canSubmit
                        ? 'cursor-pointer bg-indigo-600 text-white hover:bg-indigo-500'
                        : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
                ]"
            >
                Create session
            </button>
        </div>
    </form>
</template>
