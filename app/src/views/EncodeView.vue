<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import SessionConfigForm from '../components/SessionConfigForm.vue';
import type { SavedS3Config } from '../components/SessionConfigForm.vue';
import { createSession, uploadFile, listS3Configs, getS3Config, createS3Config } from '../api';
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

const savedS3Configs = ref<SavedS3Config[]>([]);
const loadedS3Config = ref<S3Config | null>(null);
const selectedS3ConfigId = ref('');
const creatingConfig = ref(false);

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

async function onUploadSubmit(payload: {
    config: CreateSessionRequest;
    file: File;
    s3ConfigId: string;
}) {
    submitting.value = true;
    submissionError.value = null;

    try {
        const accessToken = await getAccessTokenSilently();

        if (payload.file.size > 10 * 1024 * 1024 * 1024) {
            throw new Error(
                `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(10 * 1024 * 1024 * 1024)})`,
            );
        }

        // Create session via SaaS Service
        const session = await createSession(payload.config, accessToken);

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
            <!-- Submission error banner -->
            <div
                v-if="submissionError"
                class="mb-6 rounded-lg bg-red-950/40 border border-red-800/50 p-4"
            >
                <p class="text-sm text-red-400">{{ submissionError }}</p>
            </div>

            <!-- Submitting spinner -->
            <div v-if="submitting" class="flex flex-col items-center gap-4 py-16">
                <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-sm text-zinc-400">Creating session...</p>
            </div>

            <!-- Session config form -->
            <SessionConfigForm
                v-else
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
