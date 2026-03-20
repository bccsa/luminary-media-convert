<script setup lang="ts">
import { ref, computed } from 'vue';
import HlsPlayer from './HlsPlayer.vue';
import type { AccelMode, SegmentFormat } from '../types';

const props = defineProps<{
    sessionId: string;
    masterPlaylist?: string;
    anglePlaylists?: { name: string; key: string }[];
    files?: readonly string[];
    thumbnailsVtt?: string;
    encoder?: AccelMode | string;
    segmentFormat?: SegmentFormat | string;
    s3PublicBaseUrl?: string;
    encodingType?: 'video' | 'audio';
    encryptionKeyUrl?: string | null;
    encryptionKeyToken?: string | null;
    encrypted?: boolean;
    encryptionKeyHex?: string;
    previewBaseUrl?: string;
    previewToken?: string | null;
}>();

const copied = ref(false);
const copiedKey = ref(false);
const currentAngleIndex = ref(0);
const showFiles = ref(false);
let copyTimeout: ReturnType<typeof setTimeout> | null = null;
let copyKeyTimeout: ReturnType<typeof setTimeout> | null = null;
const playerRef = ref<InstanceType<typeof HlsPlayer> | null>(null);

const encoderConfig: Record<string, { label: string; icon: string }> = {
    cpu: { label: 'CPU', icon: 'M9 3.5V2m0 17.5V21M5.06 5.06l-.94-.94m13.76 13.76-.94-.94M2 12H3.5m17 0H22M5.06 18.94l-.94.94M18.82 5.06l.94-.94M12 8a4 4 0 100 8 4 4 0 000-8z' },
    nvidia: { label: 'NVIDIA GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    apple: { label: 'Apple GPU', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
};

const uniqueAnglePlaylists = computed(() => {
    const lists = props.anglePlaylists;
    if (!lists?.length) return [];
    const seen = new Set<string>();
    const result: { name: string; key: string }[] = [];
    for (const ap of lists) {
        if (seen.has(ap.name)) continue;
        seen.add(ap.name);
        result.push(ap);
    }
    return result;
});

const showAngleSwitcher = computed(
    () => uniqueAnglePlaylists.value.length > 1,
);

const currentAngleIsAudioOnly = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (!lists.length) return false;
    return lists[currentAngleIndex.value]?.name === 'Audio only';
});

const isAudioOnly = computed(
    () => props.encodingType === 'audio' || currentAngleIsAudioOnly.value,
);

const primaryPlaylistKey = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (lists.length) {
        return lists[currentAngleIndex.value]?.key ?? lists[0]?.key;
    }
    return props.masterPlaylist;
});

const s3Url = computed(() => {
    if (!primaryPlaylistKey.value || !props.s3PublicBaseUrl) return null;
    return `${props.s3PublicBaseUrl}/${primaryPlaylistKey.value}`;
});

const playbackUrl = computed(() => {
    if (!primaryPlaylistKey.value) return null;
    if (props.previewBaseUrl) {
        const filename = primaryPlaylistKey.value.split('/').pop();
        return `${props.previewBaseUrl}/${filename}`;
    }
    return s3Url.value;
});

const thumbnailVttUrl = computed(() => {
    if (!props.thumbnailsVtt || !props.s3PublicBaseUrl) return null;
    return `${props.s3PublicBaseUrl}/${props.thumbnailsVtt}`;
});

// For encryption key: when using preview mode, key URL is derived from previewBaseUrl
const effectiveEncryptionKeyUrl = computed(() => {
    if (props.previewBaseUrl) {
        return `${props.previewBaseUrl}/key`;
    }
    return props.encryptionKeyUrl ?? null;
});

// For encryption key token: use the provided token (works for both preview and SaaS modes)
const effectiveEncryptionKeyToken = computed(() => {
    return props.encryptionKeyToken ?? null;
});

const shouldCollapseFiles = computed(() => {
    return (props.files?.length ?? 0) > 10;
});

async function copyPlaybackUrl() {
    if (!s3Url.value) return;
    await navigator.clipboard.writeText(s3Url.value);
    copied.value = true;
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => { copied.value = false; }, 2000);
}

async function copyEncryptionKey() {
    if (!props.encryptionKeyHex) return;
    await navigator.clipboard.writeText(props.encryptionKeyHex);
    copiedKey.value = true;
    if (copyKeyTimeout) clearTimeout(copyKeyTimeout);
    copyKeyTimeout = setTimeout(() => { copiedKey.value = false; }, 2000);
}

