<script setup lang="ts">
import { ref } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import SessionConfigForm from './components/SessionConfigForm.vue';
import { EncodeConfigForm, computeLayoutKey, saveConfig } from '@luminary-media-converter/encode-config';
import type { ProbeResult, EncodeConfig } from '@luminary-media-converter/encode-config';
import SessionProgress from './components/SessionProgress.vue';
import { createSession, uploadFile, getSessionStatus, startEncode, deleteSession } from './api';
import { useSessionPoller } from './composables/useSessionPoller';
import type { CreateSessionRequest, S3Config } from './types';

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

type View = 'config' | 'uploading' | 'configure' | 'submitting' | 'progress';

const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently, user } = useAuth0();
const returnTo = window.location.origin;

const view = ref<View>('config');
const sessionId = ref('');
const submissionError = ref<string | null>(null);
const uploadProgress = ref(0);
const s3PublicBaseUrl = ref('');
const encodingType = ref<'video' | 'audio'>('video');
const probeResult = ref<ProbeResult | null>(null);
const s3Config = ref<S3Config | null>(null);
const byteRangeEnabled = ref(true);

function buildS3PublicBaseUrl(s3: S3Config): string {
    const protocol = s3.useSSL === false ? 'http' : 'https';
    const port = s3.port ? `:${s3.port}` : '';
    return `${protocol}://${s3.endPoint}${port}/${s3.bucket}`;
}

const poller = useSessionPoller();

let abortUpload: (() => void) | null = null;
let isCancelling = false;

async function onUploadSubmit(payload: {
    config: CreateSessionRequest;
    file: File;
}) {
    view.value = 'uploading';
    submissionError.value = null;
    uploadProgress.value = 0;

    try {
        const accessToken = await getAccessTokenSilently();
        s3Config.value = payload.config.s3;
        byteRangeEnabled.value = payload.config.byteRange !== false;
        s3PublicBaseUrl.value = buildS3PublicBaseUrl(payload.config.s3);

        const session = await createSession(payload.config, accessToken);
        sessionId.value = session.sessionId;

        if (payload.file.size > session.maxUploadSize) {
            throw new Error(
                `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(session.maxUploadSize)})`,
            );
        }

        const { promise, abort } = uploadFile(
            session.tusEndpoint,
            session.sessionId,
            session.uploadToken,
            payload.file,
            (percent) => { uploadProgress.value = percent; },
        );
        abortUpload = abort;

        await promise;
        abortUpload = null;

        // With tusd, the post-finish hook (which probes the file) runs after
        // the upload response is sent to the client. Poll until probe results
        // are available (session status becomes 'uploaded').
        let status: Awaited<ReturnType<typeof getSessionStatus>>;
        for (let i = 0; i < 60; i++) {
            status = await getSessionStatus(session.sessionId, accessToken);
            if (status.probeResult) break;
            await new Promise((r) => setTimeout(r, 500));
        }

        probeResult.value = status!.probeResult ?? null;
        encodingType.value = probeResult.value?.videoTracks.length ? 'video' : 'audio';

        view.value = 'configure';
    } catch (e) {
        abortUpload = null;
        if (!isCancelling) {
            submissionError.value = e instanceof Error ? e.message : String(e);
            view.value = 'config';
        }
    }
}

async function cancelUpload() {
    isCancelling = true;
    abortUpload?.();
    abortUpload = null;

    view.value = 'config';
    uploadProgress.value = 0;

    if (sessionId.value) {
        try {
            const accessToken = await getAccessTokenSilently();
            await deleteSession(sessionId.value, accessToken);
        } catch {
            // Best-effort cleanup
        }
        sessionId.value = '';
    }

    isCancelling = false;
}

async function onEncodeSubmit(config: EncodeConfig) {
    view.value = 'submitting';
    submissionError.value = null;

    try {
        const accessToken = await getAccessTokenSilently();
        encodingType.value = config.type;

        const { audioTrackMetadata: _, ...apiConfig } = config;
        await startEncode(sessionId.value, apiConfig, accessToken);

        if (probeResult.value) {
            const layoutKey = computeLayoutKey(probeResult.value, config.type);
            saveConfig(layoutKey, config);
        }

        view.value = 'progress';
        poller.start(sessionId.value, () => getAccessTokenSilently());
    } catch (e) {
        submissionError.value = e instanceof Error ? e.message : String(e);
        view.value = 'configure';
    }
}

async function onEncodeBack() {
    if (sessionId.value) {
        try {
            const accessToken = await getAccessTokenSilently();
            await deleteSession(sessionId.value, accessToken);
        } catch {
            // Best-effort cleanup — server will eventually garbage-collect
        }
    }
    view.value = 'config';
    sessionId.value = '';
    probeResult.value = null;
}

