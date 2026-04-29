<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import SessionConfigForm from '../components/SessionConfigForm.vue';
import type { SavedS3Config, SubmitPayload } from '../components/SessionConfigForm.vue';
import { createSession, uploadFile, startUrlUpload, listS3Configs, getS3Config, createS3Config, updateSessionName, checkPrefix } from '../api';
import { useActiveUploads } from '../composables/useActiveUploads';
import type { CreateSessionRequest, S3Config } from '../types';

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

const { getAccessTokenSilently } = useAuth0();
const router = useRouter();
const { register: registerUpload, setProgress } = useActiveUploads();

const submissionError = ref<string | null>(null);
const submitting = ref(false);
const validating = ref(false);
const prefixWarning = ref<string | null>(null);
const pendingPayload = ref<SubmitPayload | null>(null);

const savedS3Configs = ref<SavedS3Config[]>([]);
const loadedS3Config = ref<S3Config | null>(null);
const selectedS3ConfigId = ref('');
const creatingConfig = ref(false);
const formPathPrefix = ref('');

// Dismiss the prefix warning if the user edits the prefix directly
watch(formPathPrefix, () => {
    if (prefixWarning.value) {
        prefixWarning.value = null;
        pendingPayload.value = null;
    }
});

async function fetchSavedS3Configs() {
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        savedS3Configs.value = (result.configs ?? []).map((c: any) => ({
            id: c.id,
            name: c.name,
            endPoint: c.endPoint,
            port: c.port,
            useSSL: c.useSSL,
            bucket: c.bucket,
            region: c.region,
        }));
    } catch {
        // Non-critical
    }
}

async function onLoadS3Config(configId: string) {
    try {
        const token = await getAccessTokenSilently();
        const config = await getS3Config(token, configId);
        loadedS3Config.value = {
            endPoint: config.endPoint,
            port: config.port,
            useSSL: config.useSSL,
            bucket: config.bucket,
            region: config.region,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
            publicUrl: config.publicUrl,
        };
    } catch {
        // Non-critical
    }
}

async function onCreateS3Config(data: Record<string, any>) {
    creatingConfig.value = true;
    try {
        const token = await getAccessTokenSilently();
        const created = await createS3Config(token, data);
        await fetchSavedS3Configs();
        selectedS3ConfigId.value = created.id;
        await onLoadS3Config(created.id);
    } catch {
        // Non-critical
    } finally {
        creatingConfig.value = false;
    }
}

async function onUploadSubmit(payload: SubmitPayload) {
    submissionError.value = null;
    prefixWarning.value = null;
    pendingPayload.value = null;

    // Check if the prefix already contains files in the target bucket
    const prefix = payload.config.s3.pathPrefix?.trim();
    if (prefix && payload.s3ConfigId) {
        validating.value = true;
        try {
            const token = await getAccessTokenSilently();
            const result = await checkPrefix(token, payload.s3ConfigId, prefix);
            if (result.exists) {
                prefixWarning.value = `The prefix "${prefix}" already contains ${result.count} file(s) in this bucket. Encoding will add files alongside them, which may overwrite existing files with the same names.`;
                pendingPayload.value = payload;
                return;
            }
        } catch {
            // Non-critical — proceed without warning
        } finally {
            validating.value = false;
        }
    }

    await startUpload(payload);
}

function dismissPrefixWarning() {
    prefixWarning.value = null;
    pendingPayload.value = null;
}

async function confirmPrefixOverwrite() {
    if (!pendingPayload.value) return;
    const payload = pendingPayload.value;
    prefixWarning.value = null;
    pendingPayload.value = null;
    await startUpload(payload);
}

async function startUpload(payload: SubmitPayload) {
    submitting.value = true;
    submissionError.value = null;

    try {
        const accessToken = await getAccessTokenSilently();

        if (payload.source === 'file' && payload.file.size > 10 * 1024 * 1024 * 1024) {
            throw new Error(
                `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(10 * 1024 * 1024 * 1024)})`,
            );
        }

        // Create session via SaaS Service
        const session = await createSession(payload.config, accessToken);

        // Set session name if provided (fire-and-forget)
        if (payload.sessionName) {
            updateSessionName(accessToken, session.sessionId, payload.sessionName).catch(() => {});
        }

        if (payload.source === 'file') {
            if (payload.file.size > session.maxUploadSize) {
                throw new Error(
                    `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(session.maxUploadSize)})`,
                );
            }

            // Start upload via tus — registered in singleton store so it survives navigation
            const tusEndpoint = `${session.encodingApiUrl}/api/tus`;
            const { promise, abort } = uploadFile(
                tusEndpoint,
                session.sessionId,
                session.sessionToken,
                payload.file,
                (percent) => setProgress(session.sessionId, percent),
            );

            registerUpload(session.sessionId, abort, promise);
        } else {
            // URL ingestion — server-side download. Progress arrives via SSE/poll.
            await startUrlUpload(session.sessionId, payload.url, accessToken, payload.filename);
        }

        // Navigate to unified session view — upload continues in background
        router.push(`/sessions/${session.sessionId}`);
    } catch (e) {
        submissionError.value = e instanceof Error ? e.message : String(e);
    } finally {
        submitting.value = false;
    }
}

onMounted(fetchSavedS3Configs);
</script>

<template>
    <div class="max-w-2xl mx-auto">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <!-- Prefix overwrite warning -->
            <div
                v-if="prefixWarning"
                class="mb-6 rounded-lg bg-amber-950/40 border border-amber-800/50 p-4 space-y-3"
            >
                <p class="text-sm text-amber-400">{{ prefixWarning }}</p>
                <div class="flex gap-2">
                    <button
                        type="button"
                        class="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 cursor-pointer"
                        @click="confirmPrefixOverwrite"
                    >
                        Continue Anyway
                    </button>
                    <button
                        type="button"
                        class="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 cursor-pointer"
                        @click="dismissPrefixWarning"
                    >
                        Revise Prefix
                    </button>
                </div>
            </div>

            <!-- Submission error banner -->
            <div
                v-if="submissionError"
                class="mb-6 rounded-lg bg-red-950/40 border border-red-800/50 p-4"
            >
                <p class="text-sm text-red-400">{{ submissionError }}</p>
            </div>

            <!-- Validating / Submitting spinner -->
            <div v-if="validating || submitting" class="flex flex-col items-center gap-4 py-16">
                <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-sm text-zinc-400">{{ validating ? 'Validating...' : 'Creating session...' }}</p>
            </div>

            <!-- Session config form (kept mounted to preserve file selection) -->
            <SessionConfigForm
                v-show="!validating && !submitting"
                v-model:path-prefix="formPathPrefix"
                :saved-s3-configs="savedS3Configs"
                :loaded-s3-config="loadedS3Config"
                :selected-s3-config-id="selectedS3ConfigId"
                :creating-config="creatingConfig"
                @submit="onUploadSubmit"
                @load-s3-config="onLoadS3Config"
                @create-s3-config="onCreateS3Config"
            />
        </div>
    </div>
</template>
