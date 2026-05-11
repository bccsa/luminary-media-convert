<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { listS3Configs, createS3Config, getS3Config, updateS3Config, deleteS3Config } from '../api';
import ConfirmDangerModal from '../components/ConfirmDangerModal.vue';

interface S3ConfigEntry {
    id: string;
    name: string;
    endPoint: string;
    port?: number;
    useSSL: boolean;
    bucket: string;
    region?: string;
    publicUrl?: string;
    createdAt: string;
}

interface S3ConfigForm {
    name: string;
    endPoint: string;
    port: number | undefined;
    useSSL: boolean;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    publicUrl: string;
}

type ProviderTone = 'aws' | 'r2' | 'do' | 'gcs' | 'b2' | 'minio' | 'generic';

const { getAccessTokenSilently } = useAuth0();

const configs = ref<S3ConfigEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const showFormModal = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const loadingConfig = ref(false);

const deleteModalOpen = ref(false);
const deleteTarget = ref<{ id: string; name: string; bucket: string } | null>(null);
const deleting = ref(false);

const filterQuery = ref('');
const page = ref(1);
const PAGE_SIZE = 8;

function emptyForm(): S3ConfigForm {
    return {
        name: '',
        endPoint: '',
        port: undefined,
        useSSL: true,
        bucket: '',
        region: '',
        accessKey: '',
        secretKey: '',
        publicUrl: '',
    };
}

const form = reactive<S3ConfigForm>(emptyForm());

function resetForm() {
    Object.assign(form, emptyForm());
    formError.value = null;
}

const tlsEnabledCount = computed(() => configs.value.filter((c) => c.useSSL !== false).length);
const withPublicUrlCount = computed(() => configs.value.filter((c) => (c.publicUrl ?? '').trim().length > 0).length);
const distinctRegionCount = computed(() => {
    const set = new Set(
        configs.value.map((c) => (c.region ?? '').trim()).filter(Boolean),
    );
    return set.size;
});

const filteredConfigs = computed(() => {
    const q = filterQuery.value.trim().toLowerCase();
    if (!q) return configs.value;
    return configs.value.filter((c) => {
        const prov = providerFromEndpoint(c.endPoint).label.toLowerCase();
        return (
            c.name.toLowerCase().includes(q)
            || c.endPoint.toLowerCase().includes(q)
            || c.bucket.toLowerCase().includes(q)
            || (c.region ?? '').toLowerCase().includes(q)
            || prov.includes(q)
        );
    });
});

const totalFiltered = computed(() => filteredConfigs.value.length);
const totalPages = computed(() => Math.max(1, Math.ceil(totalFiltered.value / PAGE_SIZE)));

const paginatedConfigs = computed(() => {
    const start = (page.value - 1) * PAGE_SIZE;
    return filteredConfigs.value.slice(start, start + PAGE_SIZE);
});

watch([filterQuery, totalFiltered], () => {
    page.value = 1;
});

watch(totalPages, (tp) => {
    if (page.value > tp) page.value = tp;
});

function endpointDisplay(c: S3ConfigEntry): string {
    const p = c.port ? `:${c.port}` : '';
    return `${c.endPoint}${p}`;
}

