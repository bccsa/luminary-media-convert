<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import EncodePipelineAside from '../components/EncodePipelineAside.vue';
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

        const trimmedName = payload.sessionName?.trim() ?? '';
        if (trimmedName) {
            // Must finish before navigate — otherwise SessionView often loads before the name exists.
            await updateSessionName(accessToken, session.sessionId, trimmedName);
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
                class="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            >
                <svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back to sessions
            </router-link>
            <header class="space-y-2">
                <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                    Create new encoding session
                </h1>
                <p class="max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                    Choose S3 storage and how you want to ingest source media. After create, we probe the file and prepare
                    encoding options on the session screen.
                </p>
            </header>
        </div>

        <div class="grid gap-8 lg:grid-cols-12 lg:items-start">
            <div class="lg:col-span-8">
                <section
                    class="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/60 dark:shadow-black/20 dark:ring-white/10"
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
                                    class="cursor-pointer rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
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
                            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-950/40">
                                <svg class="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" fill="none" viewBox="0 0 24 24">
                                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            </div>
                            <p class="text-sm font-medium text-slate-600 dark:text-slate-400">
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

            <aside class="lg:col-span-4" aria-label="Session overview">
                <EncodePipelineAside />
            </aside>
        </div>
    </div>
</template>
