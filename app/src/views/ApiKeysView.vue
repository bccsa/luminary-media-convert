<script setup lang="ts">
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, type Ref } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { createApiKey, listApiKeys, revokeApiKey } from '../api';
import ConfirmDangerModal from '../components/ConfirmDangerModal.vue';
import { formatDate } from '../utils/format';
import { errorMessage } from '../utils/errors';
import type { ApiKeyResponse } from '../types';

const encodingApiUrl = inject<Ref<string>>('encodingApiUrl', ref(''));
const docsUrl = computed(() => (encodingApiUrl.value ? `${encodingApiUrl.value}/api/docs` : ''));
const showDocs = ref(false);

const { getAccessTokenSilently } = useAuth0();

const keys = ref<ApiKeyResponse[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const newKeyName = ref('');
const creating = ref(false);
const createError = ref<string | null>(null);
const createdKey = ref<string | null>(null);
const copiedKey = ref(false);
const showCreateModal = ref(false);

const revokeModalOpen = ref(false);
const revokeTarget = ref<{ id: string; name: string; prefix: string } | null>(null);
const revoking = ref(false);

const filterQuery = ref('');
const page = ref(1);
const PAGE_SIZE = 8;

const activeKeys = computed(() => keys.value.filter((k) => k.status === 'active'));
const revokedKeys = computed(() => keys.value.filter((k) => k.status === 'revoked'));

const recentlyUsedActiveCount = computed(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return activeKeys.value.filter((k) => k.lastUsedAt && new Date(k.lastUsedAt).getTime() >= cutoff).length;
});

const filteredKeys = computed(() => {
    const q = filterQuery.value.trim().toLowerCase();
    if (!q) return keys.value;
    return keys.value.filter(
        (k) =>
            k.name.toLowerCase().includes(q)
            || k.prefix.toLowerCase().includes(q)
            || k.id.toLowerCase().includes(q),
    );
});

const totalFiltered = computed(() => filteredKeys.value.length);
const totalPages = computed(() => Math.max(1, Math.ceil(totalFiltered.value / PAGE_SIZE)));

const paginatedKeys = computed(() => {
    const start = (page.value - 1) * PAGE_SIZE;
    return filteredKeys.value.slice(start, start + PAGE_SIZE);
});

watch([filterQuery, totalFiltered], () => {
    page.value = 1;
});

watch(totalPages, (tp) => {
    if (page.value > tp) page.value = tp;
});

async function fetchKeys() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        keys.value = await listApiKeys(token);
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

async function handleCreate() {
    if (!newKeyName.value.trim()) return;
    creating.value = true;
    createError.value = null;
    createdKey.value = null;
    copiedKey.value = false;
    try {
        const token = await getAccessTokenSilently();
        const result = await createApiKey(token, newKeyName.value.trim());
        createdKey.value = result.key;
        newKeyName.value = '';
        await fetchKeys();
    } catch (e) {
        createError.value = errorMessage(e);
    } finally {
        creating.value = false;
    }
}

async function copyKey() {
    if (!createdKey.value) return;
    await navigator.clipboard.writeText(createdKey.value);
    copiedKey.value = true;
    setTimeout(() => {
        copiedKey.value = false;
    }, 2000);
}

function openRevokeModal(key: ApiKeyResponse) {
    revokeTarget.value = { id: key.id, name: key.name, prefix: key.prefix };
    revokeModalOpen.value = true;
}

async function confirmRevokeKey() {
    const id = revokeTarget.value?.id;
    if (!id) return;
    revoking.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        await revokeApiKey(token, id);
        revokeModalOpen.value = false;
        revokeTarget.value = null;
        await fetchKeys();
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        revoking.value = false;
    }
}

function formatRelative(iso: string | null): string {
    if (!iso) return 'Never';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 45) return 'Just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
    return formatDate(iso);
}

function maskPrefix(prefix: string): string {
    if (prefix.length <= 6) return `${prefix}…`;
    return `${prefix.slice(0, 6)}…${prefix.slice(-4)}`;
}

function goPage(delta: number) {
    page.value = Math.min(totalPages.value, Math.max(1, page.value + delta));
}

function openCreateModal() {
    newKeyName.value = '';
    createdKey.value = null;
    createError.value = null;
    copiedKey.value = false;
    showCreateModal.value = true;
}

function closeCreateModal() {
    if (creating.value) return;
    showCreateModal.value = false;
    newKeyName.value = '';
    createdKey.value = null;
    createError.value = null;
    copiedKey.value = false;
}