function providerFromEndpoint(endPoint: string): { label: string; tone: ProviderTone } {
    const h = (endPoint || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (h.includes('r2.cloudflarestorage.com')) return { label: 'Cloudflare R2', tone: 'r2' };
    if (h.includes('amazonaws.com') || h === 's3.amazonaws.com') return { label: 'Amazon S3', tone: 'aws' };
    if (h.includes('digitaloceanspaces.com')) return { label: 'DigitalOcean Spaces', tone: 'do' };
    if (h.includes('storage.googleapis.com')) return { label: 'Google Cloud Storage', tone: 'gcs' };
    if (h.includes('backblazeb2.com')) return { label: 'Backblaze B2', tone: 'b2' };
    if (h.includes('minio')) return { label: 'MinIO', tone: 'minio' };
    return { label: 'S3-compatible', tone: 'generic' };
}

function providerIconWrapClass(tone: ProviderTone): string {
    const map: Record<ProviderTone, string> = {
        aws: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
        r2: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
        do: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
        gcs: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
        b2: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400',
        minio: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
        generic: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    };
    return map[tone];
}

function regionPill(c: S3ConfigEntry): string {
    const r = (c.region ?? '').trim();
    if (r) return r;
    return '—';
}

function isRegionBadgeEmpty(c: S3ConfigEntry): boolean {
    return !(c.region ?? '').trim();
}

function goPage(delta: number) {
    page.value = Math.min(totalPages.value, Math.max(1, page.value + delta));
}

async function fetchConfigs() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        configs.value = result.configs ?? [];
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

function openCreateForm() {
    resetForm();
    editingId.value = null;
    showFormModal.value = true;
}

async function openEditForm(configId: string) {
    resetForm();
    editingId.value = configId;
    showFormModal.value = true;
    loadingConfig.value = true;

    try {
        const token = await getAccessTokenSilently();
        const data = await getS3Config(token, configId);
        form.name = data.name || '';
        form.endPoint = data.endPoint || '';
        form.port = data.port;
        form.useSSL = data.useSSL !== false;
        form.bucket = data.bucket || '';
        form.region = data.region || '';
        form.publicUrl = data.publicUrl || '';
        form.accessKey = '';
        form.secretKey = '';
    } catch (e) {
        formError.value = e instanceof Error ? e.message : String(e);
    } finally {
        loadingConfig.value = false;
    }
}

function closeForm() {
    if (saving.value) return;
    showFormModal.value = false;
    editingId.value = null;
    resetForm();
}

function onFormModalKeydown(e: KeyboardEvent) {
    if (!showFormModal.value || saving.value || loadingConfig.value) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeForm();
    }
}

function validateForm(): boolean {
    return !!(form.name.trim() && form.endPoint.trim() && form.bucket.trim());
}

async function handleSubmit() {
    if (!validateForm()) return;
    saving.value = true;
    formError.value = null;

    try {
        const token = await getAccessTokenSilently();

        const payload: Record<string, any> = {
            name: form.name.trim(),
            endPoint: form.endPoint.trim(),
            useSSL: form.useSSL,
            bucket: form.bucket.trim(),
        };

        if (form.port) payload.port = form.port;
        if (form.region.trim()) payload.region = form.region.trim();
        if (form.publicUrl.trim()) {
            payload.publicUrl = form.publicUrl.trim();
        } else if (editingId.value) {
            payload.publicUrl = '';
        }

        if (editingId.value) {
            if (form.accessKey.trim()) payload.accessKey = form.accessKey.trim();
            if (form.secretKey.trim()) payload.secretKey = form.secretKey.trim();
            await updateS3Config(token, editingId.value, payload);
        } else {
            payload.accessKey = form.accessKey.trim();
            payload.secretKey = form.secretKey.trim();
            await createS3Config(token, payload);
        }

        saving.value = false;
        closeForm();
        await fetchConfigs();
    } catch (e) {
        formError.value = e instanceof Error ? e.message : String(e);
    } finally {
        saving.value = false;
    }
}

function openDeleteModal(config: S3ConfigEntry) {
    deleteTarget.value = { id: config.id, name: config.name, bucket: config.bucket };
    deleteModalOpen.value = true;
}

async function confirmDeleteS3Config() {
    const id = deleteTarget.value?.id;
    if (!id) return;
    deleting.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        await deleteS3Config(token, id);
        deleteModalOpen.value = false;
        deleteTarget.value = null;
        await fetchConfigs();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        deleting.value = false;
    }
}

function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

