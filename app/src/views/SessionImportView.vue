<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import { listS3Configs, importSession } from '../api';
import FormSelect from '../components/FormSelect.vue';

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

const s3ImportConfigOptions = computed(() =>
    s3Configs.value.map((c) => ({
        value: c.id,
        label: `${c.name} (${c.endPoint}/${c.bucket})`,
    })),
);

const submitting = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const locationKind = computed<'empty' | 'master' | 'folder'>(() => {
    const v = location.value.trim();
    if (!v) return 'empty';
    if (v.endsWith('.m3u8')) return 'master';
    return 'folder';
});

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
        const langs: string[] = Array.isArray(result.chaptersLanguages) ? result.chaptersLanguages : [];
        if (langs.length > 0) {
            successMessage.value = `Chapters detected: ${langs.join(', ')}`;
            await new Promise((r) => setTimeout(r, 900));
        }
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
    <div class="app-view w-full max-w-none">
        <div class="mx-auto w-full max-w-7xl px-4 transition-all duration-300 sm:px-6">
            <div class="mb-6">
                <router-link
                    to="/sessions"
                    class="inline-flex items-center gap-1.5 text-sm text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to sessions
                </router-link>
            </div>

            <header class="mb-8 max-w-3xl">
                <div class="flex flex-wrap items-center gap-3 gap-y-2">
                    <div
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-600/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-400"
                        aria-hidden="true"
                    >
                        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                            />
                        </svg>
                    </div>
                    <div>
                        <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                            Import HLS from S3
                        </h1>
                        <p class="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                            Register an existing Apple HLS package in your bucket as a session—playback, chapters, and
                            delivery tools work the same as encoded outputs.
                        </p>
                    </div>
                </div>
            </header>

            <div class="grid gap-8 lg:grid-cols-12 lg:items-start">
                <div class="lg:col-span-8">
                    <section
                        class="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/60 dark:shadow-black/20 dark:ring-white/10"
                    >
                        <div class="p-5 sm:p-6 lg:p-8">
                            <div v-if="loadingConfigs" class="flex flex-col items-center gap-4 py-14">
                                <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-950/40">
                                    <svg class="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" fill="none" viewBox="0 0 24 24">
                                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                </div>
                                <p class="text-sm font-medium text-slate-600 dark:text-slate-400">Loading S3 configurations…</p>
                            </div>

                            <form v-else @submit.prevent="handleSubmit" class="space-y-8">
                                <!-- S3 -->
                                <div class="space-y-2">
                                    <div class="flex items-baseline justify-between gap-2">
                                        <label for="import-s3" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                                            S3 configuration
                                        </label>
                                        <span class="text-xs font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Required</span>
                                    </div>
                                    <FormSelect
                                        id="import-s3"
                                        variant="field"
                                        v-model="selectedS3ConfigId"
                                        :options="s3ImportConfigOptions"
                                        placeholder="Choose where the package lives"
                                    />
                                    <p v-if="s3Configs.length === 0" class="text-xs text-slate-500 dark:text-slate-400">
                                        No saved configs yet.
                                        <router-link
                                            to="/s3-configs"
                                            class="font-medium text-slate-600 hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-300"
                                        >
                                            Add an S3 configuration
                                        </router-link>
                                        first.
                                    </p>
                                </div>

                                <!-- Location -->
                                <div class="space-y-2">
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <label for="import-location" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                                            Package location
                                        </label>
                                        <span
                                            v-if="locationKind === 'master'"
                                            class="rounded-md bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
                                        >
                                            Master playlist
                                        </span>
                                        <span
                                            v-else-if="locationKind === 'folder'"
                                            class="rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
                                        >
                                            Folder prefix
                                        </span>
                                    </div>
                                    <input
                                        id="import-location"
                                        v-model="location"
                                        type="text"
                                        class="input"
                                        placeholder="e.g. productions/ep42/hls/master.m3u8 or productions/ep42/hls/"
                                        autocomplete="off"
                                    />
                                    <p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                                        Key ending in
                                        <kbd class="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600 dark:bg-slate-800">.m3u8</kbd>
                                        imports that master. Otherwise the value is treated as a
                                        <strong class="font-medium text-slate-700 dark:text-slate-300">prefix</strong>;
                                        top-level playlists in that path are discovered (multi-angle).
                                    </p>
                                </div>

                                <!-- Encryption -->
                                <div class="space-y-2 rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700/60 dark:bg-slate-800/30">
                                    <label for="import-key" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                                        AES-128 key
                                        <span class="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
                                    </label>
                                    <input
                                        id="import-key"
                                        v-model="encryptionKey"
                                        type="text"
                                        class="input font-mono text-sm"
                                        placeholder="64-character hex, e.g. 00112233445566778899aabbccddeeff"
                                        spellcheck="false"
                                    />
                                    <p class="text-xs text-slate-500 dark:text-slate-400">
                                        Only if segments are encrypted and you want in-browser playback without fetching the key from the playlist URL.
                                    </p>
                                </div>

                                <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40">
                                    <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
                                </div>

                                <div
                                    v-if="successMessage"
                                    class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/35"
                                >
                                    <p class="text-sm text-emerald-800 dark:text-emerald-200">{{ successMessage }}</p>
                                </div>

                                <div class="flex flex-wrap gap-3 pt-2">
                                    <button
                                        type="submit"
                                        :disabled="!isValid() || submitting"
                                        :class="[
                                            'inline-flex min-h-[2.75rem] items-center justify-center rounded-xl px-6 text-sm font-semibold transition-colors',
                                            isValid() && !submitting
                                                ? 'bg-slate-800 text-white shadow-sm hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600'
                                                : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
                                        ]"
                                    >
                                        {{ submitting ? 'Importing…' : 'Import to session' }}
                                    </button>
                                    <router-link
                                        to="/sessions"
                                        class="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border border-slate-300 bg-white px-6 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                    >
                                        Cancel
                                    </router-link>
                                </div>
                            </form>
                        </div>
                    </section>
                </div>

                <aside class="lg:col-span-4" aria-label="Import tips">
                    <div
                        class="sticky top-6 space-y-6 rounded-2xl border border-slate-200/90 bg-slate-50/90 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/40 dark:ring-white/5 sm:p-6"
                    >
                        <div>
                            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                How import works
                            </h2>
                            <ol class="mt-3 list-decimal space-y-3 pl-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                                <li>We read your master (or scan the folder) using the credentials from the selected config.</li>
                                <li>A session is created with status <strong class="font-medium text-slate-800 dark:text-slate-200">Imported</strong>.</li>
                                <li>Open it like any session: preview, chapters, rename prefix, or move outputs.</li>
                            </ol>
                        </div>
                        <div class="border-t border-slate-200/80 pt-5 dark:border-slate-700/80">
                            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                Path examples
                            </h2>
                            <dl class="mt-3 space-y-3 text-xs">
                                <div class="rounded-lg border border-slate-200/80 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-800/50">
                                    <dt class="font-mono text-[11px] text-slate-800 dark:text-slate-200">…/out/master.m3u8</dt>
                                    <dd class="mt-1 text-slate-500 dark:text-slate-400">Single package from that master.</dd>
                                </div>
                                <div class="rounded-lg border border-slate-200/80 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-800/50">
                                    <dt class="font-mono text-[11px] text-slate-800 dark:text-slate-200">…/angles/</dt>
                                    <dd class="mt-1 text-slate-500 dark:text-slate-400">Prefix; each top-level <kbd class="font-mono">*.m3u8</kbd> becomes an angle.</dd>
                                </div>
                            </dl>
                        </div>
                        <div class="border-t border-slate-200/80 pt-5 dark:border-slate-700/80">
                            <p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                                Keys and objects are validated server-side. If import fails, check the path, permissions, and that the playlist matches your bucket region.
                            </p>
                        </div>
                    </div>
                </aside>
            </div>
        </div>
    </div>
</template>
