<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import 'video.js/dist/video-js.css';
import {
    extractAnglePlaylist,
    extractAudioOnlyPlaylist,
    listVideoAngles,
    type VideoAngle,
} from '@luminary-media-converter/hls';
import { registerQualitySelector } from '../videojs-quality-selector';
import { registerThumbnailPreview } from '../videojs-thumbnail-preview';

registerQualitySelector();
registerThumbnailPreview();

const props = withDefaults(
    defineProps<{
        playbackUrl: string | null;
        thumbnailVttUrl?: string | null;
        encodingType?: 'video' | 'audio';
        isAudioOnly?: boolean;
        encryptionKeyHex?: string | null;
        preserveStateOnSourceChange?: boolean;
        /** Show the built-in Video.js control bar + custom plugin chrome. Default true. */
        showControls?: boolean;
        /**
         * Camera angle to pin, by `VideoAngle.id` from the `angles-loaded` event.
         * `null`/omitted plays the master's DEFAULT=YES angle (or the master
         * as-is when it carries no video rendition groups).
         */
        angleId?: string | null;
        /** Drop video entirely and play the master's audio renditions. */
        audioOnlyRendition?: boolean;
    }>(),
    { showControls: true },
);

export interface QualityLevelInfo {
    /** Stable key used when calling `setQuality(id)`; matches the rendition height (or bandwidth for audio-only). */
    id: string;
    height: number;
    width: number;
    bitrate: number;
}

export interface AudioTrackInfo {
    /** Native track id; pass to `setAudioTrack(id)` to switch. */
    id: string;
    label: string;
    language: string;
    enabled: boolean;
}

