<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import { listS3Configs, importSession } from '../api';

const { getAccessTokenSilently } = useAuth0();
const router = useRouter();

interface S3ConfigOption {
    id: string;
    name: string;
    endPoint: string;
    bucket: string;
}

const s3Configs = ref<S3ConfigOption[]>([]);
const loadingConfigs = ref(true);

const selectedS3ConfigId = ref('');
const location = ref('');
const encryptionKey = ref('');

const submitting = ref(false);
const error = ref<string | null>(null);

async function fetchS3Configs() {
    loadingConfigs.value = true;
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        s3Configs.value = (result.configs ?? []).map((c: any) => ({
            id: c.id,
            name: c.name,
            endPoint: c.endPoint,
            bucket: c.bucket,
        }));
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loadingConfigs.value = false;
    }
}

function isValid(): boolean {
    if (!selectedS3ConfigId.value) return false;
    if (!location.value.trim()) return false;
    return true;
}

async function handleSubmit() {
    if (!isValid()) return;
    submitting.value = true;
    error.value = null;

    try {
        const token = await getAccessTokenSilently();
        const data: any = {
            s3ConfigId: selectedS3ConfigId.value,
        };

        // Single field — server detects whether it's a master playlist key
        // (ends with .m3u8) or a folder prefix.
        const value = location.value.trim();
        if (value.endsWith('.m3u8')) {
            data.masterPlaylistKey = value;
        } else {
            data.folderPrefix = value;
        }

        if (encryptionKey.value.trim()) {
            data.encryptionKey = encryptionKey.value.trim();
        }

        const result = await importSession(token, data);
        const sessionId = result.id || result.sessionId;
        router.push(`/sessions/${sessionId}`);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        submitting.value = false;
    }
}

onMounted(fetchS3Configs);
</script>

<template>
    <div class="max-w-2xl mx-auto">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <!-- Back link -->
            <div class="mb-4">
                <router-link
                    to="/sessions"
                    class="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Sessions
                </router-link>
            </div>

            <h2 class="text-lg font-semibold text-zinc-100 mb-6">Import Session</h2>

            <!-- Loading S3 configs -->
            <div v-if="loadingConfigs" class="flex justify-center py-8">
                <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>

            <form v-else @submit.prevent="handleSubmit" class="space-y-5">
                <!-- S3 Config selection -->
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">S3 Configuration</label>
                    <select
                        v-model="selectedS3ConfigId"
                        class="input"
                    >
                        <option value="" disabled>Select an S3 configuration</option>
                        <option
                            v-for="config in s3Configs"
                            :key="config.id"
                            :value="config.id"
                        >
                            {{ config.name }} ({{ config.endPoint }}/{{ config.bucket }})
                        </option>
                    </select>
                    <p v-if="s3Configs.length === 0" class="mt-1 text-xs text-zinc-500">
                        No S3 configurations found.
                        <router-link to="/s3-configs" class="text-indigo-400 hover:text-indigo-300">Create one first.</router-link>
                    </p>
                </div>

                <!-- Location: either a master playlist key or a folder prefix -->
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">Location</label>
                    <input
                        v-model="location"
                        type="text"
                        class="input"
                        placeholder="path/to/master.m3u8 or path/to/folder/"
                    />
                    <p class="mt-1 text-xs text-zinc-500">
                        Paste a playlist URL or folder path. The folder will be scanned for
                        all top-level HLS playlists, each imported as a separate angle.
                    </p>
                </div>

                <!-- Encryption key (optional) -->
                <div>
                    <label class="mb-1 block text-xs text-zinc-500">
                        Encryption Key
                        <span class="text-zinc-600">(optional, hex string)</span>
                    </label>
                    <input
                        v-model="encryptionKey"
                        type="text"
                        class="input font-mono"
                        placeholder="00112233445566778899aabbccddeeff"
                    />
                </div>

                <!-- Error -->
                <div v-if="error" class="rounded-lg bg-red-950/40 border border-red-800/50 p-3">
                    <p class="text-sm text-red-400">{{ error }}</p>
                </div>

                <!-- Actions -->
                <div class="flex gap-3">
                    <button
                        type="submit"
                        :disabled="!isValid() || submitting"
                        :class="[
                            'rounded-lg px-6 py-3 text-sm font-semibold transition-colors',
                            isValid() && !submitting
                                ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                        ]"
                    >
                        {{ submitting ? 'Importing...' : 'Import Session' }}
                    </button>
                    <router-link
                        to="/sessions"
                        class="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
                    >
                        Cancel
                    </router-link>
                </div>
            </form>
        </div>
    </div>
</template>
