<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import 'video.js/dist/video-js.css';
import { registerQualitySelector } from '../videojs-quality-selector';
import { registerThumbnailPreview } from '../videojs-thumbnail-preview';

registerQualitySelector();
registerThumbnailPreview();

const props = defineProps<{
    playbackUrl: string | null;
    thumbnailVttUrl?: string | null;
    encodingType?: 'video' | 'audio';
    isAudioOnly?: boolean;
    encryptionKeyUrl?: string | null;
    encryptionKeyToken?: string | null;
    encryptionKeyHex?: string | null;
    previewToken?: string | null;
}>();

const hasEncryption = computed(
    () => !!props.encryptionKeyUrl || !!props.encryptionKeyHex,
);

const playerEl = ref<HTMLVideoElement | null>(null);
let player: Player | null = null;
let cachedEncryptionKey: ArrayBuffer | null = null;

// SVG poster for audio-only playlists (headphone icon on dark background)
const audioPosterUrl = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#18181b"/>' +
    '<g transform="translate(280,130)" fill="none" stroke="#52525b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 56V34a36 36 0 0 1 72 0v22"/>' +
    '<rect x="0" y="48" width="16" height="32" rx="4" fill="#52525b"/>' +
    '<rect x="64" y="48" width="16" height="32" rx="4" fill="#52525b"/>' +
    '</g></svg>',
)}`;

const audioOnly = computed(
    () => props.isAudioOnly || props.encodingType === 'audio',
);

async function fetchEncryptionKey(): Promise<ArrayBuffer> {
    if (cachedEncryptionKey) return cachedEncryptionKey;

    // Use raw hex key if available (no network request needed)
    if (props.encryptionKeyHex) {
        const bytes = new Uint8Array(
            props.encryptionKeyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
        );
        cachedEncryptionKey = bytes.buffer;
        return cachedEncryptionKey;
    }

    if (!props.encryptionKeyUrl) throw new Error('No encryption key available');

    const headers: Record<string, string> = {};
    if (props.encryptionKeyToken) {
        headers['Authorization'] = `Bearer ${props.encryptionKeyToken}`;
    }

    const res = await fetch(props.encryptionKeyUrl, { headers });
    if (!res.ok) throw new Error(`Failed to fetch encryption key (${res.status})`);
    cachedEncryptionKey = await res.arrayBuffer();
    return cachedEncryptionKey;
}

function setupEncryptedPlayback() {
    if (!player || !hasEncryption.value) return;

    const hook = () => {
        try {
            const tech = player!.tech({ IWillNotUseThisInPlugins: true } as any) as any;
            tech?.vhs?.xhr?.onRequest?.((options: any) => {
                if (options.uri && (options.uri.includes('.key') || options.uri.includes('/key'))) {
                    options.beforeSend = (xhr: XMLHttpRequest) => {
                        xhr.responseType = 'arraybuffer';
                    };
                    const originalOnResponse = options.onResponse;
                    options.onResponse = async (_req: any, _err: any, res: any) => {
                        originalOnResponse?.(_req, _err, res);
                    };
                    // Override the URI to use a blob URL with the key
                    fetchEncryptionKey().then((keyData) => {
                        const keyArray = new Uint8Array(keyData);
                        const blob = new Blob([keyArray], { type: 'application/octet-stream' });
                        const blobUrl = URL.createObjectURL(blob);
                        options.uri = blobUrl;
                    }).catch((err) => {
                        console.error('Failed to fetch encryption key:', err);
                    });
                }
                return options;
            });
        } catch { /* tech not ready yet */ }
    };
    player.on('xhr-hooks-ready', hook);
}

function setupPreviewAuth() {
    if (!player || !props.previewToken) return;
    const token = props.previewToken;
    const hook = () => {
        try {
            const tech = player!.tech({ IWillNotUseThisInPlugins: true } as any) as any;
            tech?.vhs?.xhr?.onRequest?.((options: any) => {
                if (options.uri?.includes('/api/sessions/')) {
                    options.headers = options.headers || {};
                    options.headers['Authorization'] = `Bearer ${token}`;
                }
                return options;
            });
        } catch { /* tech not ready yet */ }
    };
    // Try immediately (hooks may already be ready on re-use)
    hook();
    player.on('xhr-hooks-ready', hook);
}

function initPlayer() {
    if (!playerEl.value || !props.playbackUrl) return;

    if (player) {
        try { (player as any).audioOnlyMode(false); } catch {}
        player.fluid(true);

        if (audioOnly.value) {
            player.poster(audioPosterUrl);
        } else {
            player.poster('');
        }

        const wasPaused = player.paused();

        // Set up auth interceptors before loading source
        if (props.previewToken) {
            setupPreviewAuth();
        }
        if (hasEncryption.value) {
            setupEncryptedPlayback();
        }

        player.src({ src: props.playbackUrl, type: 'application/x-mpegURL' });

        if (pendingSeekTime != null) {
            const seekTo = pendingSeekTime;
            pendingSeekTime = null;
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
            fluid: true,
            responsive: true,
            poster: audioOnly.value ? audioPosterUrl : undefined,
            html5: { vhs: { overrideNative: true } },
        });

        // Set up auth interceptors before loading source
        if (props.previewToken) {
            setupPreviewAuth();
        }
        if (hasEncryption.value) {
            setupEncryptedPlayback();
        }

        player.src({ src: props.playbackUrl, type: 'application/x-mpegURL' });

        player.ready(() => {
            try {
                (player as any).hlsQualitySelector({ displayCurrentQuality: true });
            } catch (e) {
                console.warn('HLS quality selector unavailable:', e);
            }
            if (props.thumbnailVttUrl) {
                try {
                    (player as any).thumbnailPreview({ vttUrl: props.thumbnailVttUrl });
                } catch (e) {
                    console.warn('Thumbnail preview unavailable:', e);
                }
            }
        });
    } catch (e) {
        console.error('Failed to initialize video player:', e);
    }
}

// Track pending seek for source changes (angle switching)
let pendingSeekTime: number | null = null;

watch(() => props.playbackUrl, async (url) => {
    if (url) {
        // Clear cached encryption key on source change so fresh key is fetched if needed
        cachedEncryptionKey = null;
        await nextTick();
        initPlayer();
    }
});

onBeforeUnmount(() => {
    if (player) {
        player.dispose();
        player = null;
    }
});

// Expose methods for parent components (angle switching, etc.)
function setSource(url: string) {
    if (!player) return;
    cachedEncryptionKey = null;

    if (props.previewToken) {
        setupPreviewAuth();
    }
    if (hasEncryption.value) {
        setupEncryptedPlayback();
    }

    player.src({ src: url, type: 'application/x-mpegURL' });
}

function getCurrentTime(): number {
    return player?.currentTime() ?? 0;
}

function setPendingSeek(time: number) {
    pendingSeekTime = time;
}

defineExpose({ setSource, getCurrentTime, setPendingSeek });
</script>

<template>
    <div
        v-if="playbackUrl"
        class="rounded-lg bg-black [&_.video-js]:overflow-visible [&_.vjs-control-bar]:overflow-visible"
    >
        <video
            ref="playerEl"
            class="video-js vjs-big-play-centered"
            playsinline
        />
    </div>
</template>
