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

        const session = await createSession(payload.config, accessToken);

        if (payload.sessionName) {
            updateSessionName(accessToken, session.sessionId, payload.sessionName).catch(() => {});
        }

        if (payload.source === 'file') {
            if (payload.file.size > session.maxUploadSize) {
                throw new Error(
                    `File size (${formatBytes(payload.file.size)}) exceeds the maximum allowed upload size (${formatBytes(session.maxUploadSize)})`,
                );
            }

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
            await startUrlUpload(session.sessionId, payload.url, accessToken, payload.filename);
        }

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
    <div class="app-view font-sans">
        <div class="mb-6 lg:mb-8">
            <router-link
                to="/sessions"
                class="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
                <svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back to sessions
            </router-link>
            <header class="space-y-2">
                <h1 class="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    Create new encoding session
                </h1>
                <p class="max-w-2xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                    Choose S3 storage and how you want to ingest source media. After create, we probe the file and prepare
                    encoding options on the session screen.
                </p>
            </header>
        </div>

        <div class="grid gap-8 lg:grid-cols-12 lg:items-start">
            <div class="lg:col-span-8">
                <section
                    class="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-black/20 dark:ring-white/10"
                >
                    <div class="p-5 sm:p-6 lg:p-8">
                        <div
                            v-if="prefixWarning"
                            class="mb-6 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-950/30"
                        >
                            <p class="text-sm text-amber-900 dark:text-amber-300">{{ prefixWarning }}</p>
                            <div class="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    class="cursor-pointer rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-500"
                                    @click="confirmPrefixOverwrite"
                                >
                                    Continue anyway
                                </button>
                                <button
                                    type="button"
                                    class="cursor-pointer rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                    @click="dismissPrefixWarning"
                                >
                                    Revise prefix
                                </button>
                            </div>
                        </div>

                        <div
                            v-if="submissionError"
                            class="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40"
                        >
                            <p class="text-sm text-red-800 dark:text-red-400">{{ submissionError }}</p>
                        </div>

                        <div v-if="validating || submitting" class="flex flex-col items-center gap-4 py-16">
                            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/40">
                                <svg class="h-6 w-6 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            </div>
                            <p class="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                                {{ validating ? 'Validating prefix…' : 'Creating session…' }}
                            </p>
                        </div>

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
                </section>
            </div>

            <aside class="flex flex-col gap-4 lg:col-span-4" aria-label="Session overview">
                <div
                    class="relative overflow-hidden rounded-2xl bg-zinc-900 px-5 py-6 text-white shadow-lg shadow-zinc-900/20 ring-1 ring-white/10 dark:ring-white/5"
                >
                    <svg
                        class="pointer-events-none absolute -right-4 -top-4 h-28 w-28 text-white/[0.06]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="1"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
                        />
                    </svg>
                    <p class="relative text-sm font-semibold text-zinc-100">Encoding workflow</p>
                    <p class="relative mt-2 text-xs leading-relaxed text-zinc-400">
                        Ingest is resumable (tus) or fetched from a URL. The service probes your media, transcodes to ABR HLS,
                        then writes segments and manifests to the prefix you choose — with optional AES-128 and byte-range
                        packaging.
                    </p>
                </div>

                <div
                    class="rounded-2xl border border-zinc-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-zinc-900/5 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10"
                >
                    <h2 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Pipeline preview</h2>
                    <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">What happens after you create a session.</p>
                    <ol class="mt-4 space-y-4">
                        <li class="flex gap-3">
                            <span
                                class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                            >
                                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                            </span>
                            <div>
                                <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">Ingest</p>
                                <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                    Upload from disk or let the API download from HTTPS.
                                </p>
                            </div>
                        </li>
                        <li class="flex gap-3">
                            <span
                                class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
                            >
                                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-2.25 0H18"
                                    />
                                </svg>
                            </span>
                            <div>
                                <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">Analyze &amp; configure</p>
                                <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                    ffprobe-driven track metadata; you confirm renditions on the session page.
                                </p>
                            </div>
                        </li>
                        <li class="flex gap-3">
                            <span
                                class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                            >
                                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.196-5.454.5.5 0 01-.637-.114L9.73 7.63a.75.75 0 01-.365-.263L8.46 5.43a.75.75 0 00-1.138-.086L4.772 7.138a.75.75 0 01-.46.143H2.25z"
                                    />
                                </svg>
                            </span>
                            <div>
                                <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">Encode &amp; deliver</p>
                                <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                    Queue encodes HLS to your bucket prefix; optional thumbnails and encryption.
                                </p>
                            </div>
                        </li>
                    </ol>
                </div>

                <div
                    class="rounded-2xl border border-zinc-200/80 bg-gradient-to-br from-zinc-900 via-zinc-800 to-indigo-950 p-5 shadow-md ring-1 ring-white/10 dark:border-zinc-700"
                >
                    <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-indigo-300/95">Luminary Media Convert</p>
                    <p class="mt-2 text-xs leading-relaxed text-zinc-400">ABR HLS output, S3-native delivery, real-time session progress.</p>
                </div>
            </aside>
        </div>
    </div>
</template>
