<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRoute } from 'vue-router';
import { getSessionDetail } from '../api';
import SessionReview from '../components/SessionReview.vue';

const { getAccessTokenSilently } = useAuth0();
const route = useRoute();

const session = ref<any>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const encryptionKeyHex = ref<string | null>(null);

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

const encoderConfig: Record<string, { label: string; icon: string }> = {
    cpu: { label: 'CPU', icon: 'M9 3.5V2m0 17.5V21M5.06 5.06l-.94-.94m13.76 13.76-.94-.94M2 12H3.5m17 0H22M5.06 18.94l-.94.94M18.82 5.06l.94-.94M12 8a4 4 0 100 8 4 4 0 000-8z' },
    nvidia: { label: 'NVIDIA GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    apple: { label: 'Apple GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
};

const s3PublicBaseUrl = computed(() => {
    const s3 = session.value?.s3Config;
    if (!s3?.endPoint || !s3?.bucket) return null;
    const protocol = s3.useSSL === false ? 'http' : 'https';
    const port = s3.port ? `:${s3.port}` : '';
    return `${protocol}://${s3.endPoint}${port}/${s3.bucket}`;
});

const isEncrypted = computed(
    () => !!session.value?.encrypted,
);

const isCompleted = computed(
    () => session.value?.status === 'completed' || session.value?.status === 'imported',
);

const sessionId = computed(() => {
    return (session.value?.id || session.value?.sessionId || route.params.id) as string;
});

const accessToken = ref<string | null>(null);

function badgeClasses(status: string): string {
    const cfg = statusConfig[status];
    return `inline-block rounded-full px-3 py-1 text-xs font-semibold ${cfg?.color ?? 'bg-zinc-800 text-zinc-400'}`;
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

async function fetchSession() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        accessToken.value = token;
        const sid = route.params.id as string;
        session.value = await getSessionDetail(token, sid);
        encryptionKeyHex.value = session.value?.encryptionKeyHex ?? null;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(fetchSession);
</script>

<template>
    <div class="max-w-4xl mx-auto">
        <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-xl backdrop-blur">
            <!-- Back link -->
            <div class="mb-4">
                <router-link
                    to="/sessions"
                    class="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Sessions
                </router-link>
            </div>

            <!-- Loading -->
            <div v-if="loading" class="flex justify-center py-16">
                <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
            </div>

            <!-- Error -->
            <div v-else-if="error" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                <p class="text-sm text-red-400">{{ error }}</p>
            </div>

            <!-- Session detail -->
            <template v-else-if="session">
                <!-- Header -->
                <div class="flex items-center justify-between mb-6">
                    <div>
                        <h2 class="text-lg font-semibold text-zinc-100">Session Detail</h2>
                        <p class="mt-0.5 font-mono text-xs text-zinc-500">{{ sessionId }}</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <span :class="badgeClasses(session.status)">
                            {{ statusConfig[session.status]?.label ?? session.status }}
                        </span>
                    </div>
                </div>

                <!-- Flags -->
                <div v-if="isEncrypted || session.imported" class="mb-4 flex items-center gap-2">
                    <span
                        v-if="isEncrypted"
                        class="inline-flex items-center gap-1 rounded-full border border-amber-700/60 px-2.5 py-1 text-xs font-medium text-amber-400"
                    >
                        <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0110 0v4" />
                        </svg>
                        Encrypted
                    </span>
                    <span
                        v-if="session.imported"
                        class="inline-flex items-center gap-1 rounded-full border border-violet-700/60 px-2.5 py-1 text-xs font-medium text-violet-400"
                    >
                        <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 5v14m7-7H5" />
                        </svg>
                        Imported
                    </span>
                </div>

                <!-- Metadata grid -->
                <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</p>
                        <p class="text-sm text-zinc-200">{{ statusConfig[session.status]?.label ?? session.status }}</p>
                    </div>
                    <div v-if="session.encoder" class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Encoder</p>
                        <p class="text-sm text-zinc-200">{{ encoderConfig[session.encoder]?.label ?? session.encoder }}</p>
                    </div>
                    <div v-if="session.segmentFormat" class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Segment Format</p>
                        <p class="text-sm text-zinc-200">{{ session.segmentFormat === 'fmp4' ? 'fMP4 (CMAF)' : 'MPEG-TS' }}</p>
                    </div>
                    <div v-if="session.s3Config?.endPoint" class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">S3 Endpoint</p>
                        <p class="font-mono text-xs text-zinc-200 break-all">
                            {{ session.s3Config.endPoint }}{{ session.s3Config.port ? `:${session.s3Config.port}` : '' }}
                        </p>
                    </div>
                    <div v-if="session.s3Config?.bucket" class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">S3 Bucket</p>
                        <p class="text-sm text-zinc-200">{{ session.s3Config.bucket }}</p>
                    </div>
                    <div v-if="session.masterPlaylist" class="rounded-lg bg-zinc-900/60 p-3 sm:col-span-2">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Master Playlist</p>
                        <p class="font-mono text-xs text-zinc-200 break-all">{{ session.masterPlaylist }}</p>
                    </div>
                    <div class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Created</p>
                        <p class="text-sm text-zinc-200">{{ formatDate(session.createdAt) }}</p>
                    </div>
                    <div class="rounded-lg bg-zinc-900/60 p-3">
                        <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Completed</p>
                        <p class="text-sm text-zinc-200">{{ formatDate(session.completedAt) }}</p>
                    </div>
                </div>

                <!-- Session Review (player, files, badges) -->
                <SessionReview
                    v-if="isCompleted"
                    :session-id="sessionId"
                    :master-playlist="session.masterPlaylist"
                    :angle-playlists="session.anglePlaylists"
                    :files="session.files"
                    :thumbnails-vtt="session.thumbnailsVtt"
                    :encoder="session.encoder"
                    :segment-format="session.segmentFormat"
                    :s3-public-base-url="s3PublicBaseUrl ?? undefined"
                    :encoding-type="session.encodingType"
                    :encrypted="isEncrypted"
                    :encryption-key-hex="encryptionKeyHex ?? undefined"
                />

                <!-- Error -->
                <div v-if="session.status === 'failed' && session.error" class="mt-4 rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                    <p class="text-sm font-medium text-red-400">Encoding failed</p>
                    <p class="mt-1 text-sm text-red-300/80">{{ session.error }}</p>
                </div>
            </template>
        </div>
    </div>
</template>
