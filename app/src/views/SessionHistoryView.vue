<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRouter } from 'vue-router';
import { listSessions } from '../api';

const { getAccessTokenSilently } = useAuth0();
const router = useRouter();

const PAGE_SIZE = 25;

const sessions = ref<any[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const currentPage = ref(1);
const statusFilter = ref('');

const statusConfig: Record<string, { label: string; color: string }> = {
    created: { label: 'Created', color: 'bg-zinc-800 text-zinc-400' },
    uploading: { label: 'Uploading', color: 'bg-cyan-900/40 text-cyan-400' },
    uploaded: { label: 'Uploaded', color: 'bg-zinc-800 text-zinc-400' },
    queued: { label: 'Queued', color: 'bg-amber-900/40 text-amber-400' },
    encoding: { label: 'Encoding', color: 'bg-indigo-900/40 text-indigo-400' },
    encrypting: { label: 'Encrypting', color: 'bg-amber-900/40 text-amber-400' },
    uploading_to_s3: { label: 'Uploading to S3', color: 'bg-cyan-900/40 text-cyan-400' },
    completed: { label: 'Completed', color: 'bg-emerald-900/40 text-emerald-400' },
    failed: { label: 'Failed', color: 'bg-red-900/40 text-red-400' },
    imported: { label: 'Imported', color: 'bg-violet-900/40 text-violet-400' },
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

async function fetchSessions() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listSessions(token, {
            limit: PAGE_SIZE,
            skip: (currentPage.value - 1) * PAGE_SIZE,
            status: statusFilter.value || undefined,
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

function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '--';
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
    return `inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg?.color ?? 'bg-zinc-800 text-zinc-400'}`;
}

onMounted(fetchSessions);
</script>

<template>
    <div class="max-w-4xl mx-auto">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <!-- Header -->
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-lg font-semibold text-zinc-100">Sessions</h2>
                <button
                    @click="navigateToImport"
                    class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 cursor-pointer"
                >
                    Import
                </button>
            </div>

            <!-- Filters -->
            <div class="mb-4 flex items-center gap-3">
                <label class="text-xs text-zinc-500">Status:</label>
                <select
                    v-model="statusFilter"
                    @change="onStatusChange"
                    class="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                >
                    <option value="">All</option>
                    <option v-for="s in statusOptions.filter(v => v)" :key="s" :value="s">
                        {{ statusConfig[s]?.label ?? s }}
                    </option>
                </select>
            </div>

            <!-- Loading -->
            <div v-if="loading" class="flex justify-center py-8">
                <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>

            <!-- Error -->
            <div v-else-if="error" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                <p class="text-sm text-red-400">{{ error }}</p>
            </div>

            <!-- Table -->
            <div v-else-if="sessions.length > 0">
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="border-b border-zinc-800 text-left text-xs uppercase tracking-wider text-zinc-500">
                                <th class="pb-3 pr-4">Name</th>
                                <th class="pb-3 pr-4">Status</th>
                                <th class="pb-3 pr-4">Flags</th>
                                <th class="pb-3 pr-4">Created</th>
                                <th class="pb-3">Completed</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="session in sessions"
                                :key="session.id || session.sessionId"
                                class="border-b border-zinc-800/50 cursor-pointer transition-colors hover:bg-zinc-800/30"
                                @click="navigateToSession(session.id || session.sessionId)"
                            >
                                <td class="py-3 pr-4">
                                    <span v-if="session.name" class="text-zinc-200">{{ session.name }}</span>
                                    <span v-else class="font-mono text-xs text-zinc-500" :title="session.id || session.sessionId">{{ truncateId(session.id || session.sessionId) }}</span>
                                </td>
                                <td class="py-3 pr-4">
                                    <span :class="badgeClasses(session.status)">
                                        {{ statusConfig[session.status]?.label ?? session.status }}
                                    </span>
                                </td>
                                <td class="py-3 pr-4">
                                    <div class="flex items-center gap-1.5">
                                        <span
                                            v-if="session.encrypted"
                                            class="inline-block rounded-full border border-amber-700/60 px-2 py-0.5 text-xs font-medium text-amber-400"
                                        >
                                            Encrypted
                                        </span>
                                        <span
                                            v-if="session.imported"
                                            class="inline-block rounded-full border border-violet-700/60 px-2 py-0.5 text-xs font-medium text-violet-400"
                                        >
                                            Imported
                                        </span>
                                    </div>
                                </td>
                                <td class="py-3 pr-4 text-zinc-400">{{ formatDate(session.createdAt) }}</td>
                                <td class="py-3 text-zinc-400">{{ formatDate(session.completedAt) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Pagination -->
                <div v-if="totalPages > 1" class="mt-4 flex items-center justify-between text-sm text-zinc-400">
                    <span>{{ total }} session{{ total === 1 ? '' : 's' }} total</span>
                    <div class="flex items-center gap-2">
                        <button
                            :disabled="currentPage <= 1"
                            @click="goToPage(currentPage - 1)"
                            :class="[
                                'rounded border border-zinc-700 px-3 py-1 text-xs transition-colors',
                                currentPage <= 1
                                    ? 'text-zinc-600 cursor-not-allowed'
                                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer',
                            ]"
                        >
                            Previous
                        </button>
                        <span class="text-xs text-zinc-500">
                            Page {{ currentPage }} of {{ totalPages }}
                        </span>
                        <button
                            :disabled="currentPage >= totalPages"
                            @click="goToPage(currentPage + 1)"
                            :class="[
                                'rounded border border-zinc-700 px-3 py-1 text-xs transition-colors',
                                currentPage >= totalPages
                                    ? 'text-zinc-600 cursor-not-allowed'
                                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer',
                            ]"
                        >
                            Next
                        </button>
                    </div>
                </div>
            </div>

            <!-- Empty state -->
            <div v-else class="py-8 text-center text-sm text-zinc-500">
                No sessions found.
            </div>
        </div>
    </div>
</template>
