<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import { getSession } from '../api';
import { statusLabel, statusColor } from '../utils/status';

const route = useRoute();
const { getAccessTokenSilently } = useAuth0();

interface Session {
    sessionId: string;
    userId: string;
    status: string;
    progress?: number;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: Array<{ name: string; key: string }>;
    thumbnailsVtt?: string;
    error?: string;
    encoder?: string;
    segmentFormat?: string;
    s3Config?: { endPoint: string; bucket: string; pathPrefix?: string };
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}

const session = ref<Session | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const sessionId = route.params.id as string;

async function fetchSession() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        session.value = await getSession(token, sessionId);
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


onMounted(fetchSession);
</script>

<template>
    <div>
        <div class="mb-6">
            <router-link
                to="/sessions"
                class="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
            >&larr; Back to Sessions</router-link>
        </div>

        <div v-if="error" class="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4">
            <p class="text-sm text-red-400">{{ error }}</p>
        </div>

        <div v-if="loading" class="flex justify-center py-16">
            <svg class="h-6 w-6 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <div v-else-if="session">
            <div class="mb-6">
                <h2 class="text-xl font-semibold text-zinc-100">Session {{ session.sessionId.slice(0, 12) }}...</h2>
                <p class="text-sm text-zinc-500 font-mono">{{ session.sessionId }}</p>
            </div>

            <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
                <dl class="grid grid-cols-2 gap-4 text-sm">
                    <div>
                        <dt class="text-zinc-500">Status</dt>
                        <dd class="mt-1">
                            <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColor(session.status)]">
                                {{ statusLabel(session.status) }}
                            </span>
                        </dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">User</dt>
                        <dd class="mt-1 font-mono text-xs text-zinc-100">{{ session.userId }}</dd>
                    </div>
                    <div v-if="session.encoder">
                        <dt class="text-zinc-500">Encoder</dt>
                        <dd class="mt-1 text-zinc-100">{{ session.encoder }}</dd>
                    </div>
                    <div v-if="session.segmentFormat">
                        <dt class="text-zinc-500">Segment Format</dt>
                        <dd class="mt-1 text-zinc-100">{{ session.segmentFormat }}</dd>
                    </div>
                    <div v-if="session.s3Config">
                        <dt class="text-zinc-500">S3 Bucket</dt>
                        <dd class="mt-1 text-zinc-100">{{ session.s3Config.endPoint }}/{{ session.s3Config.bucket }}</dd>
                    </div>
                    <div v-if="session.masterPlaylist">
                        <dt class="text-zinc-500">Master Playlist</dt>
                        <dd class="mt-1 font-mono text-xs text-zinc-100 break-all">{{ session.masterPlaylist }}</dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Created</dt>
                        <dd class="mt-1 text-zinc-100">{{ formatDate(session.createdAt) }}</dd>
                    </div>
                    <div>
                        <dt class="text-zinc-500">Completed</dt>
                        <dd class="mt-1 text-zinc-100">{{ formatDate(session.completedAt) }}</dd>
                    </div>
                    <div v-if="session.expiresAt">
                        <dt class="text-zinc-500">Expires</dt>
                        <dd class="mt-1 text-zinc-100">{{ formatDate(session.expiresAt) }}</dd>
                    </div>
                </dl>
            </div>

            <!-- Error -->
            <div v-if="session.error" class="mt-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4">
                <h3 class="mb-1 text-sm font-medium text-red-400">Error</h3>
                <p class="text-sm text-red-300">{{ session.error }}</p>
            </div>

            <!-- Files -->
            <div v-if="session.files?.length" class="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
                <h3 class="mb-3 text-sm font-medium text-zinc-400">Output Files ({{ session.files.length }})</h3>
                <ul class="space-y-1 text-xs font-mono text-zinc-500">
                    <li v-for="file in session.files" :key="file">{{ file }}</li>
                </ul>
            </div>
        </div>
    </div>
</template>
