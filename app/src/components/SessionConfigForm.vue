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
    <form @submit.prevent="onSubmit" class="space-y-5">
        <!-- Session name -->
        <fieldset class="space-y-1 rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/30">
            <legend class="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Session Name</legend>
            <input
                v-model="sessionName"
                type="text"
                class="input"
                placeholder="e.g. My Project — Episode 1"
            />
        </fieldset>

        <!-- Source: file or URL -->
        <fieldset class="space-y-1 rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/30">
            <legend class="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Source</legend>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">Choose a local upload or let the server ingest from URL.</p>
            <div class="inline-flex rounded-lg border border-zinc-300 bg-white p-1 text-sm dark:border-zinc-700 dark:bg-zinc-900/40">
                <button
                    type="button"
                    :class="[
                        'rounded-md px-4  py-1.5 transition-colors cursor-pointer',
                        sourceMode === 'file'
                            ? 'bg-indigo-600 text-white'
                            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
                    ]"
                    @click="sourceMode = 'file'"
                >
                    From disk
                </button>
                <button
                    type="button"
                    :class="[
                        'rounded-md px-4 py-1.5 transition-colors cursor-pointer',
                        sourceMode === 'url'
                            ? 'bg-indigo-600 text-white'
                            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
                    ]"
                    @click="sourceMode = 'url'"
                >
                    From URL
                </button>
            </div>

            <FileDropZone v-if="sourceMode === 'file'" @update:file="f => (file = f)" />

            <div v-else class="space-y-2">
                <input
                    v-model="sourceUrl"
                    type="url"
                    class="input"
                    placeholder="https://example.com/recording.mp4"
                />
                <input
                    v-model="urlFilename"
                    type="text"
                    class="input"
                    placeholder="Optional filename override (e.g. meeting.mp4)"
                />
                <p class="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    The server downloads from this URL using parallel HTTP range requests when supported.
                    Use a direct-download URL — public file URLs, S3 presigned links, or Google Drive direct download links.
                </p>
            </div>
        </fieldset>

        <!-- S3 Configuration -->
        <fieldset class="space-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/30">
            <div class="flex items-center justify-between">
                <legend class="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">S3 Storage</legend>
                <button
                    v-if="!showNewConfigForm"
                    type="button"
                    @click="showNewConfigForm = true"
                    class="cursor-pointer rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                    New config
                </button>
            </div>

            <!-- Inline new config form -->
            <div v-if="showNewConfigForm" class="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-800/40 dark:bg-indigo-950/20">
                <h4 class="text-sm font-medium text-zinc-900 dark:text-zinc-200">New S3 Configuration</h4>
                <div>
                    <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Name</label>
                    <input v-model="newConfig.name" type="text" class="input" placeholder="e.g. Production S3" />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div class="sm:col-span-2">
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Endpoint</label>
                        <input v-model="newConfig.endPoint" type="text" class="input" placeholder="s3.amazonaws.com" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Port</label>
                        <input v-model.number="newConfig.port" type="number" class="input" placeholder="443" />
                    </div>
                    <div class="flex items-end pb-1">
                        <label class="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                            <input type="checkbox" v-model="newConfig.useSSL" class="accent-indigo-500" />
                            Use SSL
                        </label>
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Bucket</label>
                        <input v-model="newConfig.bucket" type="text" class="input" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Region</label>
                        <input v-model="newConfig.region" type="text" class="input" placeholder="us-east-1" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Access Key</label>
                        <input v-model="newConfig.accessKey" type="text" autocomplete="new-password" data-1p-ignore data-lpignore="true" class="input" />
                    </div>
                    <div>
                        <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Secret Key</label>
                        <input v-model="newConfig.secretKey" type="text" autocomplete="new-password" data-1p-ignore data-lpignore="true" class="input" />
                    </div>
                </div>
                <div class="flex gap-2">
                    <button
                        type="button"
                        :disabled="!canCreateConfig"
                        @click="onCreateConfig"
                        :class="[
                            'rounded-lg px-4 py-2 text-xs font-semibold transition-colors',
                            canCreateConfig
                                ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                                : 'bg-zinc-200 text-zinc-500 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-500',
                        ]"
                    >
                        {{ creatingConfig ? 'Saving...' : 'Save Config' }}
                    </button>
                    <button
                        type="button"
                        @click="showNewConfigForm = false; resetNewConfig()"
                        class="cursor-pointer rounded-lg border border-zinc-300 px-4 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                        Cancel
                    </button>
                </div>
            </div>

            <!-- Config selector -->
            <div v-if="savedS3Configs.length > 0 && !showNewConfigForm">
                <FormSelect
                    v-model="selectedConfigId"
                    :options="savedS3ConfigOptions"
                    placeholder="Select an S3 configuration..."
                    @change="onSelectConfig"
                />
            </div>

            <div v-if="savedS3Configs.length === 0 && !showNewConfigForm" class="rounded-lg border border-zinc-200 bg-zinc-100/70 p-4 text-center dark:border-zinc-800 dark:bg-zinc-900/60">
                <p class="text-sm text-zinc-600 dark:text-zinc-400">No S3 configurations saved yet.</p>
                <button
                    type="button"
                    @click="showNewConfigForm = true"
                    class="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 cursor-pointer"
                >
                    Create one now
                </button>
            </div>

            <!-- Path prefix (per-upload) -->
            <div v-if="hasS3Config">
                <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Path Prefix (per upload)</label>
                <input v-model="pathPrefix" type="text" class="input" placeholder="optional/prefix" />
            </div>

            <!-- Encoding options -->
            <div v-if="hasS3Config" class="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-200 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                <label class="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input type="checkbox" v-model="byteRange" class="accent-indigo-500" />
                    Byte-range segments
                </label>
                <div v-if="byteRange" class="flex items-center gap-2">
                    <label class="text-xs text-zinc-500 dark:text-zinc-400">Max file size (MB)</label>
                    <input v-model.number="byteRangeMaxFileSizeMB" type="number" min="1" class="input w-24" placeholder="500" />
                </div>
                <label class="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input type="checkbox" v-model="thumbnails" class="accent-indigo-500" />
                    Scrubbing thumbnails
                </label>
            </div>
        </fieldset>

        <!-- HLS Encryption -->
        <fieldset v-if="hasS3Config" class="space-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/30">
            <legend class="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">HLS Encryption</legend>
            <label class="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input type="checkbox" v-model="encryptionEnabled" class="accent-indigo-500" />
                Enable AES-128 encryption
            </label>
            <div v-if="encryptionEnabled">
                <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Key URL (production key-serving endpoint)</label>
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
                    : 'bg-zinc-200 text-zinc-500 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-500',
            ]"
        >
            Upload &amp; Analyze
        </button>
    </form>
</template>
