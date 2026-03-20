<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { getDashboard } from '../api';
import { statusLabel, statusColor } from '../utils/status';

const { getAccessTokenSilently } = useAuth0();

interface DashboardData {
    userCounts: { total: number; active: number; disabled: number };
    sessionCounts: { total: number; active: number; completed: number; failed: number };
    recentActivity: Array<{ sessionId: string; userId: string; status: string; updatedAt: string; completedAt?: string }>;
}

const data = ref<DashboardData | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function fetchDashboard() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        data.value = await getDashboard(token);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

function formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
}


onMounted(fetchDashboard);
</script>

<template>
    <div>
        <h2 class="mb-6 text-xl font-semibold text-zinc-100">Dashboard</h2>

        <div v-if="error" class="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4">
            <p class="text-sm text-red-400">{{ error }}</p>
        </div>

        <div v-if="loading" class="flex justify-center py-16">
            <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <template v-else-if="data">
            <!-- Stats cards -->
            <div class="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
                <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                    <p class="text-xs text-zinc-500">Total Users</p>
                    <p class="mt-1 text-2xl font-bold text-zinc-100">{{ data.userCounts.total }}</p>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                    <p class="text-xs text-zinc-500">Active Users</p>
                    <p class="mt-1 text-2xl font-bold text-green-400">{{ data.userCounts.active }}</p>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                    <p class="text-xs text-zinc-500">Total Sessions</p>
                    <p class="mt-1 text-2xl font-bold text-zinc-100">{{ data.sessionCounts.total }}</p>
                </div>
                <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                    <p class="text-xs text-zinc-500">Active Sessions</p>
                    <p class="mt-1 text-2xl font-bold text-blue-400">{{ data.sessionCounts.active }}</p>
                </div>
            </div>

            <!-- Recent activity -->
            <h3 class="mb-3 text-sm font-medium text-zinc-400">Recent Activity</h3>
            <div class="overflow-hidden rounded-lg border border-zinc-800">
                <table class="w-full text-sm text-left">
                    <thead class="border-b border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500">
                        <tr>
                            <th class="px-4 py-3">Session</th>
                            <th class="px-4 py-3">Status</th>
                            <th class="px-4 py-3">Completed</th>
                        </tr>
                    </thead>
                    <tbody class="text-zinc-300">
                        <tr
                            v-for="s in data.recentActivity"
                            :key="s.sessionId"
                            class="border-b border-zinc-800/50"
                        >
                            <td class="px-4 py-3 font-mono text-xs">
                                <router-link
                                    :to="`/sessions/${s.sessionId}`"
                                    class="text-indigo-400 hover:text-indigo-300"
                                >{{ s.sessionId.slice(0, 12) }}...</router-link>
                            </td>
                            <td class="px-4 py-3">
                                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColor(s.status)]">
                                    {{ statusLabel(s.status) }}
                                </span>
                            </td>
                            <td class="px-4 py-3 text-zinc-500">{{ formatDate(s.completedAt) }}</td>
                        </tr>
                        <tr v-if="data.recentActivity.length === 0">
                            <td colspan="3" class="px-4 py-8 text-center text-zinc-500">No recent activity.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </template>
    </div>
</template>