async function onCancelEncode() {
    poller.stop();

    if (sessionId.value) {
        try {
            const accessToken = await getAccessTokenSilently();
            await deleteSession(sessionId.value, accessToken);
        } catch {
            // Best-effort cleanup
        }
    }

    view.value = 'config';
    sessionId.value = '';
    submissionError.value = null;
    uploadProgress.value = 0;
    s3PublicBaseUrl.value = '';
    encodingType.value = 'video';
    probeResult.value = null;
    s3Config.value = null;
    byteRangeEnabled.value = true;
}

function reset() {
    poller.stop();
    view.value = 'config';
    sessionId.value = '';
    submissionError.value = null;
    uploadProgress.value = 0;
    s3PublicBaseUrl.value = '';
    encodingType.value = 'video';
    probeResult.value = null;
    s3Config.value = null;
    byteRangeEnabled.value = true;
}
</script>

<template>
    <div :class="['mx-auto px-4 py-12 transition-all duration-300', view === 'configure' ? 'max-w-fit' : 'max-w-2xl']">
        <header class="mb-8 text-center">
            <h1 class="text-2xl font-bold tracking-tight text-zinc-100">Luminary Media Convert</h1>
            <p class="mt-1 text-sm text-zinc-500">HLS / ABR encoding client</p>
        </header>

        <!-- Loading state while Auth0 initializes -->
        <div v-if="isLoading" class="flex justify-center py-16">
            <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <!-- Login prompt -->
        <div v-else-if="!isAuthenticated" class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur text-center">
            <p class="mb-4 text-sm text-zinc-400">Sign in to start an encoding session.</p>
            <button
                @click="loginWithRedirect()"
                class="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 cursor-pointer"
            >
                Sign In
            </button>
        </div>

        <!-- Authenticated content -->
        <template v-else>
            <!-- User bar -->
            <div class="mb-4 flex items-center justify-end gap-3 text-sm text-zinc-400">
                <span>{{ user?.email }}</span>
                <button
                    @click="logout({ logoutParams: { returnTo } })"
                    class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                >
                    Sign Out
                </button>
            </div>

            <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
                <!-- Submission error banner -->
                <div
                    v-if="submissionError"
                    class="mb-6 rounded-lg bg-red-950/40 border border-red-800/50 p-4"
                >
                    <p class="text-sm text-red-400">{{ submissionError }}</p>
                </div>

                <!-- Step 1: S3 config + file selection -->
                <SessionConfigForm
                    v-if="view === 'config'"
                    @submit="onUploadSubmit"
                />

                <!-- Upload progress -->
                <div v-else-if="view === 'uploading'" class="flex flex-col items-center gap-4 py-16">
                    <div class="w-full max-w-xs">
                        <div class="mb-2 flex items-center justify-between text-sm text-zinc-400">
                            <span>{{ uploadProgress >= 100 ? 'Analyzing...' : 'Uploading...' }}</span>
                            <span>{{ uploadProgress }}%</span>
                        </div>
                        <div class="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                            <div
                                class="h-full rounded-full bg-indigo-500 transition-all duration-300"
                                :style="{ width: `${uploadProgress}%` }"
                            />
                        </div>
                    </div>
                    <button
                        v-if="uploadProgress < 100"
                        type="button"
                        class="rounded-lg border border-zinc-700 px-6 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                        @click="cancelUpload"
                    >
                        Cancel
                    </button>
                </div>

                <!-- Step 2: Review probe results + configure encoding -->
                <EncodeConfigForm
                    v-else-if="view === 'configure' && probeResult"
                    :probe-result="probeResult"
                    :byte-range="byteRangeEnabled"
                    @submit="onEncodeSubmit"
                    @back="onEncodeBack"
                />

                <!-- Submitting encoding config spinner -->
                <div v-else-if="view === 'submitting'" class="flex flex-col items-center gap-4 py-16">
                    <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <p class="text-sm text-zinc-400">Starting encoding...</p>
                </div>

                <!-- Step 3: Progress display -->
                <SessionProgress
                    v-else-if="view === 'progress'"
                    :session-id="sessionId"
                    :status="poller.status.value"
                    :progress="poller.progress.value"
                    :queue-position="poller.queuePosition.value"
                    :files="poller.files.value"
                    :master-playlist="poller.masterPlaylist.value"
                    :angle-playlists="poller.anglePlaylists.value"
                    :error="poller.error.value"
                    :encoder="poller.encoder.value"
                    :segment-format="poller.segmentFormat.value"
                    :s3-public-base-url="s3PublicBaseUrl"
                    :encoding-type="encodingType"
                    :thumbnails-vtt="poller.thumbnailsVtt.value"
                    :preview-base-url="poller.previewBaseUrl.value"
                    :preview-token="poller.previewToken.value"
                    @reset="reset"
                    @cancel="onCancelEncode"
                />
            </div>
        </template>
    </div>
</template>