const emit = defineEmits<{
    'quality-levels': [levels: QualityLevelInfo[]];
    'playing-change': [playing: boolean];
    /**
     * Fires whenever the player learns the playable duration. For trimmed
     * encodes and imported sessions this is the only correct duration source;
     * the source probe (when available) reflects the *original* file.
     * Emits `null` when duration is unknown (e.g. just before a source swap).
     */
    'duration-change': [seconds: number | null];
    /**
     * Fires whenever VHS populates / changes the native HLS audio track list.
     * For post-encode HLS this exposes every EXT-X-MEDIA:TYPE=AUDIO rendition
     * so consumer UI can switch tracks via player.audioTracks() directly.
     */
    'audio-tracks': [tracks: AudioTrackInfo[]];
    /**
     * Fires once the master playlist has been read, with what it offers:
     * the camera angles it declares (empty for a single-angle master) and
     * whether an audio-only rendering can be derived from its audio groups.
     */
    'angles-loaded': [info: { angles: VideoAngle[]; hasAudioOnly: boolean }];
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
 * Serve a master playlist to the player from a blob URL.
 *
 * Two things force this. Encryption: the key is held client-side and never
 * published, so every `#EXT-X-KEY` URI has to be swapped for a blob of the raw
 * key bytes — which means rewriting each media playlist too. Angle extraction:
 * the master handed to the player is a narrowed copy, not the file in S3.
 *
 * Either way the playlist the player loads no longer sits at its original URL,
 * so all relative references in it are resolved against `masterUrl` first.
 * Works with both Video.js VHS and Safari's native HLS player.
 */
async function buildMasterBlobUrl(
    masterUrl: string,
    masterContent: string,
    keyHex: string | null,
): Promise<string> {
    revokeAllBlobs();

    let keyBlobUrl: string | null = null;
    if (keyHex) {
        const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
        const keyBlob = new Blob([keyBytes], { type: 'application/octet-stream' });
        keyBlobUrl = URL.createObjectURL(keyBlob);
        blobUrls.push(keyBlobUrl);
    }

    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

    if (!isMasterPlaylist(masterContent)) {
        // Single media playlist — rewrite key URIs and make segments absolute
        const rewritten = rewriteMediaPlaylist(masterContent, keyBlobUrl, baseUrl);
        return createBlobUrl(rewritten, 'application/vnd.apple.mpegurl');
    }

    // original relative URI → URL the rewritten master should point at
    const playlistMap = new Map<string, string>();

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

    if (keyBlobUrl) {
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
    } else {
        // Unencrypted: the sub-playlists are fine as they are, they just have to
        // be addressed absolutely now that the master is served from a blob.
        for (const uri of playlistUris) {
            playlistMap.set(uri, resolveUrl(baseUrl, uri));
        }
    }

    // Rewrite master playlist to point at the resolved sub-playlists
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
function rewriteMediaPlaylist(content: string, keyBlobUrl: string | null, playlistBaseUrl: string): string {
    return content.split('\n').map((line) => {
        // Rewrite key URIs
        if (keyBlobUrl && line.startsWith('#EXT-X-KEY:') && line.includes('URI="')) {
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

function isMasterPlaylist(content: string): boolean {
    return content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA');
}

/**
 * Narrow a multi-angle master to what the caller asked to watch.
 * Returns the text unchanged when nothing needs narrowing.
 */
function selectRendering(masterContent: string): string {
    if (props.audioOnlyRendition) {
        return extractAudioOnlyPlaylist(masterContent) ?? masterContent;
    }
    const angles = listVideoAngles(masterContent);
    if (angles.length === 0) return masterContent;
    // Un-narrowed multi-angle playback is at the mercy of the player's ABR,
    // which is free to hop between angles mid-stream; pin the master's own
    // default instead.
    const angleId =
        props.angleId ?? (angles.find((a) => a.isDefault) ?? angles[0]).id;
    return extractAnglePlaylist(masterContent, angleId);
}

/**
 * Resolve what the player should actually load for `url`.
 *
 * The master is always read first — it is the only place the available camera
 * angles are declared. From there: extract the requested angle (or the
 * audio-only rendering), then hand the result to the blob pipeline if it was
 * narrowed or the segments are encrypted. An untouched, unencrypted master is
 * passed through by URL so the player streams it directly, as before.
 */
async function resolveSource(url: string): Promise<string> {
    let masterContent: string | null = null;
    try {
        const res = await fetch(url);
        if (res.ok) masterContent = await res.text();
    } catch {
        // Unreadable master — fall through to direct playback below.
    }

    if (masterContent === null) {
        emit('angles-loaded', { angles: [], hasAudioOnly: false });
        // Nothing to read, so nothing to rewrite — direct playback is all that
        // is left (and will fail on Safari if the segments are encrypted).
        revokeAllBlobs();
        return url;
    }

    const isMaster = isMasterPlaylist(masterContent);
    emit('angles-loaded', {
        angles: isMaster ? listVideoAngles(masterContent) : [],
        hasAudioOnly: isMaster && extractAudioOnlyPlaylist(masterContent) !== null,
    });

    const selected = isMaster ? selectRendering(masterContent) : masterContent;
    if (selected === masterContent && !props.encryptionKeyHex) {
        revokeAllBlobs();
        return url;
    }

    try {
        return await buildMasterBlobUrl(url, selected, props.encryptionKeyHex ?? null);
    } catch (e) {
        console.error('Failed to prepare playlist for playback:', e);
        return url;
    }
}

async function getEffectivePlaybackUrl(): Promise<string | null> {
    if (!props.playbackUrl) return null;
    return resolveSource(props.playbackUrl);
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
            controls: props.showControls,
            bigPlayButton: props.showControls,
            fluid: true,
            responsive: true,
            poster: audioOnly.value ? audioPosterUrl : undefined,
            html5: { vhs: { overrideNative: true } },
        });

        player.src({ src: effectiveUrl, type: 'application/x-mpegURL' });
        player.on('loadedmetadata', detectAudioOnlyFromPlayer);
        player.on('play', () => emit('playing-change', true));
        player.on('pause', () => emit('playing-change', false));
        const publishDuration = () => {
            const d = player?.duration();
            emit('duration-change', Number.isFinite(d) && d! > 0 ? (d as number) : null);
        };
        player.on('loadedmetadata', publishDuration);
        player.on('durationchange', publishDuration);

        player.ready(() => {
            if (props.showControls) {
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
            }
            // Surface quality levels to consumers regardless of control visibility —
            // the segment editor hosts its own selector when controls are hidden.
            try {
                const ql = (player as any).qualityLevels?.();
                if (ql) {
                    const publish = () => emit('quality-levels', snapshotQualityLevels(ql));
                    ql.on('addqualitylevel', publish);
                    ql.on('removequalitylevel', publish);
                    publish();
                }
            } catch (e) {
                console.warn('Quality levels unavailable:', e);
            }

            // Surface native HLS audio tracks (EXT-X-MEDIA:TYPE=AUDIO) so the
            // chapter editor can drive them via player.audioTracks() directly.
            try {
                const tracks = player?.audioTracks?.() as unknown as RawAudioTrackList & {
                    on: (e: string, cb: () => void) => void;
                };
                if (tracks) {
                    const publish = () => emit('audio-tracks', snapshotAudioTracks(tracks));
                    tracks.on('addtrack', publish);
                    tracks.on('removetrack', publish);
                    tracks.on('change', publish);
                    publish();
                }
            } catch (e) {
                console.warn('Audio tracks unavailable:', e);
            }
        });
    } catch (e) {
        console.error('Failed to initialize video player:', e);
    }
}

interface RawAudioTrack { id?: string; label?: string; language?: string; enabled?: boolean }
interface RawAudioTrackList { length: number; [i: number]: RawAudioTrack }

function snapshotAudioTracks(list: RawAudioTrackList): AudioTrackInfo[] {
    const out: AudioTrackInfo[] = [];
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        out.push({
            id: t.id ?? String(i),
            label: t.label ?? '',
            language: t.language ?? '',
            enabled: !!t.enabled,
        });
    }
    return out;
}

function snapshotQualityLevels(ql: { levels_?: Array<Record<string, number>>; length: number }): QualityLevelInfo[] {
    const raw: Array<Record<string, number>> = ql.levels_ ?? [];
    const seen = new Map<string, QualityLevelInfo>();
    for (const level of raw) {
        const height = Number(level.height) || 0;
        const width = Number(level.width) || 0;
        const bitrate = Number(level.bitrate) || 0;
        const id = height > 0 ? `${height}` : `b${bitrate}`;
        if (!seen.has(id)) seen.set(id, { id, height, width, bitrate });
    }
    return Array.from(seen.values()).sort((a, b) => b.bitrate - a.bitrate);
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

// Switching angle (or to audio-only) re-derives the playlist from the same
// master URL, so the source has to be rebuilt even though playbackUrl is stable.
watch(() => [props.angleId, props.audioOnlyRendition], async () => {
    if (!props.playbackUrl || !player) return;
    await nextTick();
    await initPlayer();
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
    const effectiveUrl = await resolveSource(url);
    player.src({ src: effectiveUrl, type: 'application/x-mpegURL' });
}

function getCurrentTime(): number {
    return player?.currentTime() ?? 0;
}

function getDuration(): number | null {
    const d = player?.duration();
    return Number.isFinite(d) && (d as number) > 0 ? (d as number) : null;
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

/**
 * Switch the active native audio track. Pass an id from the `audio-tracks`
 * event payload. VHS observes the `enabled` flag and rebuilds the audio
 * segment loader transparently.
 */
function setAudioTrack(id: string) {
    const tracks = player?.audioTracks?.() as RawAudioTrackList | undefined;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const tid = t.id ?? String(i);
        t.enabled = tid === id;
    }
}

/**
 * Enable a specific rendition by id (matches the `id` from the `quality-levels` event)
 * or pass `null` to re-enable all levels (auto/ABR). Mirrors the behavior of the
 * in-player custom quality selector.
 */
function setQuality(id: string | null) {
    if (!player) return;
    const ql = (player as unknown as { qualityLevels?: () => { length: number; [i: number]: { enabled: boolean; height?: number; bitrate?: number } } }).qualityLevels?.();
    if (!ql) return;
    for (let i = 0; i < ql.length; i++) {
        const level = ql[i];
        const height = Number(level.height) || 0;
        const bitrate = Number(level.bitrate) || 0;
        const levelId = height > 0 ? `${height}` : `b${bitrate}`;
        level.enabled = id === null || levelId === id;
    }
}

defineExpose({ setSource, getCurrentTime, getDuration, setPendingSeek, seek, togglePlay, isPlaying, setQuality, setAudioTrack });
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
