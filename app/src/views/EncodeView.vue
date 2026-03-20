<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import SessionConfigForm from '../components/SessionConfigForm.vue';
import type { SavedS3Config } from '../components/SessionConfigForm.vue';
import { EncodeConfigForm, computeLayoutKey, saveConfig } from '@luminary-media-converter/encode-config';
import type { ProbeResult, EncodeConfig } from '@luminary-media-converter/encode-config';
import SessionProgress from '../components/SessionProgress.vue';
import { createSession, uploadFile, getSessionStatus, subscribeSessionEvents, startEncode, deleteSession, listS3Configs, getS3Config, createS3Config, getSessionDetail } from '../api';
import { useSessionPoller } from '../composables/useSessionPoller';
import type { CreateSessionRequest, S3Config } from '../types';

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

type View = 'config' | 'uploading' | 'configure' | 'submitting' | 'progress';

const { getAccessTokenSilently } = useAuth0();

const view = ref<View>('config');
const sessionId = ref('');
const encodingApiUrl = ref('');
const sessionToken = ref('');
const submissionError = ref<string | null>(null);
const uploadProgress = ref(0);
const s3PublicBaseUrl = ref('');
const encodingType = ref<'video' | 'audio'>('video');
const probeResult = ref<ProbeResult | null>(null);
const s3Config = ref<S3Config | null>(null);
const byteRangeEnabled = ref(true);

const savedS3Configs = ref<SavedS3Config[]>([]);
const loadedS3Config = ref<S3Config | null>(null);
const selectedS3ConfigId = ref('');
const encryptionKeyHex = ref<string | undefined>();

async function fetchSavedS3Configs() {
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        savedS3Configs.value = (result.configs ?? []).map((c: any) => ({
            id: c.id,
            name: c.name,
            endPoint: c.endPoint,
            bucket: c.bucket,
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
            pathPrefix: config.pathPrefix,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
        };
    } catch {
        // Non-critical
    }
}

const creatingConfig = ref(false);

async function onCreateS3Config(data: Record<string, any>) {
    creatingConfig.value = true;
    try {
        const token = await getAccessTokenSilently();
        const created = await createS3Config(token, data);
        await fetchSavedS3Configs();
        selectedS3ConfigId.value = created.id;
        // Auto-load the newly created config
        await onLoadS3Config(created.id);
    } catch {
        // Non-critical
    } finally {
        creatingConfig.value = false;
    }
}

onMounted(fetchSavedS3Configs);

function buildS3PublicBaseUrl(s3: S3Config): string {
    const protocol = s3.useSSL === false ? 'http' : 'https';
    const port = s3.port ? `:${s3.port}` : '';
    return `${protocol}://${s3.endPoint}${port}/${s3.bucket}`;
}

const poller = useSessionPoller();

// Fetch encryption key when encoding completes with encryption
watch(
    [() => poller.status.value, () => poller.previewBaseUrl.value],
    async ([status, previewBase]) => {
        if (status === 'completed' && previewBase && sessionId.value && !encryptionKeyHex.value) {
            try {
                const token = await getAccessTokenSilently();
                const detail = await getSessionDetail(token, sessionId.value);
                encryptionKeyHex.value = detail.encryptionKeyHex;
            } catch {
                // Non-critical — key display is informational
            }
        }
    },
);

let abortUpload: (() => void) | null = null;
let isCancelling = false;

function waitForProbe(
    apiUrl: string,
    sid: string,
    token: string,
): Promise<ProbeResult | null> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            es?.close();
            reject(new Error('Probe timed out'));
        }, 30000);

        const es = subscribeSessionEvents(apiUrl, sid, token, (event) => {
            if ((event as any).probeResult) {
                clearTimeout(timeout);
                es.close();
                resolve((event as any).probeResult);
            }
        }, () => {
            // SSE failed — fall back to polling
            es.close();
            clearTimeout(timeout);
            pollForProbe(apiUrl, sid, token).then(resolve).catch(reject);
        });
    });
}