onMounted(() => {
    fetchConfigs();
    window.addEventListener('keydown', onFormModalKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onFormModalKeydown));
</script>

<template>
    <div class="app-view w-full max-w-none">
        <div class="mx-auto w-full max-w-7xl px-4 transition-all duration-300 sm:px-6">
            <header class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div class="max-w-2xl">
                    <h1 class="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                        S3 storage configs
                    </h1>
                    <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        Manage object storage destinations for encoded output. Credentials are stored encrypted and are only used server-side when creating sessions.
                    </p>
                </div>
                <button
                    type="button"
                    class="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 dark:bg-indigo-600 dark:hover:bg-indigo-500"
                    @click="openCreateForm"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Add config
                </button>
            </header>

            <div class="mb-8 grid gap-4 sm:grid-cols-3">
                <div
                    class="flex items-center gap-4 rounded-2xl border border-zinc-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375"
                            />
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Saved destinations</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                            {{ loading ? '—' : configs.length }}
                        </p>
                        <p class="mt-1 flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <span class="text-emerald-600 dark:text-emerald-400">✓</span>
                            Ready to select when encoding
                        </p>
                    </div>
                </div>
                <div
                    class="flex items-center gap-4 rounded-2xl border border-zinc-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
                            />
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">TLS to endpoint</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                            {{ loading ? '—' : tlsEnabledCount }}
                        </p>
                        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Configs with SSL enabled</p>
                    </div>
                </div>
                <div
                    class="flex items-center gap-4 rounded-2xl border border-zinc-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950/35 dark:text-violet-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
                            />
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Distinct regions</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                            {{ loading ? '—' : distinctRegionCount }}
                        </p>
                        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <template v-if="!loading">{{ withPublicUrlCount }} with optional public URL</template>
                        </p>
                    </div>
                </div>
            </div>

            <section
                class="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10"
            >
                <div class="flex flex-col gap-4 border-b border-zinc-200/80 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-700/80">
                    <h2 class="text-base font-semibold text-zinc-900 dark:text-zinc-100">Storage buckets</h2>
                    <div class="w-full sm:max-w-xs">
                        <label for="s3-filter" class="sr-only">Filter configs</label>
                        <input
                            id="s3-filter"
                            v-model="filterQuery"
                            type="search"
                            placeholder="Filter configs…"
                            class="input w-full text-sm"
                            autocomplete="off"
                        />
                    </div>
                </div>

                <div v-if="loading" class="flex flex-col items-center gap-4 py-16">
                    <div class="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/40">
                        <svg class="h-6 w-6 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    </div>
                    <p class="text-sm text-zinc-600 dark:text-zinc-400">Loading configurations…</p>
                </div>

                <div v-else-if="error" class="p-6">
                    <div class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/35">
                        <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
                    </div>
                </div>

                <div v-else-if="configs.length === 0" class="px-6 py-16 text-center">
                    <p class="text-sm text-zinc-600 dark:text-zinc-400">No storage configurations yet. Add one to use it when creating encoding sessions.</p>
                    <button
                        type="button"
                        class="mt-4 text-sm font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                        @click="openCreateForm"
                    >
                        Add config
                    </button>
                </div>

                <template v-else>
                    <div v-if="filteredConfigs.length === 0" class="px-6 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                        No configs match your filter.
                    </div>
                    <div v-else class="overflow-x-auto">
                        <table class="w-full min-w-[800px] text-left text-sm">
                            <thead>
                                <tr class="border-b border-zinc-200 bg-zinc-50/80 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                                    <th class="px-5 py-3">Name</th>
                                    <th class="px-5 py-3">Endpoint</th>
                                    <th class="px-5 py-3">Bucket</th>
                                    <th class="px-5 py-3">Region</th>
                                    <th class="px-5 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                                <tr v-for="config in paginatedConfigs" :key="config.id">
                                    <td class="px-5 py-4">
                                        <div class="flex items-start gap-3">
                                            <div
                                                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                                                :class="providerIconWrapClass(providerFromEndpoint(config.endPoint).tone)"
                                            >
                                                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"
                                                    />
                                                </svg>
                                            </div>
                                            <div class="min-w-0">
                                                <p class="font-medium text-zinc-900 dark:text-zinc-100">{{ config.name }}</p>
                                                <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                                    {{ providerFromEndpoint(config.endPoint).label }}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="px-5 py-4 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                                        {{ endpointDisplay(config) }}
                                    </td>
                                    <td class="px-5 py-4 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                                        {{ config.bucket }}
                                    </td>
                                    <td class="px-5 py-4">
                                        <span
                                            class="inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums"
                                            :class="
                                                isRegionBadgeEmpty(config)
                                                    ? 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-400'
                                                    : 'border-zinc-200 bg-white text-zinc-800 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200'
                                            "
                                        >
                                            {{ regionPill(config) }}
                                        </span>
                                    </td>
                                    <td class="px-5 py-4 text-right align-middle">
                                        <div class="inline-flex items-center justify-end gap-1">
                                            <button
                                                type="button"
                                                class="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                                title="Edit"
                                                @click="openEditForm(config.id)"
                                            >
                                                <span class="sr-only">Edit {{ config.name }}</span>
                                                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                                                    />
                                                </svg>
                                            </button>
                                            <button
                                                type="button"
                                                class="inline-flex cursor-pointer rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/35"
                                                :disabled="deleting"
                                                @click="openDeleteModal(config)"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div
                        v-if="filteredConfigs.length > 0"
                        class="flex flex-col items-center justify-between gap-3 border-t border-zinc-200/80 px-5 py-4 sm:flex-row dark:border-zinc-800"
                    >
                        <p class="text-xs text-zinc-500 dark:text-zinc-400">
                            Showing
                            <span class="font-medium text-zinc-700 dark:text-zinc-300">{{ (page - 1) * PAGE_SIZE + 1 }}</span>
                            –
                            <span class="font-medium text-zinc-700 dark:text-zinc-300">{{ Math.min(page * PAGE_SIZE, totalFiltered) }}</span>
                            of
                            <span class="font-medium text-zinc-700 dark:text-zinc-300">{{ totalFiltered }}</span>
                            storage configurations
                        </p>
                        <div class="flex items-center gap-2">
                            <button
                                type="button"
                                class="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 enabled:hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:enabled:hover:bg-zinc-800"
                                :disabled="page <= 1"
                                @click="goPage(-1)"
                            >
                                Previous
                            </button>
                            <span class="min-w-[3rem] text-center text-xs font-medium text-zinc-600 dark:text-zinc-400">{{ page }} / {{ totalPages }}</span>
                            <button
                                type="button"
                                class="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 enabled:hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:enabled:hover:bg-zinc-800"
                                :disabled="page >= totalPages"
                                @click="goPage(1)"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </template>
            </section>

            <div class="mt-8 grid gap-6 pb-12 lg:grid-cols-2">
                <div
                    class="rounded-2xl border border-indigo-200/60 bg-indigo-50/40 p-5 dark:border-indigo-900/40 dark:bg-indigo-950/20 sm:p-6"
                >
                    <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Secure credentials</h3>
                    <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        Access keys are encrypted at rest in the app database and are not returned after you save them. Prefer narrow IAM
                        policies (or equivalent) scoped to a single bucket prefix, and rotate keys if they are exposed.
                    </p>
                    <ul class="mt-4 space-y-2 text-xs text-zinc-600 dark:text-zinc-400">
                        <li class="flex items-center gap-2">
                            <span class="text-emerald-600 dark:text-emerald-400" aria-hidden="true">✓</span>
                            HTTPS recommended for compatible endpoints (TLS toggle)
                        </li>
                        <li class="flex items-center gap-2">
                            <span class="text-emerald-600 dark:text-emerald-400" aria-hidden="true">✓</span>
                            Optional public URL for custom domains (e.g. R2)
                        </li>
                    </ul>
                </div>
                <div
                    class="rounded-2xl border border-zinc-200/90 bg-gradient-to-br from-zinc-50 to-zinc-100/80 p-5 shadow-sm ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:from-zinc-900/50 dark:to-zinc-950/80 dark:ring-white/5 sm:p-6"
                >
                    <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Connectivity</h3>
                    <p class="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                        Use the hostname your provider documents (virtual-hosted or path-style as required). Set region when your provider needs it for signing (for example AWS S3). Wrong endpoint or region often shows up as signature or access errors during upload.
                    </p>
                    <p class="mt-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        Tip: create separate configs per environment (staging vs production).
                    </p>
                </div>
            </div>
        </div>

        <ConfirmDangerModal
            v-model:open="deleteModalOpen"
            title="Delete storage configuration"
            confirm-label="Delete"
            cancel-label="Cancel"
            loading-label="Deleting…"
            :loading="deleting"
            @confirm="confirmDeleteS3Config"
        >
            <p>
                Do you want to remove
                <span class="font-medium text-zinc-900 dark:text-zinc-200">{{
                    deleteTarget?.name?.trim() || 'this configuration'
                }}</span>
                <template v-if="deleteTarget?.bucket">
                    (<span class="font-mono text-xs">{{ deleteTarget.bucket }}</span>)
                </template>
                from your account?<br /><br /> Existing sessions that reference this configuration may fail until you choose another destination. This cannot be undone.
            </p>
        </ConfirmDangerModal>
        <Teleport to="body">
            <div
                v-if="showFormModal"
                class="fixed inset-0 z-[100] flex items-center justify-center p-4"
                role="dialog"
                aria-modal="true"
                :aria-labelledby="editingId ? 's3-edit-modal-title' : 's3-create-modal-title'"
            >
                <button
                    type="button"
                    class="absolute inset-0 bg-zinc-900/50 backdrop-blur-[1px] dark:bg-black/60"
                    aria-label="Close"
                    :disabled="saving || loadingConfig"
                    @click="closeForm"
                />
                <div
                    class="relative max-h-[min(90vh,700px)] w-full max-w-[40rem] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-white/10"
                    @click.stop
                >
                    <div class="flex items-start justify-between gap-4">
                        <div>
                            <h2
                                :id="editingId ? 's3-edit-modal-title' : 's3-create-modal-title'"
                                class="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                            >
                                {{ editingId ? 'Edit configuration' : 'New configuration' }}
                            </h2>
                            <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                                S3-compatible storage: endpoint, bucket, and credentials for uploads.
                            </p>
                        </div>
                        <button
                            type="button"
                            class="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                            :disabled="saving || loadingConfig"
                            aria-label="Close dialog"
                            @click="closeForm"
                        >
                            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    <div v-if="loadingConfig" class="flex justify-center py-12">
                        <svg class="h-8 w-8 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    </div>

                    <form v-else class="mt-5 space-y-4" @submit.prevent="handleSubmit">
                        <div>
                            <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-name">Name</label>
                            <input id="s3-form-name" v-model="form.name" type="text" class="input w-full" placeholder="My S3 config" />
                        </div>

                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div class="sm:col-span-2">
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-endpoint">Endpoint</label>
                                <input id="s3-form-endpoint" v-model="form.endPoint" type="text" class="input w-full" placeholder="s3.amazonaws.com" />
                            </div>
                            <div>
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-port">Port</label>
                                <input id="s3-form-port" v-model.number="form.port" type="number" class="input w-full" placeholder="443" />
                            </div>
                            <div class="flex items-end pb-2">
                                <label class="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                                    <input v-model="form.useSSL" type="checkbox" class="accent-indigo-600" />
                                    Use SSL
                                </label>
                            </div>
                            <div>
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-bucket">Bucket</label>
                                <input id="s3-form-bucket" v-model="form.bucket" type="text" class="input w-full" />
                            </div>
                            <div>
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-region">Region</label>
                                <input id="s3-form-region" v-model="form.region" type="text" class="input w-full" placeholder="us-east-1" />
                            </div>
                        </div>

                        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-ak">
                                    Access key
                                    <span v-if="editingId" class="font-normal text-zinc-500 dark:text-zinc-500">(optional)</span>
                                </label>
                                <input
                                    id="s3-form-ak"
                                    v-model="form.accessKey"
                                    type="text"
                                    autocomplete="new-password"
                                    data-1p-ignore
                                    data-lpignore="true"
                                    class="input w-full font-mono text-sm"
                                    :placeholder="editingId ? 'Leave blank to keep current' : ''"
                                />
                            </div>
                            <div>
                                <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-sk">
                                    Secret key
                                    <span v-if="editingId" class="font-normal text-zinc-500 dark:text-zinc-500">(optional)</span>
                                </label>
                                <input
                                    id="s3-form-sk"
                                    v-model="form.secretKey"
                                    type="password"
                                    autocomplete="new-password"
                                    data-1p-ignore
                                    data-lpignore="true"
                                    class="input w-full font-mono text-sm"
                                    :placeholder="editingId ? 'Leave blank to keep current' : ''"
                                />
                            </div>
                        </div>

                        <div>
                            <label class="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-400" for="s3-form-public">
                                Public URL
                                <span class="font-normal text-zinc-500">(optional)</span>
                            </label>
                            <input
                                id="s3-form-public"
                                v-model="form.publicUrl"
                                type="text"
                                class="input w-full"
                                placeholder="https://media.example.com"
                            />
                            <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">CDN or custom domain, e.g. Cloudflare R2 public bucket URL.</p>
                        </div>

                        <div v-if="formError" class="rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/35">
                            <p class="text-sm text-red-800 dark:text-red-300">{{ formError }}</p>
                        </div>

                        <div class="flex flex-wrap justify-end gap-2 border-t border-zinc-200/80 pt-4 dark:border-zinc-700/80">
                            <button
                                type="button"
                                class="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                                :disabled="saving"
                                @click="closeForm"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                :disabled="
                                    !form.name.trim()
                                        || !form.endPoint.trim()
                                        || !form.bucket.trim()
                                        || saving
                                        || (!editingId && (!form.accessKey.trim() || !form.secretKey.trim()))
                                "
                                :class="[
                                    'rounded-xl px-5 py-2 text-sm font-semibold transition-colors',
                                    form.name.trim()
                                    && form.endPoint.trim()
                                    && form.bucket.trim()
                                    && !saving
                                    && (editingId || (form.accessKey.trim() && form.secretKey.trim()))
                                        ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                                        : 'cursor-not-allowed bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500',
                                ]"
                            >
                                {{ saving ? 'Saving…' : editingId ? 'Update' : 'Create' }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </Teleport>
    </div>
</template>