function onCreateModalKeydown(e: KeyboardEvent) {
    if (!showCreateModal.value || creating.value) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeCreateModal();
    }
}

onMounted(() => {
    fetchKeys();
    window.addEventListener('keydown', onCreateModalKeydown);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onCreateModalKeydown));
</script>

<template>
    <div class="app-view font-sans">
            <!-- Header -->
            <header class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div class="max-w-2xl">
                    <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                        API keys
                    </h1>
                    <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                        Create keys to call the Encoding API from scripts, CI, or backends. Send the raw key in the
                        <code class="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[11px] text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">X-API-Key</code>
                        header on each request.
                    </p>
                </div>
                <button
                    type="button"
                    class="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
                    @click="openCreateModal"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Create API key
                </button>
            </header>

            <!-- Summary metrics -->
            <div class="mb-8 grid gap-4 sm:grid-cols-3">
                <div
                    class="flex items-center gap-4 rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-50 text-slate-600 dark:bg-slate-950/50 dark:text-slate-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
                            />
                        </svg>
                    </div>
                    <div>
                        <p class="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Active</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                            {{ loading ? '—' : activeKeys.length }}
                        </p>
                    </div>
                </div>
                <div
                    class="flex items-center gap-4 rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Used recently</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                            {{ loading ? '—' : recentlyUsedActiveCount }}
                        </p>
                        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Active keys with use in the last 7 days</p>
                    </div>
                </div>
                <div
                    class="flex items-center gap-4 rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/50 dark:ring-white/5"
                >
                    <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-400">
                        <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H8.25v-.008z" />
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Revoked</p>
                        <p class="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                            {{ loading ? '—' : revokedKeys.length }}
                        </p>
                        <a
                            v-if="docsUrl"
                            :href="docsUrl"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-300"
                        >
                            OpenAPI docs
                            <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                        </a>
                        <p v-else class="mt-1 text-xs text-slate-500 dark:text-slate-400">Only a hash of each key is stored</p>
                    </div>
                </div>
            </div>

            <!-- Encoding API strip -->
            <div
                v-if="encodingApiUrl"
                class="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200/90 bg-slate-50/90 px-4 py-3 text-xs dark:border-slate-700 dark:bg-slate-800/40"
            >
                <span class="font-medium text-slate-600 dark:text-slate-400">Encoding API base URL</span>
                <code class="rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">{{ encodingApiUrl }}</code>
                <button
                    type="button"
                    class="ml-auto rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    @click="showDocs = !showDocs"
                >
                    {{ showDocs ? 'Hide' : 'Show' }} embedded docs
                </button>
            </div>
            <div v-if="showDocs && docsUrl" class="mb-8 overflow-hidden rounded-2xl border border-slate-200/80 shadow-lg dark:border-slate-700">
                <iframe
                    :src="docsUrl"
                    class="h-[min(70vh,560px)] w-full border-0 bg-white"
                    title="Encoding API documentation"
                />
            </div>

            <!-- Keys table card -->
            <section
                class="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
            >
                <div class="flex flex-col gap-4 border-b border-slate-200/80 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700/80">
                    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Keys</h2>
                    <div class="w-full sm:max-w-xs">
                        <label for="key-filter" class="sr-only">Filter keys</label>
                        <input
                            id="key-filter"
                            v-model="filterQuery"
                            type="search"
                            placeholder="Filter by name, prefix, or id…"
                            class="input w-full text-sm"
                            autocomplete="off"
                        />
                    </div>
                </div>

                <div v-if="loading" class="flex flex-col items-center gap-4 py-16">
                    <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-950/40">
                        <svg class="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    </div>
                    <p class="text-sm text-slate-600 dark:text-slate-400">Loading keys…</p>
                </div>

                <div v-else-if="error" class="p-6">
                    <div class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/35">
                        <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
                    </div>
                </div>

                <div v-else-if="keys.length === 0" class="px-6 py-16 text-center">
                    <p class="text-sm text-slate-600 dark:text-slate-400">No keys yet. Create one to authenticate Encoding API requests.</p>
                    <button
                        type="button"
                        class="mt-4 text-sm font-semibold text-slate-600 hover:text-slate-500 dark:text-slate-400"
                        @click="openCreateModal"
                    >
                        Create API key
                    </button>
                </div>

                <template v-else>
                    <div v-if="filteredKeys.length === 0" class="px-6 py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                        No keys match your filter.
                    </div>
                    <div v-else class="overflow-x-auto">
                        <table class="w-full min-w-[640px] text-left text-sm">
                            <thead>
                                <tr class="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
                                    <th class="px-5 py-3">Name</th>
                                    <th class="px-5 py-3">Key ID</th>
                                    <th class="px-5 py-3">Created</th>
                                    <th class="px-5 py-3">Last used</th>
                                    <th class="px-5 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 dark:divide-slate-800/80">
                                <tr
                                    v-for="key in paginatedKeys"
                                    :key="key.id"
                                    :class="key.status === 'revoked' ? 'bg-slate-50/50 opacity-75 dark:bg-slate-800/30' : ''"
                                >
                                    <td class="px-5 py-4">
                                        <p class="font-medium text-slate-900 dark:text-slate-100">{{ key.name }}</p>
                                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                            <span
                                                :class="key.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'"
                                            >●</span>
                                            {{ key.status === 'active' ? 'Active' : 'Revoked' }}
                                        </p>
                                    </td>
                                    <td class="px-5 py-4">
                                        <code class="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                                            {{ maskPrefix(key.prefix) }}
                                        </code>
                                    </td>
                                    <td class="px-5 py-4 text-slate-600 dark:text-slate-400">
                                        {{ formatDate(key.createdAt) }}
                                    </td>
                                    <td class="px-5 py-4 text-slate-600 dark:text-slate-400">
                                        {{ formatRelative(key.lastUsedAt) }}
                                    </td>
                                    <td class="px-5 py-4 text-right align-middle">
                                        <button
                                            v-if="key.status === 'active'"
                                            type="button"
                                            class="inline-flex cursor-pointer rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/35"
                                            :disabled="revoking"
                                            @click="openRevokeModal(key)"
                                        >
                                            Revoke
                                        </button>
                                        <span v-else class="text-xs text-slate-400 dark:text-slate-500">—</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div
                        v-if="filteredKeys.length > 0"
                        class="flex flex-col items-center justify-between gap-3 border-t border-slate-200/80 px-5 py-4 sm:flex-row dark:border-slate-700"
                    >
                        <p class="text-xs text-slate-500 dark:text-slate-400">
                            Showing
                            <span class="font-medium text-slate-700 dark:text-slate-300">{{ (page - 1) * PAGE_SIZE + 1 }}</span>
                            –
                            <span class="font-medium text-slate-700 dark:text-slate-300">{{ Math.min(page * PAGE_SIZE, totalFiltered) }}</span>
                            of
                            <span class="font-medium text-slate-700 dark:text-slate-300">{{ totalFiltered }}</span>
                        </p>
                        <div class="flex items-center gap-2">
                            <button
                                type="button"
                                class="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:enabled:hover:bg-slate-800"
                                :disabled="page <= 1"
                                aria-label="Previous page"
                                @click="goPage(-1)"
                            >
                                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
                            </button>
                            <span class="min-w-[3rem] text-center text-xs font-medium text-slate-600 dark:text-slate-400">{{ page }} / {{ totalPages }}</span>
                            <button
                                type="button"
                                class="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:enabled:hover:bg-slate-800"
                                :disabled="page >= totalPages"
                                aria-label="Next page"
                                @click="goPage(1)"
                            >
                                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
                            </button>
                        </div>
                    </div>
                </template>
            </section>

            <!-- Bottom info -->
            <div class="mt-8 grid gap-6 pb-12 lg:grid-cols-2">
                <div
                    class="rounded-2xl border border-slate-200/60 bg-slate-50/40 p-5 dark:border-slate-900/40 dark:bg-slate-950/20 sm:p-6"
                >
                    <div class="flex gap-3">
                        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300">
                            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.623 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                            </svg>
                        </div>
                        <div>
                            <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Security practices</h3>
                            <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                                Do not commit keys to git or client-side apps. Prefer environment variables or a secret manager. Rotate keys
                                if they leak or someone leaves the team; revoking here takes effect immediately for the Encoding API.
                            </p>
                        </div>
                    </div>
                </div>
                <div
                    class="rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800/50 dark:ring-white/5 sm:p-6"
                >
                    <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Auth &amp; limits</h3>
                    <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                        Tenant keys are validated by the Encoding API via your SaaS webhook. Rate limits and quotas depend on your deployment;
                        see OpenAPI / operations docs for endpoint-level throttling.
                    </p>
                    <a
                        v-if="docsUrl"
                        :href="docsUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-slate-600 hover:text-slate-500 dark:text-slate-400"
                    >
                        Browse API reference
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
                    </a>
                </div>
            </div>

        <ConfirmDangerModal
            v-model:open="revokeModalOpen"
            title="Revoke API key"
            confirm-label="Revoke"
            cancel-label="Cancel"
            loading-label="Revoking…"
            :loading="revoking"
            @confirm="confirmRevokeKey"
        >
            <p>
                This will revoke
                <span class="font-medium text-slate-900 dark:text-slate-200">{{
                    revokeTarget?.name?.trim() || 'this key'
                }}</span>
                <template v-if="revokeTarget?.prefix">
                    (<span class="font-mono text-xs">{{ maskPrefix(revokeTarget.prefix) }}</span>)
                </template>
                . API requests using it will fail immediately. This cannot be undone.
            </p>
        </ConfirmDangerModal>

        <Teleport to="body">
            <div
                v-if="showCreateModal"
                class="fixed inset-0 z-[100] flex items-center justify-center p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="create-api-key-modal-title"
            >
                <button
                    type="button"
                    class="absolute inset-0 bg-slate-900/50 backdrop-blur-[1px] dark:bg-black/60"
                    aria-label="Close"
                    :disabled="creating"
                    @click="closeCreateModal"
                />
                <div
                    class="relative max-h-[min(90vh,700px)] w-full max-w-[38rem] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
                    @click.stop
                >
                    <div class="flex items-start justify-between gap-4">
                        <div>
                            <h2
                                id="create-api-key-modal-title"
                                class="text-lg font-semibold text-slate-900 dark:text-slate-100"
                            >
                                New API key
                            </h2>
                            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                The secret is generated in your browser and shown once. We only store a hash and the public prefix.
                            </p>
                        </div>
                        <button
                            type="button"
                            class="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                            :disabled="creating"
                            aria-label="Close dialog"
                            @click="closeCreateModal"
                        >
                            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    <form @submit.prevent="handleCreate" class="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div class="min-w-0 flex-1">
                            <label for="api-key-name-modal" class="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-400">Name</label>
                            <input
                                id="api-key-name-modal"
                                v-model="newKeyName"
                                type="text"
                                placeholder="e.g. Production CI, local dev"
                                class="input w-full"
                                :disabled="creating"
                                autocomplete="off"
                            />
                        </div>
                        <button
                            type="submit"
                            :disabled="!newKeyName.trim() || creating || !!createdKey"
                            :class="[
                                'inline-flex min-h-[2.75rem] shrink-0 items-center justify-center rounded-xl px-6 text-sm font-semibold transition-colors',
                                newKeyName.trim() && !creating && !createdKey
                                    ? 'bg-sky-600 text-white shadow-sm hover:bg-sky-500 dark:bg-slate-700 dark:hover:bg-slate-600'
                                    : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
                            ]"
                        >
                            {{ creating ? 'Creating…' : 'Generate key' }}
                        </button>
                    </form>

                    <div v-if="createError" class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/35">
                        <p class="text-sm text-red-800 dark:text-red-300">{{ createError }}</p>
                    </div>
                    <div v-if="createdKey" class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/30">
                        <p class="text-sm font-medium text-emerald-900 dark:text-emerald-200">Copy this key now — it will not be shown again.</p>
                        <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                            <code class="flex-1 break-all rounded-lg border border-emerald-200/80 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-emerald-800/50 dark:bg-slate-950 dark:text-slate-100">{{ createdKey }}</code>
                            <button
                                type="button"
                                class="inline-flex items-center justify-center rounded-xl border border-emerald-300 bg-white px-4 text-sm font-semibold text-emerald-800 hover:bg-emerald-100/80 dark:border-emerald-700 dark:bg-slate-800 dark:text-emerald-200 dark:hover:bg-slate-700"
                                @click="copyKey"
                            >
                                {{ copiedKey ? 'Copied' : 'Copy' }}
                            </button>
                        </div>
                    </div>

                    <div class="mt-6 flex justify-end gap-2 border-t border-slate-200/80 pt-4 dark:border-slate-700/80">
                        <button
                            type="button"
                            class="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            :disabled="creating"
                            @click="closeCreateModal"
                        >
                            {{ createdKey ? 'Done' : 'Cancel' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>