async function pollForProbe(
    apiUrl: string,
    sid: string,
    token: string,
): Promise<ProbeResult | null> {
    for (let i = 0; i < 60; i++) {
        const data = await getSessionStatus(apiUrl, sid, token);
        if (data.probeResult) return data.probeResult;
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

async function onUploadSubmit(payload: {
    config: CreateSessionRequest;
    file: File;
    s3ConfigId: string;
}) {
    view.value = 'uploading';
    submissionError.value = null;
    uploadProgress.value = 0;

    try {
        const accessToken = await getAccessTokenSilently();
        s3Config.value = payload.config.s3;
        byteRangeEnabled.value = payload.config.byteRange !== false;
        s3PublicBaseUrl.value = buildS3PublicBaseUrl(payload.config.s3);

        // Create session via SaaS Service (Auth0 JWT)
        const session = await createSession(payload.config, accessToken);
        sessionId.value = session.sessionId;
        encodingApiUrl.value = session.encodingApiUrl;
        sessionToken.value = session.sessionToken;

        if (payload.file.size > session.maxUploadSize) {
            throw new Error(
                `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(session.maxUploadSize)})`,
            );
        }

        // Upload directly to Encoding API via tus (session token)
        const tusEndpoint = `${session.encodingApiUrl}/api/tus`;
        const { promise, abort } = uploadFile(
            tusEndpoint,
            session.sessionId,
            session.sessionToken,
            payload.file,
            (percent) => { uploadProgress.value = percent; },
        );
        abortUpload = abort;

        await promise;
        abortUpload = null;

        // Wait for probe results via SSE (with polling fallback)
        const probeData = await waitForProbe(
            session.encodingApiUrl,
            session.sessionId,
            session.sessionToken,
        );

        probeResult.value = probeData;
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
            // Delete via SaaS Service (Auth0 JWT)
            const accessToken = await getAccessTokenSilently();
            await deleteSession(sessionId.value, accessToken);
        } catch {
            // Best-effort cleanup
        }
        resetSessionState();
    }

    isCancelling = false;
}

async function onEncodeSubmit(config: EncodeConfig) {
    view.value = 'submitting';
    submissionError.value = null;

    try {
        encodingType.value = config.type;

        // Start encode on Encoding API (session token)
        const { audioTrackMetadata: _, ...apiConfig } = config;
        await startEncode(
            encodingApiUrl.value,
            sessionId.value,
            apiConfig,
            sessionToken.value,
        );

        if (probeResult.value) {
            const layoutKey = computeLayoutKey(probeResult.value, config.type);
            saveConfig(layoutKey, config);
        }

        view.value = 'progress';
        poller.start(sessionId.value, encodingApiUrl.value, sessionToken.value);
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
    resetSessionState();
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
    resetSessionState();
    submissionError.value = null;
    uploadProgress.value = 0;
    s3PublicBaseUrl.value = '';
    encodingType.value = 'video';
    probeResult.value = null;
    s3Config.value = null;
    byteRangeEnabled.value = true;
}

function resetSessionState() {
    sessionId.value = '';
    encodingApiUrl.value = '';
    sessionToken.value = '';
}

function reset() {
    poller.stop();
    view.value = 'config';
    resetSessionState();
    submissionError.value = null;
    uploadProgress.value = 0;
    s3PublicBaseUrl.value = '';
    encodingType.value = 'video';
    probeResult.value = null;
    s3Config.value = null;
    byteRangeEnabled.value = true;
    encryptionKeyHex.value = undefined;
}
</script>

<template>
    <div :class="['mx-auto transition-all duration-300', view === 'configure' ? 'max-w-fit' : 'max-w-2xl']">
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
                :saved-s3-configs="savedS3Configs"
                :loaded-s3-config="loadedS3Config"
                :selected-s3-config-id="selectedS3ConfigId"
                :creating-config="creatingConfig"
                @submit="onUploadSubmit"
                @load-s3-config="onLoadS3Config"
                @create-s3-config="onCreateS3Config"
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
                :encryption-key-hex="encryptionKeyHex"
                @reset="reset"
                @cancel="onCancelEncode"
            />
        </div>
    </div>
</template>
