<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
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
    encryptionKeyHex?: string | null;
    preserveStateOnSourceChange?: boolean;
}>();

const playerEl = ref<HTMLVideoElement | null>(null);
let player: Player | null = null;
const blobUrls: string[] = [];

// SVG poster for audio-only playlists
const audioPosterUrl = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#18181b"/>' +
    '<g transform="translate(280,130)" fill="none" stroke="#52525b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 56V34a36 36 0 0 1 72 0v22"/>' +
    '<rect x="0" y="48" width="16" height="32" rx="4" fill="#52525b"/>' +
    '<rect x="64" y="48" width="16" height="32" rx="4" fill="#52525b"/>' +
    '</g></svg>',
)}`;

// Initial hint from props; refined at runtime via loadedmetadata.
const detectedAudioOnly = ref(false);
const audioOnly = computed(
    () => detectedAudioOnly.value || props.isAudioOnly || props.encodingType === 'audio',
);

function applyAudioOnlyPoster() {
    if (!player) return;
    if (audioOnly.value) {
        player.poster(audioPosterUrl);
    } else {
        player.poster('');
    }
}

function detectAudioOnlyFromPlayer() {
    if (!player) return;
    // Any loaded rendition with no video track → audio-only playlist
    const vw = player.videoWidth();
    const vh = player.videoHeight();
    detectedAudioOnly.value = vw === 0 && vh === 0;
    applyAudioOnlyPoster();
}

function revokeAllBlobs() {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.length = 0;
}

function createBlobUrl(content: string, type: string): string {
    const url = URL.createObjectURL(new Blob([content], { type }));
    blobUrls.push(url);
    return url;
}

function resolveUrl(base: string, relative: string): string {
    // Resolve a relative URL against a base URL
    const url = new URL(relative, base);
    return url.href;
}

/**
 * Rewrite HLS playlists to replace encryption key URIs with a blob URL.
 * Fetches the master playlist, all referenced sub-playlists, rewrites
 * #EXT-X-KEY URIs, and returns a blob URL for the modified master.
 * Works with both Video.js VHS and Safari's native HLS player.
 */
async function rewriteEncryptedPlaylist(playbackUrl: string, keyHex: string): Promise<string> {
    revokeAllBlobs();

    // Create blob URL for the raw key bytes
    const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const keyBlob = new Blob([keyBytes], { type: 'application/octet-stream' });
    const keyBlobUrl = URL.createObjectURL(keyBlob);
    blobUrls.push(keyBlobUrl);

    // Fetch master playlist
    const masterRes = await fetch(playbackUrl);
    if (!masterRes.ok) throw new Error(`Failed to fetch master playlist (${masterRes.status})`);
    const masterContent = await masterRes.text();

    // Check if this is a master playlist (contains #EXT-X-STREAM-INF or #EXT-X-MEDIA)
    const isMaster = masterContent.includes('#EXT-X-STREAM-INF') || masterContent.includes('#EXT-X-MEDIA');

    const baseUrl = playbackUrl.substring(0, playbackUrl.lastIndexOf('/') + 1);

    if (!isMaster) {
        // Single media playlist — rewrite key URIs and make segments absolute
        const rewritten = rewriteMediaPlaylist(masterContent, keyBlobUrl, baseUrl);
        return createBlobUrl(rewritten, 'application/vnd.apple.mpegurl');
    }

    // Master playlist — find and rewrite all referenced playlists
    const playlistMap = new Map<string, string>(); // original relative URI → blob URL

    const lines = masterContent.split('\n');

    // Collect all referenced playlist URIs (variant streams + audio/subtitle tracks)
    const playlistUris = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Variant stream playlist (line after #EXT-X-STREAM-INF)
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const next = lines[i + 1]?.trim();
            if (next && !next.startsWith('#') && next.endsWith('.m3u8')) {
                playlistUris.add(next);
            }
        }
        // Audio/subtitle tracks
        const uriMatch = line.match(/URI="([^"]+\.m3u8)"/);
        if (uriMatch) {
            playlistUris.add(uriMatch[1]);
        }
    }

    // Fetch, rewrite, and create blob URLs for each sub-playlist
    await Promise.all([...playlistUris].map(async (uri) => {
        try {
            const url = resolveUrl(baseUrl, uri);
            const res = await fetch(url);
            if (!res.ok) return;
            const content = await res.text();
            const subBaseUrl = url.substring(0, url.lastIndexOf('/') + 1);
            const rewritten = rewriteMediaPlaylist(content, keyBlobUrl, subBaseUrl);
            playlistMap.set(uri, createBlobUrl(rewritten, 'application/vnd.apple.mpegurl'));
        } catch {
            // Skip failed sub-playlists
        }
    }));

    // Rewrite master playlist to point to blob URLs for sub-playlists
    const rewrittenMaster = lines.map((line, i) => {
        const trimmed = line.trim();
        // Replace variant stream URI
        if (i > 0 && lines[i - 1].trim().startsWith('#EXT-X-STREAM-INF:')) {
            const blobUrl = playlistMap.get(trimmed);
            if (blobUrl) return blobUrl;
        }
        // Replace URI="..." in EXT-X-MEDIA etc.
        if (trimmed.includes('URI="') && trimmed.includes('.m3u8')) {
            return trimmed.replace(/URI="([^"]+\.m3u8)"/, (_, uri) => {
                const blobUrl = playlistMap.get(uri);
                return blobUrl ? `URI="${blobUrl}"` : `URI="${uri}"`;
            });
        }
        return line;
    }).join('\n');

    return createBlobUrl(rewrittenMaster, 'application/vnd.apple.mpegurl');
}

/**
 * Rewrite a media playlist:
 * - Replace #EXT-X-KEY URIs with the key blob URL
 * - Make all segment/init URIs absolute (required since the playlist is served as a blob)
 */
function rewriteMediaPlaylist(content: string, keyBlobUrl: string, playlistBaseUrl: string): string {
    return content.split('\n').map((line) => {
        // Rewrite key URIs
        if (line.startsWith('#EXT-X-KEY:') && line.includes('URI="')) {
            return line.replace(/URI="[^"]*"/, `URI="${keyBlobUrl}"`);
        }
        // Rewrite EXT-X-MAP URI (init segment)
        if (line.startsWith('#EXT-X-MAP:') && line.includes('URI="')) {
            return line.replace(/URI="([^"]*)"/, (_, uri) => {
                if (uri.startsWith('http') || uri.startsWith('blob:')) return `URI="${uri}"`;
                return `URI="${resolveUrl(playlistBaseUrl, uri)}"`;
            });
        }
        // Rewrite segment URIs (non-comment, non-empty lines)
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            if (trimmed.startsWith('http') || trimmed.startsWith('blob:')) return line;
            return resolveUrl(playlistBaseUrl, trimmed);
        }
        return line;
    }).join('\n');
}

async function getEffectivePlaybackUrl(): Promise<string | null> {
    if (!props.playbackUrl) return null;
    if (props.encryptionKeyHex) {
        try {
            return await rewriteEncryptedPlaylist(props.playbackUrl, props.encryptionKeyHex);
        } catch (e) {
            console.error('Failed to rewrite encrypted playlist:', e);
            // Fall back to direct URL (will fail on Safari for encrypted content)
            return props.playbackUrl;
        }
    }
    return props.playbackUrl;
}

async function initPlayer() {
    if (!props.playbackUrl) return;

    // Wait for the <video> element to be in the DOM — may not be
    // available immediately when v-if="playbackUrl" just became truthy.
    if (!playerEl.value) {
        await nextTick();
        if (!playerEl.value) return;
    }

    const effectiveUrl = await getEffectivePlaybackUrl();
    if (!effectiveUrl) return;

    if (player) {
        try { (player as any).audioOnlyMode(false); } catch {}
        player.fluid(true);

        // Reset detection; will be re-evaluated on loadedmetadata for the new source
        detectedAudioOnly.value = false;
        applyAudioOnlyPoster();

        const wasPaused = player.paused();

        player.src({ src: effectiveUrl, type: 'application/x-mpegURL' });
        player.one('loadedmetadata', detectAudioOnlyFromPlayer);

        // Initialize thumbnail preview if now available (e.g. after switching to S3 playback)
        if (props.thumbnailVttUrl) {
            try {
                (player as any).thumbnailPreview({ vttUrl: props.thumbnailVttUrl });
            } catch { /* already initialized or unavailable */ }
        }

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

        player.src({ src: effectiveUrl, type: 'application/x-mpegURL' });
        player.on('loadedmetadata', detectAudioOnlyFromPlayer);

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

watch(() => props.playbackUrl, async (url, oldUrl) => {
    if (url) {
        // Preserve playback position and state when swapping sources
        let savedTime: number | undefined;
        let wasPlaying = false;
        if (props.preserveStateOnSourceChange && player) {
            savedTime = player.currentTime();
            wasPlaying = !player.paused();
        }

        await nextTick();
        await initPlayer();

        // Restore state after new source loads
        if (savedTime !== undefined && player) {
            const restore = () => {
                player!.currentTime(savedTime!);
                if (wasPlaying) player!.play();
                player!.off('loadedmetadata', restore);
            };
            player.on('loadedmetadata', restore);
        }
    }
}, { flush: 'post' });

// Re-init when encryption key becomes available (e.g. fetched async after completion)
watch(() => props.encryptionKeyHex, async (keyHex) => {
    if (keyHex && props.playbackUrl && player) {
        await nextTick();
        await initPlayer();
    }
}, { flush: 'post' });

onMounted(async () => {
    if (props.playbackUrl) {
        await nextTick();
        await initPlayer();
    }
});

onBeforeUnmount(() => {
    if (player) {
        player.dispose();
        player = null;
    }
    revokeAllBlobs();
});

// Expose methods for parent components (angle switching, etc.)
async function setSource(url: string) {
    if (!player) return;

    let effectiveUrl = url;
    if (props.encryptionKeyHex) {
        try {
            effectiveUrl = await rewriteEncryptedPlaylist(url, props.encryptionKeyHex);
        } catch {
            // Fall back to direct URL
        }
    }

    player.src({ src: effectiveUrl, type: 'application/x-mpegURL' });
}

function getCurrentTime(): number {
    return player?.currentTime() ?? 0;
}

function setPendingSeek(time: number) {
    pendingSeekTime = time;
}

function seek(time: number) {
    if (!player) { pendingSeekTime = time; return; }
    player.currentTime(Math.max(0, time));
}

function togglePlay() {
    if (!player) return;
    if (player.paused()) void player.play();
    else player.pause();
}

function isPlaying(): boolean {
    return !!player && !player.paused();
}

defineExpose({ setSource, getCurrentTime, setPendingSeek, seek, togglePlay, isPlaying });
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
