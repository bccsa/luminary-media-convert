<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import { listSessions, deleteSession } from '../api';
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import FormSelect from '../components/FormSelect.vue';

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

const statusConfig: Record<string, { label: string; color: string }> = {
    created: {
        label: 'Created',
        color:
            'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
    },
    uploading: {
        label: 'Uploading',
        color:
            'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-400',
    },
    uploaded: {
        label: 'Uploaded',
        color:
            'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
    },
    queued: {
        label: 'Queued',
        color:
            'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-400',
    },
    encoding: {
        label: 'Encoding',
        color:
            'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-400',
    },
    encrypting: {
        label: 'Encrypting',
        color:
            'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-400',
    },
    uploading_to_s3: {
        label: 'Uploading to S3',
        color:
            'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-400',
    },
    completed: {
        label: 'Completed',
        color:
            'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-400',
    },
    failed: {
        label: 'Failed',
        color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400',
    },
    imported: {
        label: 'Imported',
        color:
            'bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-400',
    },
};

const statusOptions = [
    '',
    'created',
    'uploading',
    'uploaded',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
    'completed',
    'failed',
    'imported',
];

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasSessions = computed(() => total.value > 0);

const statusFilterOptions = computed(() =>
    statusOptions
        .filter((s): s is string => s !== '')
        .map((s) => ({
            value: s,
            label: statusConfig[s]?.label ?? s,
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
        error.value = e instanceof Error ? e.message : String(e);
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
        await fetchSessions();
        deleteModalTarget.value = null;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        deletingId.value = null;
    }
}

function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function badgeClasses(status: string): string {
    const cfg = statusConfig[status];
    return `inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg?.color ?? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400'}`;
}

onMounted(fetchSessions);
</script>

<template>
    <div class="app-view space-y-8">
        <!-- Page header -->
        <div class="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div class="min-w-0 space-y-1">
                <h1 class="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    Sessions
                </h1>
                <p class="max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
                    Browse encoding jobs, open a session for details, or start something new.
                </p>
            </div>
            <div v-if="hasSessions" class="flex shrink-0 flex-wrap items-center gap-2">
                <button
                    type="button"
                    @click="router.push('/sessions/new')"
                    class="inline-flex cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
                >
                    New session
                </button>
                <button
                    type="button"
                    @click="navigateToImport"
                    class="inline-flex cursor-pointer items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    Import HLS
                </button>
            </div>
        </div>

        <!-- Main card -->
        <section
            class="overflow-hidden rounded-2xl border border-zinc-200/90 bg-white/90 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-black/20 dark:ring-white/10"
        >
            <!-- Filters -->
            <div
                class="border-b border-zinc-200/80 bg-zinc-50/90 px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950/40 sm:px-6"
            >
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1">
                        <label class="sr-only" for="session-search">Search by name</label>
                        <input
                            id="session-search"
                            v-model="nameSearch"
                            type="search"
                            placeholder="Search by name…"
                            autocomplete="off"
                            class="input"
                            @input="onNameSearch"
                        />
                    </div>
                    <div class="flex shrink-0 items-center gap-2 sm:w-auto">
                        <label for="session-status" class="text-xs font-medium text-zinc-500 dark:text-zinc-400">
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
                </div>
            </div>

            <div class="px-4 py-6 sm:px-6">
                <!-- Loading -->
                <div v-if="loading" class="flex justify-center py-16">
                    <svg class="h-8 w-8 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                </div>

                <!-- Error -->
                <div
                    v-else-if="error"
                    class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40"
                >
                    <p class="text-sm text-red-800 dark:text-red-400">{{ error }}</p>
                </div>

                <!-- Table -->
                <div v-else-if="sessions.length > 0" class="space-y-4">
                    <div class="-mx-4 overflow-x-auto sm:mx-0">
                        <table class="w-full min-w-[640px] text-sm">
                            <thead>
                                <tr
                                    class="border-b border-zinc-200 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
                                >
                                    <th class="pb-3 pl-4 pr-4">Name</th>
                                    <th class="pb-3 pr-4">Status</th>
                                    <th class="pb-3 pr-4">Flags</th>
                                    <th class="pb-3 pr-4">Created</th>
                                    <th class="pb-3 pr-4">Completed</th>
                                    <th class="pb-3 pl-4 pr-4 text-right" scope="col">
                                        <span class="sr-only">Actions</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                                <tr
                                    v-for="session in sessions"
                                    :key="session.id || session.sessionId"
                                    class="cursor-pointer transition-colors hover:bg-zinc-50/90 dark:hover:bg-zinc-800/40"
                                    @click="navigateToSession(session.id || session.sessionId)"
                                >
                                    <td class="py-3.5 pl-4 pr-4">
                                        <span v-if="session.name" class="font-medium text-zinc-900 dark:text-zinc-100">
                                            {{ session.name }}
                                        </span>
                                        <span
                                            v-else
                                            class="font-mono text-xs text-zinc-500 dark:text-zinc-400"
                                            :title="session.id || session.sessionId"
                                        >
                                            {{ truncateId(session.id || session.sessionId) }}
                                        </span>
                                    </td>
                                    <td class="py-3.5 pr-4 align-middle">
                                        <span :class="badgeClasses(session.status)">
                                            {{ statusConfig[session.status]?.label ?? session.status }}
                                        </span>
                                    </td>
                                    <td class="py-3.5 pr-4 align-middle">
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
                                                class="text-xs text-zinc-400 dark:text-zinc-600"
                                            >
                                                —
                                            </span>
                                        </div>
                                    </td>
                                    <td class="py-3.5 pr-4 text-zinc-600 dark:text-zinc-400">
                                        {{ formatDate(session.createdAt) }}
                                    </td>
                                    <td class="py-3.5 pr-4 text-zinc-600 dark:text-zinc-400">
                                        {{ formatDate(session.completedAt) }}
                                    </td>
                                    <td class="py-3.5 pl-4 pr-4 text-right align-middle" @click.stop>
                                        <button
                                            type="button"
                                            class="inline-flex cursor-pointer rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 dark:hover:bg-red-950/35"
                                            @click.stop="openDeleteSessionModal(session)"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Pagination -->
                    <div
                        v-if="totalPages > 1"
                        class="flex flex-col gap-3 border-t border-zinc-100 pt-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <span>
                            {{ total }} session{{ total === 1 ? '' : 's' }}
                        </span>
                        <div class="flex items-center gap-2">
                            <button
                                type="button"
                                :disabled="currentPage <= 1"
                                @click="goToPage(currentPage - 1)"
                                :class="[
                                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                                    currentPage <= 1
                                        ? 'cursor-not-allowed border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-600'
                                        : 'cursor-pointer border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800',
                                ]"
                            >
                                Previous
                            </button>
                            <span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-500">
                                Page {{ currentPage }} / {{ totalPages }}
                            </span>
                            <button
                                type="button"
                                :disabled="currentPage >= totalPages"
                                @click="goToPage(currentPage + 1)"
                                :class="[
                                    'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                                    currentPage >= totalPages
                                        ? 'cursor-not-allowed border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-600'
                                        : 'cursor-pointer border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800',
                                ]"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Empty state -->
                <div v-else class="py-14 text-center">
                    <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100">No sessions yet</p>
                    <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                        Create a new encode or import an existing HLS output.
                    </p>
                    <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
                        <button
                            type="button"
                            @click="router.push('/sessions/new')"
                            class="inline-flex cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
                        >
                            New session
                        </button>
                        <button
                            type="button"
                            @click="navigateToImport"
                            class="inline-flex cursor-pointer items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                            Import HLS
                        </button>
                    </div>
                </div>
            </div>
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
