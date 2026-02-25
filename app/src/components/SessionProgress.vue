<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import 'video.js/dist/video-js.css';
import { registerQualitySelector } from '../videojs-quality-selector';

registerQualitySelector();
import type { SessionStatus } from '../types';

const props = defineProps<{
    sessionId: string;
    status: SessionStatus | null;
    progress?: number;
    queuePosition?: number;
    files?: readonly string[];
    masterPlaylist?: string;
    anglePlaylists?: readonly { name: string; key: string }[];
    error?: string;
    s3PublicBaseUrl?: string;
    encodingType?: 'video' | 'audio';
}>();

const emit = defineEmits<{ reset: [] }>();

const playerEl = ref<HTMLVideoElement | null>(null);
const copied = ref(false);
const currentAngleIndex = ref(0);
const pendingSeekTime = ref<number | null>(null);
let player: Player | null = null;
let copyTimeout: ReturnType<typeof setTimeout> | null = null;

const primaryPlaylistKey = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (lists.length) {
        return lists[currentAngleIndex.value]?.key ?? lists[0]?.key;
    }
    return props.masterPlaylist;
});

const playbackUrl = computed(() => {
    if (!props.s3PublicBaseUrl || !primaryPlaylistKey.value) return null;
    return `${props.s3PublicBaseUrl}/${primaryPlaylistKey.value}`;
});

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

const isAudioOnly = computed(() => props.encodingType === 'audio');

function initPlayer() {
    if (!playerEl.value || !playbackUrl.value) return;
    if (player) {
        const wasPaused = player.paused();
        player.src({ src: playbackUrl.value, type: 'application/x-mpegURL' });
        if (pendingSeekTime.value != null) {
            const seekTo = pendingSeekTime.value;
            pendingSeekTime.value = null;
            player.one('loadedmetadata', () => {
                player!.currentTime(seekTo);
                if (!wasPaused) player!.play();
            });
        }
        return;
    }

    try {
        player = videojs(playerEl.value, {
            controls: true,
            fluid: !isAudioOnly.value,
            audioOnlyMode: isAudioOnly.value,
            responsive: true,
            html5: {
                vhs: { overrideNative: true },
            },
            sources: [{ src: playbackUrl.value, type: 'application/x-mpegURL' }],
        });

        player.ready(() => {
            try {
                (player as any).hlsQualitySelector({ displayCurrentQuality: true });
            } catch (e) {
                console.warn('HLS quality selector unavailable:', e);
            }

        });
    } catch (e) {
        console.error('Failed to initialize video player:', e);
    }
}

watch(playbackUrl, async (url) => {
    if (url) {
        await nextTick();
        initPlayer();
    }
});

onBeforeUnmount(() => {
    if (player) {
        player.dispose();
        player = null;
    }
    if (copyTimeout) clearTimeout(copyTimeout);
});

async function copyPlaybackUrl() {
    if (!playbackUrl.value) return;
    await navigator.clipboard.writeText(playbackUrl.value);
    copied.value = true;
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => { copied.value = false; }, 2000);
}

const statusConfig: Record<string, { label: string; color: string }> = {
    created: { label: 'Created', color: 'bg-zinc-600' },
    uploading: { label: 'Uploading', color: 'bg-blue-600' },
    queued: { label: 'Queued', color: 'bg-amber-600' },
    encoding: { label: 'Encoding', color: 'bg-indigo-600' },
    uploading_to_s3: { label: 'Uploading to S3', color: 'bg-cyan-600' },
    completed: { label: 'Completed', color: 'bg-emerald-600' },
    failed: { label: 'Failed', color: 'bg-red-600' },
};

function badgeClasses(s: string | null): string {
    const cfg = s ? statusConfig[s] : null;
    return `inline-block rounded-full px-3 py-1 text-xs font-semibold text-white ${cfg?.color ?? 'bg-zinc-700'}`;
}

function switchToAngle(index: number) {
    if (index === currentAngleIndex.value) return;
    if (player) {
        pendingSeekTime.value = player.currentTime() ?? 0;
    }
    currentAngleIndex.value = index;
}
</script>

<template>
    <div class="space-y-6">
        <!-- Header -->
        <div class="flex items-center justify-between">
            <div>
                <h2 class="text-lg font-semibold text-zinc-100">Session Progress</h2>
                <p class="mt-0.5 font-mono text-xs text-zinc-500">{{ sessionId }}</p>
            </div>
            <span :class="badgeClasses(status)">
                {{ status ? statusConfig[status]?.label ?? status : 'Connecting...' }}
            </span>
        </div>

        <!-- Queue position -->
        <div v-if="status === 'queued' && queuePosition != null" class="rounded-lg bg-zinc-900/60 p-4">
            <p class="text-sm text-zinc-400">
                Queue position: <span class="font-semibold text-amber-400">{{ queuePosition }}</span>
            </p>
        </div>

        <!-- Progress bar -->
        <div v-if="status === 'encoding' || status === 'uploading_to_s3'" class="space-y-2">
            <div class="flex items-center justify-between text-sm">
                <span class="text-zinc-400">
                    {{ status === 'encoding' ? 'Encoding...' : 'Uploading to S3...' }}
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
            <div v-if="playbackUrl" class="overflow-hidden rounded-lg bg-black">
                <video
                    ref="playerEl"
                    class="video-js vjs-big-play-centered"
                    playsinline
                />
            </div>

            <!-- Master Playlist URL + Copy -->
            <div v-if="masterPlaylist" class="rounded-lg bg-zinc-900/60 p-4">
                <div class="mb-1 flex items-center justify-between">
                    <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Master Playlist</p>
                    <button
                        v-if="playbackUrl"
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
                <p class="break-all font-mono text-sm text-indigo-400">{{ playbackUrl ?? masterPlaylist }}</p>
            </div>

            <div v-if="files?.length" class="rounded-lg bg-zinc-900/60 p-4">
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
            </div>
        </div>

        <!-- Error -->
        <div v-if="status === 'failed'" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
            <p class="text-sm font-medium text-red-400">Encoding failed</p>
            <p v-if="error" class="mt-1 text-sm text-red-300/80">{{ error }}</p>
        </div>

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
