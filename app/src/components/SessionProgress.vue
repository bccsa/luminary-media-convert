<script setup lang="ts">
import { computed } from 'vue';
import SessionReview from './SessionReview.vue';
import type { AccelMode, SegmentFormat, SessionStatus } from '../types';

const props = defineProps<{
    sessionId: string;
    status: SessionStatus | null;
    progress?: number;
    queuePosition?: number;
    files?: readonly string[];
    masterPlaylist?: string;
    anglePlaylists?: readonly { name: string; key: string }[];
    error?: string;
    encoder?: AccelMode;
    segmentFormat?: SegmentFormat;
    s3PublicBaseUrl?: string;
    encodingType?: 'video' | 'audio';
    thumbnailsVtt?: string;
    previewBaseUrl?: string;
    previewToken?: string;
    encryptionKeyHex?: string;
}>();

const emit = defineEmits<{ reset: []; cancel: [] }>();

const isCancellable = computed(
    () => props.status === 'queued' || props.status === 'encoding',
);

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
};

const encoderConfig: Record<AccelMode, { label: string; icon: string }> = {
    cpu: { label: 'CPU', icon: 'M9 3.5V2m0 17.5V21M5.06 5.06l-.94-.94m13.76 13.76-.94-.94M2 12H3.5m17 0H22M5.06 18.94l-.94.94M18.82 5.06l.94-.94M12 8a4 4 0 100 8 4 4 0 000-8z' },
    nvidia: { label: 'NVIDIA GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    apple: { label: 'Apple GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
};

function badgeClasses(s: string | null): string {
    const cfg = s ? statusConfig[s] : null;
    return `inline-block rounded-full px-3 py-1 text-xs font-semibold ${cfg?.color ?? 'bg-zinc-800 text-zinc-400'}`;
}

// For SessionReview: when previewBaseUrl is set, the encryption key URL
// and token are derived from it. Otherwise no encryption key handling
// is needed for the encoding flow (preview auth handles it via
// the previewBaseUrl prop on SessionReview).
const reviewEncryptionKeyUrl = computed(() => {
    // When using preview mode, encryption key is served via preview endpoint.
    // This is handled by SessionReview's previewBaseUrl prop internally.
    return null;
});

const reviewEncryptionKeyToken = computed(() => {
    // When using preview mode, the preview token is used for auth on
    // playlist/key requests. Pass it through so SessionReview can use
    // it for preview auth (both playlist auth and key fetching).
    return props.previewToken ?? null;
});

const mutableAnglePlaylists = computed(() => {
    if (!props.anglePlaylists) return undefined;
    return props.anglePlaylists.map((ap) => ({ name: ap.name, key: ap.key }));
});
</script>

<template>
    <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
            <div>
                <h2 class="text-lg font-semibold text-zinc-100">Session Progress</h2>
                <p class="mt-0.5 font-mono text-xs text-zinc-500">{{ sessionId }}</p>
            </div>
            <div class="flex items-center gap-2">
                <span
                    v-if="encoder"
                    class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium"
                    :class="encoder === 'cpu'
                        ? 'border-zinc-700 text-zinc-400'
                        : 'border-violet-700/60 text-violet-400'"
                >
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path :d="encoderConfig[encoder].icon" />
                    </svg>
                    {{ encoderConfig[encoder].label }}
                </span>
                <span
                    v-if="segmentFormat === 'mpegts'"
                    class="inline-flex items-center gap-1 rounded-full border border-amber-700/60 px-2.5 py-1 text-xs font-medium text-amber-400"
                    title="MPEG-TS segments used because source streams have misaligned start times. fMP4 (CMAF) is used when streams are aligned."
                >
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    MPEG-TS
                </span>
                <span :class="badgeClasses(status)">
                    {{ status ? statusConfig[status]?.label ?? status : 'Connecting...' }}
                </span>
            </div>
        </div>

        <!-- Queue position -->
        <div v-if="status === 'queued' && queuePosition != null" class="rounded-lg bg-zinc-900/60 p-4">
            <p class="text-sm text-zinc-400">
                Queue position: <span class="font-semibold text-amber-400">{{ queuePosition }}</span>
            </p>
        </div>

        <!-- Progress bar -->
        <div v-if="status === 'encoding' || status === 'encrypting' || status === 'uploading_to_s3'" class="space-y-2">
            <div class="flex items-center justify-between text-sm">
                <span class="text-zinc-400">
                    {{ status === 'encoding' ? 'Encoding...' : status === 'encrypting' ? 'Encrypting...' : 'Uploading to S3...' }}
                </span>
                <span v-if="progress != null" class="font-mono text-zinc-300">{{ progress }}%</span>
            </div>
            <div class="h-3 overflow-hidden rounded-full bg-zinc-800">
                <div
                    class="h-full rounded-full bg-indigo-500 transition-all duration-300"
                    :style="{ width: `${progress ?? 0}%` }"
                />
            </div>
        </div>

        <!-- Completed -->
        <div v-if="status === 'completed'" class="space-y-3">
            <div class="rounded-lg bg-emerald-950/40 border border-emerald-800/50 p-4">
                <p class="text-sm font-medium text-emerald-400">Encoding complete</p>
            </div>

            <SessionReview
                :session-id="sessionId"
                :master-playlist="masterPlaylist"
                :angle-playlists="mutableAnglePlaylists"
                :files="files"
                :thumbnails-vtt="thumbnailsVtt"
                :encoder="encoder"
                :segment-format="segmentFormat"
                :s3-public-base-url="s3PublicBaseUrl"
                :encoding-type="encodingType"
                :encryption-key-url="reviewEncryptionKeyUrl"
                :encryption-key-token="reviewEncryptionKeyToken"
                :preview-base-url="previewBaseUrl"
                :preview-token="previewToken"
                :encrypted="!!previewBaseUrl"
                :encryption-key-hex="encryptionKeyHex"
            />
        </div>

        <!-- Error -->
        <div v-if="status === 'failed'" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
            <p class="text-sm font-medium text-red-400">Encoding failed</p>
            <p v-if="error" class="mt-1 text-sm text-red-300/80">{{ error }}</p>
        </div>

        <!-- Cancel -->
        <button
            v-if="isCancellable"
            type="button"
            class="w-full rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
            @click="emit('cancel')"
        >
            Cancel
        </button>

        <!-- Reset -->
        <button
            v-if="status === 'completed' || status === 'failed'"
            type="button"
            class="w-full rounded-lg bg-zinc-800 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer"
            @click="emit('reset')"
        >
            New Session
        </button>
    </div>
</template>
