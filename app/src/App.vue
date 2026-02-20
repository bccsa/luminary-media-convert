<script setup lang="ts">
import { ref } from 'vue';
import SessionConfigForm from './components/SessionConfigForm.vue';
import SessionProgress from './components/SessionProgress.vue';
import { createSession, uploadFile } from './api';
import { useSessionPoller } from './composables/useSessionPoller';
import type { CreateSessionRequest, Credentials, S3Config } from './types';

type View = 'config' | 'submitting' | 'progress';

const view = ref<View>('config');
const sessionId = ref('');
const apiBaseUrl = ref('http://localhost:3000');
const submissionError = ref<string | null>(null);
const s3PublicBaseUrl = ref('');
const encodingType = ref<'video' | 'audio'>('video');

function buildS3PublicBaseUrl(s3: S3Config): string {
    const protocol = s3.useSSL === false ? 'http' : 'https';
    const port = s3.port ? `:${s3.port}` : '';
    return `${protocol}://${s3.endPoint}${port}/${s3.bucket}`;
}

const poller = useSessionPoller();

async function onSubmit(payload: {
    config: CreateSessionRequest;
    credentials: Credentials;
    file: File;
}) {
    view.value = 'submitting';
    submissionError.value = null;

    try {
        s3PublicBaseUrl.value = buildS3PublicBaseUrl(payload.config.s3);
        encodingType.value = payload.config.type;

        const session = await createSession(apiBaseUrl.value, payload.config, payload.credentials);
        sessionId.value = session.sessionId;

        await uploadFile(apiBaseUrl.value, session.sessionId, session.uploadToken, payload.file);

        view.value = 'progress';
        poller.start(apiBaseUrl.value, session.sessionId, payload.credentials);
    } catch (e) {
        submissionError.value = e instanceof Error ? e.message : String(e);
        view.value = 'config';
    }
}

function reset() {
    poller.stop();
    view.value = 'config';
    sessionId.value = '';
    submissionError.value = null;
    s3PublicBaseUrl.value = '';
    encodingType.value = 'video';
}
</script>

<template>
    <div class="mx-auto max-w-2xl px-4 py-12">
        <header class="mb-8 text-center">
            <h1 class="text-2xl font-bold tracking-tight text-zinc-100">Luminary Media Convert</h1>
            <p class="mt-1 text-sm text-zinc-500">HLS / ABR encoding client</p>
        </header>

        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <!-- Submission error banner -->
            <div
                v-if="submissionError"
                class="mb-6 rounded-lg bg-red-950/40 border border-red-800/50 p-4"
            >
                <p class="text-sm text-red-400">{{ submissionError }}</p>
            </div>

            <!-- Config form -->
            <SessionConfigForm
                v-if="view === 'config'"
                v-model:apiBaseUrl="apiBaseUrl"
                @submit="onSubmit"
            />

            <!-- Submitting spinner -->
            <div v-else-if="view === 'submitting'" class="flex flex-col items-center gap-4 py-16">
                <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-sm text-zinc-400">Creating session and uploading file...</p>
            </div>

            <!-- Progress display -->
            <SessionProgress
                v-else
                :session-id="sessionId"
                :status="poller.status.value"
                :progress="poller.progress.value"
                :queue-position="poller.queuePosition.value"
                :files="poller.files.value"
                :master-playlist="poller.masterPlaylist.value"
                :error="poller.error.value"
                :s3-public-base-url="s3PublicBaseUrl"
                :encoding-type="encodingType"
                @reset="reset"
            />
        </div>
    </div>
</template>