function switchToAngle(index: number) {
    if (index === currentAngleIndex.value) return;
    if (playerRef.value) {
        const currentTime = playerRef.value.getCurrentTime();
        playerRef.value.setPendingSeek(currentTime);
    }
    currentAngleIndex.value = index;
}
</script>

<template>
    <div class="space-y-3">
        <!-- Encoder badge -->
        <div class="flex items-center gap-2">
            <span
                v-if="encoder && encoderConfig[encoder]"
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
        </div>

        <!-- Angle switcher (multi-angle only; one button per unique track name) -->
        <div
            v-if="showAngleSwitcher && uniqueAnglePlaylists.length"
            class="flex flex-wrap items-center gap-2"
        >
            <span class="text-xs font-medium text-zinc-500">Angle:</span>
            <div class="flex flex-wrap gap-1.5">
                <button
                    v-for="(ap, i) in uniqueAnglePlaylists"
                    :key="ap.key"
                    type="button"
                    class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                    :class="i === currentAngleIndex
                        ? 'bg-indigo-600 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'"
                    @click="switchToAngle(i)"
                >
                    {{ ap.name }}
                </button>
            </div>
        </div>

        <!-- Player -->
        <HlsPlayer
            ref="playerRef"
            :playback-url="playbackUrl"
            :thumbnail-vtt-url="thumbnailVttUrl"
            :encoding-type="encodingType"
            :is-audio-only="isAudioOnly"
            :encryption-key-url="effectiveEncryptionKeyUrl"
            :encryption-key-token="effectiveEncryptionKeyToken"
            :encryption-key-hex="encryptionKeyHex"
            :preview-token="previewToken"
        />

        <!-- Master Playlist URL + Copy -->
        <div v-if="masterPlaylist" class="rounded-lg bg-zinc-900/60 p-4">
            <div class="mb-1 flex items-center justify-between">
                <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Master Playlist</p>
                <button
                    v-if="s3Url"
                    type="button"
                    class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
                    :class="copied
                        ? 'bg-emerald-900/60 text-emerald-400'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'"
                    @click="copyPlaybackUrl"
                >
                    <svg v-if="!copied" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    <svg v-else class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {{ copied ? 'Copied!' : 'Copy URL' }}
                </button>
            </div>
            <p class="break-all font-mono text-sm text-indigo-400">{{ s3Url ?? masterPlaylist }}</p>
        </div>

        <!-- Encryption key display -->
        <div v-if="encrypted && encryptionKeyHex" class="rounded-lg bg-zinc-900/60 p-4">
            <div class="mb-1 flex items-center justify-between">
                <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Encryption Key</p>
                <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
                    :class="copiedKey
                        ? 'bg-emerald-900/60 text-emerald-400'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300'"
                    @click="copyEncryptionKey"
                >
                    <svg v-if="!copiedKey" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    <svg v-else class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {{ copiedKey ? 'Copied!' : 'Copy Key' }}
                </button>
            </div>
            <code class="block break-all rounded bg-zinc-800 px-3 py-2 font-mono text-xs text-amber-400">{{ encryptionKeyHex }}</code>
        </div>

        <!-- Output files -->
        <div v-if="files?.length" class="rounded-lg bg-zinc-900/60 p-4">
            <template v-if="shouldCollapseFiles">
                <button
                    type="button"
                    class="flex w-full items-center justify-between cursor-pointer"
                    @click="showFiles = !showFiles"
                >
                    <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        Output Files ({{ files.length }})
                    </p>
                    <svg
                        class="h-4 w-4 text-zinc-500 transition-transform"
                        :class="{ 'rotate-180': showFiles }"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                <ul v-if="showFiles" class="mt-3 max-h-60 space-y-1 overflow-y-auto">
                    <li
                        v-for="f in files"
                        :key="f"
                        class="break-all font-mono text-xs text-zinc-400"
                    >
                        {{ f }}
                    </li>
                </ul>
            </template>
            <template v-else>
                <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Output Files</p>
                <ul class="max-h-60 space-y-1 overflow-y-auto">
                    <li
                        v-for="f in files"
                        :key="f"
                        class="break-all font-mono text-xs text-zinc-400"
                    >
                        {{ f }}
                    </li>
                </ul>
            </template>
        </div>
    </div>
</template>
