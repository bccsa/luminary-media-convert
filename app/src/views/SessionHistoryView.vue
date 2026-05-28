<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import { listSessions, deleteSession } from '../api';
import { clearChapterDraftForSession } from '../composables/useChapters';
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import FormSelect from '../components/FormSelect.vue';
import { formatDateTime } from '../utils/format';
import { errorMessage } from '../utils/errors';
import { SESSION_STATUSES, statusLabel } from '../utils/status';

const { getAccessTokenSilently } = useAuth0();
const router = useRouter();

const PAGE_SIZE = 25;

const sessions = ref<any[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const currentPage = ref(1);
const statusFilter = ref('');
const nameSearch = ref('');
let nameSearchTimeout: ReturnType<typeof setTimeout> | null = null;

// Solid pill colors per status (labels + status order come from utils/status.ts).
const statusColors: Record<string, string> = {
    created:
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400',
    uploading:
        'border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-600/50 dark:bg-cyan-900/40 dark:text-cyan-400',
    uploaded:
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400',
    queued:
        'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/40 dark:text-amber-400',
    encoding:
        'border-slate-200 bg-slate-100 text-slate-900 dark:border-slate-500/35 dark:bg-slate-900/40 dark:text-slate-400',
    encrypting:
        'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/40 dark:text-amber-400',
    uploading_to_s3:
        'border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-600/50 dark:bg-cyan-900/40 dark:text-cyan-400',
    completed:
        'border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-600/50 dark:bg-emerald-900/40 dark:text-emerald-400',
    failed: 'border-red-200 bg-red-100 text-red-800 dark:border-red-800/50 dark:bg-red-900/40 dark:text-red-400',
    imported:
        'border-violet-200 bg-violet-100 text-violet-900 dark:border-violet-600/50 dark:bg-violet-900/40 dark:text-violet-400',
};

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

const statusFilterOptions = computed(() =>
    SESSION_STATUSES.map((s) => ({
        value: s,
        label: statusLabel(s),
    })),
);

async function fetchSessions() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listSessions(token, {
            limit: PAGE_SIZE,
            skip: (currentPage.value - 1) * PAGE_SIZE,
            status: statusFilter.value || undefined,
            name: nameSearch.value.trim() || undefined,
        });
        sessions.value = result.sessions ?? [];
        total.value = result.total ?? 0;
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

function onStatusChange() {
    currentPage.value = 1;
    fetchSessions();
}

function onNameSearch() {
    if (nameSearchTimeout) clearTimeout(nameSearchTimeout);
    nameSearchTimeout = setTimeout(() => {
        currentPage.value = 1;
        fetchSessions();
    }, 300);
}

function goToPage(page: number) {
    if (page < 1 || page > totalPages.value) return;
    currentPage.value = page;
    fetchSessions();
}

function navigateToSession(id: string) {
    router.push(`/sessions/${id}`);
}

function navigateToImport() {
    router.push('/sessions/import');
}

function truncateId(id: string): string {
    if (id.length <= 12) return id;
    return id.substring(0, 12) + '...';
}

/** Short display id similar to Stitch mock (sess_xxxxxxxx). */
function displaySessionId(row: { id?: string; sessionId?: string }): string {
    const raw = row.id || row.sessionId || '';
    const hex = raw.replace(/-/g, '');
    if (hex.length >= 8) return `sess_${hex.slice(0, 8)}`;
    return truncateId(raw);
}

const deletingId = ref<string | null>(null);

const deleteModalTarget = ref<{
    id: string;
    label: string;
    hasS3: boolean;
} | null>(null);

const deleteModalOpen = computed({
    get: () => deleteModalTarget.value !== null,
    set: (v: boolean) => {
        if (!v) deleteModalTarget.value = null;
    },
});

function openDeleteSessionModal(row: (typeof sessions.value)[number]) {
    const id = row.id || row.sessionId;
    const label =
        (row.name && String(row.name).trim()) || truncateId(id);
    const hasS3 = !!(
        row.s3ConfigId &&
        (row.s3Config?.pathPrefix || row.files?.length)
    );
    deleteModalTarget.value = { id, label, hasS3 };
}

async function onDeleteSessionModalConfirm(withFiles: boolean) {
    const id = deleteModalTarget.value?.id;
    if (!id) return;
    deletingId.value = id;
    try {
        const token = await getAccessTokenSilently();
        await deleteSession(id, token, withFiles);
        clearChapterDraftForSession(id);
        await fetchSessions();
        deleteModalTarget.value = null;
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        deletingId.value = null;
    }
}

const activeStatuses = new Set([
    'uploading',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
]);

function statusShowsPulse(status: string): boolean {
    return activeStatuses.has(status);
}

const paginationPageNumbers = computed(() => {
    const tp = totalPages.value;
    if (tp <= 1 || tp > 7) return null;
    return Array.from({ length: tp }, (_, i) => i + 1);
});

const showingFrom = computed(() => {
    if (total.value === 0) return 0;
    return (currentPage.value - 1) * PAGE_SIZE + 1;
});

const showingTo = computed(() =>
    Math.min(currentPage.value * PAGE_SIZE, total.value),
);

function badgeClasses(status: string): string {
    const color =
        statusColors[status] ??
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400';
    return `inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${color}`;
}

onMounted(fetchSessions);
</script>

<template>
    <div class="app-view font-sans">
        <!-- Page header: Stitch-style title + search + primary CTA -->
        <div class="mb-6 flex flex-col gap-6 lg:mb-8 lg:flex-row lg:items-end lg:justify-between">
            <div class="min-w-0 space-y-2">
                <h1 class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                    Encoding Sessions
                </h1>
                <p class="max-w-xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                    Monitor and manage your active media transcoding pipelines.
                </p>
            </div>
            <div class="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:w-auto lg:justify-end">
                <div class="relative min-w-0 sm:min-w-[18rem]">
                    <label class="sr-only" for="session-search">Search sessions</label>
                    <svg
                        class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                        id="session-search"
                        v-model="nameSearch"
                        type="search"
                        placeholder="Search by session name or ID…"
                        autocomplete="off"
                        class="input w-full py-2.5 pl-10 pr-3"
                        @input="onNameSearch"
                    />
                </div>
                <button
                    type="button"
                    class="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 sm:w-auto dark:bg-slate-700 dark:hover:bg-slate-600"
                    @click="router.push('/sessions/new')"
                >
                    <svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    New Session
                </button>
            </div>
        </div>

        <!-- Session list card -->
        <section
            class="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/60 dark:shadow-black/20 dark:ring-white/10"
        >
            <div v-if="loading" class="flex justify-center py-20">
                <div class="flex flex-col items-center gap-3">
                    <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-950/40">
                        <svg class="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    </div>
                    <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Loading sessions…</p>
                </div>
            </div>

            <div
                v-else-if="error"
                class="border-b border-slate-200/80 p-6 dark:border-slate-700"
            >
                <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40">
                    <p class="text-sm text-red-800 dark:text-red-400">{{ error }}</p>
                </div>
            </div>

            <template v-else>
                <!-- Card toolbar (status + import) -->
                <div
                    class="flex flex-col gap-3 border-b border-slate-200/90 bg-slate-50/90 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/40 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                >
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                        <label for="session-status" class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                            Status
                        </label>
                        <FormSelect
                            id="session-status"
                            v-model="statusFilter"
                            :options="statusFilterOptions"
                            placeholder="All statuses"
                            select-class="min-w-[10rem] sm:w-44"
                            @change="onStatusChange"
                        />
                    </div>
                    <button
                        type="button"
                        class="inline-flex w-full cursor-pointer items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 sm:w-auto"
                        @click="navigateToImport"
                    >
                        Import HLS
                    </button>
                </div>

                <template v-if="sessions.length > 0">
                    <div class="overflow-x-auto">
                        <table class="w-full min-w-[800px] border-collapse text-left text-sm">
                            <thead>
                                <tr
                                    class="border-b border-slate-200/90 bg-slate-50/80 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <th class="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        ID
                                    </th>
                                    <th class="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Name / Status
                                    </th>
                                    <th class="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Flags
                                    </th>
                                    <th class="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Created
                                    </th>
                                    <th class="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        Completed
                                    </th>
                                    <th class="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400" scope="col">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 dark:divide-slate-800/80">
                                <tr
                                    v-for="session in sessions"
                                    :key="session.id || session.sessionId"
                                    class="cursor-pointer transition-colors hover:bg-slate-50/90 dark:hover:bg-slate-700/40"
                                    @click="navigateToSession(session.id || session.sessionId)"
                                >
                                    <td class="whitespace-nowrap px-6 py-4 align-middle">
                                        <code
                                            class="inline-block rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                                            :title="session.id || session.sessionId"
                                        >
                                            {{ displaySessionId(session) }}
                                        </code>
                                    </td>
                                    <td class="px-6 py-4 align-top">
                                        <div class="flex flex-col gap-2">
                                            <span class="font-medium leading-snug text-slate-900 dark:text-slate-100">
                                                {{
                                                    session.name
                                                        ? session.name
                                                        : '—'
                                                }}
                                            </span>
                                            <div class="flex flex-wrap items-center gap-2">
                                                <span :class="badgeClasses(session.status)">
                                                    <svg
                                                        v-if="session.status === 'completed'"
                                                        class="h-3.5 w-3.5 shrink-0 opacity-90"
                                                        fill="none"
                                                        viewBox="0 0 24 24"
                                                        stroke="currentColor"
                                                        stroke-width="2.2"
                                                        aria-hidden="true"
                                                    >
                                                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                    </svg>
                                                    <svg
                                                        v-else-if="session.status === 'failed'"
                                                        class="h-3.5 w-3.5 shrink-0 opacity-90"
                                                        fill="none"
                                                        viewBox="0 0 24 24"
                                                        stroke="currentColor"
                                                        stroke-width="2.2"
                                                        aria-hidden="true"
                                                    >
                                                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                    </svg>
                                                    <span
                                                        v-else-if="statusShowsPulse(session.status)"
                                                        class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-80"
                                                        aria-hidden="true"
                                                    />
                                                    {{ statusLabel(session.status) }}
                                                </span>
                                            </div>
                                            <p
                                                v-if="session.status === 'failed' && session.error"
                                                class="max-w-md text-xs leading-snug text-red-600 dark:text-red-400"
                                            >
                                                {{ session.error }}
                                            </p>
                                        </div>
                                    </td>
                                    <td class="px-6 py-4 align-middle">
                                        <div class="flex flex-wrap items-center gap-1.5">
                                            <span
                                                v-if="session.encrypted"
                                                class="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700/60 dark:bg-transparent dark:text-amber-400"
                                            >
                                                Encrypted
                                            </span>
                                            <span
                                                v-if="session.imported"
                                                class="inline-flex rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-900 dark:border-violet-700/60 dark:bg-transparent dark:text-violet-400"
                                            >
                                                Imported
                                            </span>
                                            <span
                                                v-if="!session.encrypted && !session.imported"
                                                class="text-xs text-slate-400 dark:text-slate-600"
                                            >
                                                —
                                            </span>
                                        </div>
                                    </td>
                                    <td class="whitespace-nowrap px-6 py-4 text-slate-600 dark:text-slate-400">
                                        {{ formatDateTime(session.createdAt) }}
                                    </td>
                                    <td class="whitespace-nowrap px-6 py-4 text-slate-600 dark:text-slate-400">
                                        {{ session.completedAt ? formatDateTime(session.completedAt) : '—' }}
                                    </td>
                                    <td class="px-6 py-4 text-right align-middle" @click.stop>
                                        <button
                                            type="button"
                                            class="inline-flex cursor-pointer rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/35"
                                            :disabled="!!deletingId"
                                            @click.stop="openDeleteSessionModal(session)"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div
                        class="flex flex-col gap-4 border-t border-slate-200/90 bg-slate-50/80 px-6 py-4 dark:border-slate-700 dark:bg-slate-800/40 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <span class="text-xs font-medium text-slate-500 dark:text-slate-400">
                            <template v-if="total > 0">
                                Showing {{ showingFrom }} to {{ showingTo }} of {{ total }} session{{ total === 1 ? '' : 's' }}
                            </template>
                            <template v-else>No sessions</template>
                        </span>
                        <div v-if="totalPages > 1" class="flex flex-wrap items-center justify-end gap-2">
                            <button
                                type="button"
                                :disabled="currentPage <= 1"
                                class="rounded-lg border border-slate-300 p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                                aria-label="Previous page"
                                @click="goToPage(currentPage - 1)"
                            >
                                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                                </svg>
                            </button>
                            <template v-if="paginationPageNumbers">
                                <button
                                    v-for="p in paginationPageNumbers"
                                    :key="p"
                                    type="button"
                                    :class="[
                                        'min-w-[2rem] rounded-lg px-2 py-1 text-xs font-semibold transition-colors',
                                        p === currentPage
                                            ? 'border border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-500/40 dark:bg-slate-950/50 dark:text-slate-400'
                                            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700',
                                    ]"
                                    @click="goToPage(p)"
                                >
                                    {{ p }}
                                </button>
                            </template>
                            <span
                                v-else
                                class="px-2 text-xs tabular-nums text-slate-500 dark:text-slate-500"
                            >
                                Page {{ currentPage }} / {{ totalPages }}
                            </span>
                            <button
                                type="button"
                                :disabled="currentPage >= totalPages"
                                class="rounded-lg border border-slate-300 p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                                aria-label="Next page"
                                @click="goToPage(currentPage + 1)"
                            >
                                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </template>

                <div v-else class="px-6 py-16 text-center">
                    <p class="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {{ nameSearch.trim() || statusFilter ? 'No sessions match' : 'No sessions yet' }}
                    </p>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {{
                            nameSearch.trim() || statusFilter
                                ? 'Try different filters or create a new encode.'
                                : 'Create a new encode or import an existing HLS output.'
                        }}
                    </p>
                    <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
                        <button
                            type="button"
                            class="inline-flex cursor-pointer items-center justify-center rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
                            @click="router.push('/sessions/new')"
                        >
                            New Session
                        </button>
                        <button
                            type="button"
                            class="inline-flex cursor-pointer items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            @click="navigateToImport"
                        >
                            Import HLS
                        </button>
                    </div>
                </div>
            </template>
        </section>

        <DeleteSessionModal
            v-model:open="deleteModalOpen"
            :session-label="deleteModalTarget?.label ?? ''"
            :has-s3-files="deleteModalTarget?.hasS3 ?? false"
            :loading="!!deletingId && deletingId === deleteModalTarget?.id"
            @confirm="onDeleteSessionModalConfirm"
        />
    </div>
</template>
