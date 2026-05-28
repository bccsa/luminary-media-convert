<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import { listAllSessions, subscribeSessionEvents } from '../api';
import { statusLabel, statusColor } from '../utils/status';
import FormSelect from '../components/FormSelect.vue';

const SESSION_STATUS_FILTER_KEYS = [
    'uploading',
    'uploaded',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
    'completed',
    'failed',
] as const;

const sessionStatusFilterOptions = SESSION_STATUS_FILTER_KEYS.map((k) => ({
    value: k,
    label: statusLabel(k),
}));
const router = useRouter();
const { getAccessTokenSilently } = useAuth0();
let eventSource: EventSource | null = null;

interface Session {
    sessionId: string;
    userId: string;
    status: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

const sessions = ref<Session[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const statusFilter = ref('');
const skip = ref(0);
const limit = 25;
const total = ref(0);

watch(statusFilter, () => {
    skip.value = 0;
    fetchSessions();
});

async function fetchSessions() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const result = await listAllSessions(token, {
            limit,
            skip: skip.value,
            status: statusFilter.value || undefined,
        });
        sessions.value = result.sessions ?? [];
        total.value = result.total ?? sessions.value.length;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

function prevPage() {
    skip.value = Math.max(0, skip.value - limit);
    fetchSessions();
}

function nextPage() {
    skip.value += limit;
    fetchSessions();
}

function formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
}


async function connectSSE() {
    try {
        const token = await getAccessTokenSilently();
        eventSource = subscribeSessionEvents(token, (event) => {
            // If status filter is active and event doesn't match, skip
            if (statusFilter.value && event.status !== statusFilter.value) {
                // But remove it from the list if it was there and status changed
                const idx = sessions.value.findIndex(
                    (s) => s.sessionId === event.sessionId,
                );
                if (idx !== -1) {
                    sessions.value.splice(idx, 1);
                }
                return;
            }

            const idx = sessions.value.findIndex(
                (s) => s.sessionId === event.sessionId,
            );
            if (idx !== -1) {
                // Update existing session in-place
                sessions.value[idx] = {
                    ...sessions.value[idx],
                    status: event.status,
                    updatedAt: event.updatedAt,
                    completedAt: event.completedAt,
                };
            } else if (skip.value === 0) {
                // New session — prepend to first page
                sessions.value.unshift({
                    sessionId: event.sessionId,
                    userId: event.userId,
                    status: event.status,
                    createdAt: event.updatedAt,
                    updatedAt: event.updatedAt,
                    completedAt: event.completedAt,
                });
                // Trim to page size
                if (sessions.value.length > limit) {
                    sessions.value.pop();
                }
            }
        });
    } catch {
        // SSE auth failure — fall back to polling-only
    }
}

onMounted(() => {
    fetchSessions();
    connectSSE();
});

onUnmounted(() => {
    eventSource?.close();
});
</script>

<template>
    <div>
        <div class="mb-6 flex items-center justify-between">
            <h2 class="text-xl font-semibold text-zinc-100">Sessions</h2>
            <FormSelect
                v-model="statusFilter"
                variant="admin"
                :options="sessionStatusFilterOptions"
                placeholder="All statuses"
                select-class="min-w-[14rem]"
            />
        </div>

        <div
            v-if="error"
            class="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4"
        >
            <p class="text-sm text-red-400">{{ error }}</p>
        </div>

        <div v-if="loading" class="flex justify-center py-16">
            <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <div v-else class="overflow-hidden rounded-lg border border-zinc-800">
            <table class="w-full text-sm text-left">
                <thead class="border-b border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500">
                    <tr>
                        <th class="px-4 py-3">Session ID</th>
                        <th class="px-4 py-3">User</th>
                        <th class="px-4 py-3">Status</th>
                        <th class="px-4 py-3">Created</th>
                        <th class="px-4 py-3">Completed</th>
                    </tr>
                </thead>
                <tbody class="text-zinc-300">
                    <tr
                        v-for="s in sessions"
                        :key="s.sessionId"
                        class="border-b border-zinc-800/50 transition-colors hover:bg-zinc-900/30 cursor-pointer"
                        @click="router.push(`/sessions/${s.sessionId}`)"
                    >
                        <td class="px-4 py-3 font-mono text-xs">{{ s.sessionId.slice(0, 12) }}...</td>
                        <td class="px-4 py-3 font-mono text-xs text-zinc-500">{{ s.userId.replace('user:', '').slice(0, 8) }}...</td>
                        <td class="px-4 py-3">
                            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColor(s.status)]">
                                {{ statusLabel(s.status) }}
                            </span>
                        </td>
                        <td class="px-4 py-3 text-zinc-500">{{ formatDate(s.createdAt) }}</td>
                        <td class="px-4 py-3 text-zinc-500">{{ formatDate(s.completedAt) }}</td>
                    </tr>
                    <tr v-if="sessions.length === 0">
                        <td colspan="5" class="px-4 py-8 text-center text-zinc-500">No sessions found.</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div
            v-if="!loading && total > limit"
            class="mt-4 flex items-center justify-between text-sm text-zinc-500"
        >
            <span>Showing {{ skip + 1 }}&ndash;{{ Math.min(skip + limit, total) }} of {{ total }}</span>
            <div class="flex gap-2">
                <button
                    :disabled="skip === 0"
                    @click="prevPage"
                    class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >Previous</button>
                <button
                    :disabled="skip + limit >= total"
                    @click="nextPage"
                    class="rounded border border-zinc-700 px-3 py-1 text-xs transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >Next</button>
            </div>
        </div>
    </div>
</template>
