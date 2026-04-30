<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRoute, useRouter } from 'vue-router';
import { EncodeConfigForm, computeLayoutKey, saveConfig } from '@luminary-media-converter/encode-config';
import type { ProbeResult, EncodeConfig, TrimSegment } from '@luminary-media-converter/encode-config';
import { SegmentEditor } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import { useChapters } from '../composables/useChapters';
import HlsPlayer from '../components/HlsPlayer.vue';
import type { AudioTrackInfo, QualityLevelInfo } from '../components/HlsPlayer.vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import InlineConfirm from '../components/InlineConfirm.vue';
import { getSessionDetail, getSessionStatus, startEncode, deleteSession, updateSessionName, moveSessionFiles, renameSessionPrefix, listS3Configs, checkPrefix } from '../api';
import { useSessionPoller } from '../composables/useSessionPoller';
import { useActiveUploads } from '../composables/useActiveUploads';
import type { AccelMode, SegmentFormat } from '../types';

const { getAccessTokenSilently } = useAuth0();
const route = useRoute();
const router = useRouter();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const session = ref<any>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const submissionError = ref<string | null>(null);

// Active session tokens (from SaaS detail response)
const sessionToken = ref<string | null>(null);
const encodingApiUrl = ref<string | null>(null);

// Probe/encode state
const probeResult = ref<ProbeResult | null>(null);
const probeLoading = ref(false);
const encodingType = ref<'video' | 'audio'>('video');
const byteRangeEnabled = ref(true);
const submitting = ref(false);
const editorSegments = ref<Segment[]>([]);
const trimSegments = computed<TrimSegment[]>(() =>
    editorSegments.value.map((s) => ({ inSec: s.inSec, outSec: s.outSec })),
);
const configFormRef = ref<InstanceType<typeof EncodeConfigForm> | null>(null);

// Chapter editor — sidecar VTT in S3, autosaves to localStorage, explicit save to S3.
const chapters = useChapters({ getAccessToken: () => getAccessTokenSilently() });
const chapterSegments = chapters.segments;
const chaptersSaveError = ref<string | null>(null);

// Playback duration as reported by the player — the only correct source for
// the chapter timeline since it reflects trim cuts on encoded output and is
// the only signal available for imported sessions (which never run probe).
const playerDuration = ref<number | null>(null);
const chapterTimelineDuration = computed(
    () => playerDuration.value ?? probeResult.value?.format?.duration ?? 0,
);

// Session name
const sessionName = ref('');
const editingName = ref(false);
const nameInput = ref('');
const savingName = ref(false);

async function startEditName() {
    nameInput.value = sessionName.value;
    editingName.value = true;
}

async function saveName() {
    const trimmed = nameInput.value.trim();
    if (trimmed === sessionName.value) {
        editingName.value = false;
        return;
    }
    savingName.value = true;
    try {
        const token = await getAccessTokenSilently();
        await updateSessionName(token, sessionId.value, trimmed);
        sessionName.value = trimmed;
        if (session.value) session.value.name = trimmed;
    } catch {
        // Non-critical
    } finally {
        savingName.value = false;
        editingName.value = false;
    }
}

function cancelEditName() {
    editingName.value = false;
}

// Encryption key
const encryptionKeyHex = ref<string | undefined>();

// SaaS polling for non-local uploads
const sessionId = computed(() => route.params.id as string);

const poller = useSessionPoller();
const activeUploads = useActiveUploads();

// ---------------------------------------------------------------------------
// Status badge config
// ---------------------------------------------------------------------------

const statusConfig: Record<string, { label: string; color: string; borderColor: string }> = {
    created: { label: 'Created', color: 'text-zinc-400', borderColor: 'border-zinc-700' },
    uploading: { label: 'Uploading', color: 'text-cyan-400', borderColor: 'border-cyan-700/60' },
    uploaded: { label: 'Uploaded', color: 'text-zinc-400', borderColor: 'border-zinc-700' },
    queued: { label: 'Queued', color: 'text-amber-400', borderColor: 'border-amber-700/60' },
    encoding: { label: 'Encoding', color: 'text-indigo-400', borderColor: 'border-indigo-700/60' },
    encrypting: { label: 'Encrypting', color: 'text-amber-400', borderColor: 'border-amber-700/60' },
    uploading_to_s3: { label: 'Uploading to S3', color: 'text-cyan-400', borderColor: 'border-cyan-700/60' },
    completed: { label: 'Completed', color: 'text-emerald-400', borderColor: 'border-emerald-700/60' },
    failed: { label: 'Failed', color: 'text-red-400', borderColor: 'border-red-700/60' },
    imported: { label: 'Imported', color: 'text-violet-400', borderColor: 'border-violet-700/60' },
};

const ICON_PATHS = {
    cpu: 'M9 3.5V2m0 17.5V21M5.06 5.06l-.94-.94m13.76 13.76-.94-.94M2 12H3.5m17 0H22M5.06 18.94l-.94.94M18.82 5.06l.94-.94M12 8a4 4 0 100 8 4 4 0 000-8z',
    gpu: 'M13 10V3L4 14h7v7l9-11h-7z',
    warning: 'M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    lock: 'M5 11V7a5 5 0 0110 0v4M3 11h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2V11z',
} as Record<string, string>;

const encoderConfig: Record<string, { label: string; icon: string }> = {
    cpu: { label: 'CPU', icon: ICON_PATHS.cpu },
    nvidia: { label: 'NVIDIA GPU', icon: ICON_PATHS.gpu },
    apple: { label: 'Apple GPU', icon: ICON_PATHS.gpu },
};

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

// Use poller status for active sessions, session doc status for historical
const pollerStatus = computed(() => poller.status.value);
const sessionDocStatus = computed(() => session.value?.status ?? null);

const currentStatus = computed<string | null>(() => {
    return pollerStatus.value ?? sessionDocStatus.value;
});

const isActiveSession = computed(() => !!sessionToken.value && !!encodingApiUrl.value);

const isTerminal = computed(() => {
    const ps = pollerStatus.value;
    const ss = sessionDocStatus.value;
    return ps === 'completed' || ps === 'failed'
        || ss === 'completed' || ss === 'failed' || ss === 'imported';
});

const isCompleted = computed(() => {
    const ps = pollerStatus.value;
    const ss = sessionDocStatus.value;
    return ps === 'completed'
        || ss === 'completed' || ss === 'imported';
});

const isExpired = computed(() => {
    // Non-terminal status but no session token means the encoding session expired
    return !isTerminal.value && !isActiveSession.value && !loading.value && session.value;
});

const s3PublicBaseUrl = computed(() => {
    const s3 = session.value?.s3Config;
    if (s3?.publicUrl) return s3.publicUrl.replace(/\/+$/, '');
    if (!s3?.endPoint || !s3?.bucket) return undefined;
    // Strip any protocol prefix from endPoint to avoid double https://
    const bareHost = s3.endPoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const protocol = s3.useSSL === false ? 'http' : 'https';
    const port = s3.port ? ':' + s3.port : '';
    return protocol + '://' + bareHost + port + '/' + s3.bucket;
});

const isEncrypted = computed(() => !!session.value?.encrypted);

// Access the uploads ref directly for reactivity
const activeUpload = computed(() => {
    const id = sessionId.value;
    return id ? activeUploads.uploads.value[id] : undefined;
});

const showUploadProgress = computed(() => {
    const s = currentStatus.value;
    return (s === 'created' || s === 'uploading') && activeUpload.value && !activeUpload.value.done;
});

const showUploadDoneWaiting = computed(() => {
    const s = currentStatus.value;
    return (s === 'created' || s === 'uploading') && activeUpload.value?.done && !activeUpload.value?.error;
});

const showUploadRemoteMessage = computed(() => {
    const s = currentStatus.value;
    return (s === 'created' || s === 'uploading') && !activeUpload.value;
});

// Server-side ingest (URL download): show poller-driven progress when there
// is no client-side tus upload in flight. progress=0 means total length is
// unknown — fall back to indeterminate display.
const remoteIngestProgress = computed<number | undefined>(() => {
    const p = poller.progress.value;
    if (typeof p !== 'number' || p <= 0) return undefined;
    return p;
});

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

const remoteIngestLabel = computed<string>(() => {
    const total = poller.ingestTotalBytes.value;
    return total != null
        ? `Uploading from URL... (${formatBytes(total)})`
        : 'Uploading from URL...';
});

const showProbeConfig = computed(() => {
    const s = currentStatus.value;
    return s === 'uploaded' && isActiveSession.value && probeResult.value && !submitting.value;
});

const showEncoding = computed(() => {
    const s = currentStatus.value;
    return (s === 'queued' || s === 'encoding' || s === 'encrypting' || s === 'uploading_to_s3') && isActiveSession.value;
});

// Server-side preview — API serves on-demand HLS segments.
// The preview URL is set once the session has a token and encoding API URL.
// The API generates segments from the source file (copy or transcode).
// ---------------------------------------------------------------------------
// Preview audio tracks
// ---------------------------------------------------------------------------

interface PreviewAudioTrack {
    index: number;
    streamIndex: number;
    language?: string;
    name?: string;
    bitrateKbps?: number;
    codec?: string;
    isDefault: boolean;
}

function audioTrackLabel(track: PreviewAudioTrack): string {
    // Use editable track metadata from the encode config form when available
    const formTrack = configFormRef.value?.editableAudioTracks?.[track.index];
    const name = formTrack?.name ?? track.name;
    const language = formTrack?.language ?? track.language;
    const parts: string[] = [String(track.index)];
    if (name) parts.push(name);
    if (language && language !== 'und') parts.push(language);
    if (track.codec) parts.push(track.codec);
    if (track.bitrateKbps) parts.push(`${track.bitrateKbps}kbps`);
    return parts.join(' · ');
}

const previewAudioTracks = ref<PreviewAudioTrack[]>([]);
const selectedAudioTrack = ref(0);
const previewQualityLevels = ref<QualityLevelInfo[]>([]);
const selectedQualityId = ref<string | null>(null);
const isPreviewPlaying = ref(false);
// Native HLS audio tracks (post-encode). Driven via player.audioTracks() so
// we leverage VHS's built-in track switching rather than re-fetching playlists.
const nativeAudioTracks = ref<AudioTrackInfo[]>([]);
const selectedNativeAudioId = computed(() => {
    const enabled = nativeAudioTracks.value.find((t) => t.enabled);
    return enabled?.id ?? null;
});

function onPreviewQualityLevels(levels: QualityLevelInfo[]) {
    previewQualityLevels.value = levels;
}

function onQualityChange(id: string | null) {
    selectedQualityId.value = id;
    playerRef.value?.setQuality(id);
}

function onNativeAudioTracks(tracks: AudioTrackInfo[]) {
    nativeAudioTracks.value = tracks;
}

function onNativeAudioChange(id: string) {
    playerRef.value?.setAudioTrack(id);
}

function nativeAudioLabel(t: AudioTrackInfo): string {
    const parts: string[] = [];
    if (t.label) parts.push(t.label);
    if (t.language && t.language !== t.label) parts.push(`(${t.language})`);
    return parts.join(' ') || t.id;
}

async function fetchPreviewAudioTracks() {
    if (!sessionToken.value || !encodingApiUrl.value) return;
    try {
        const res = await fetch(
            `${encodingApiUrl.value}/api/sessions/${sessionId.value}/preview/audio-tracks?token=${sessionToken.value}`,
        );
        if (res.ok) {
            const tracks = await res.json();
            previewAudioTracks.value = tracks;
            const defaultTrack = tracks.find((t: PreviewAudioTrack) => t.isDefault);
            if (defaultTrack) selectedAudioTrack.value = defaultTrack.index;
        }
    } catch {
        // Preview audio tracks not available — single track
    }
}

const previewPlaybackUrl = computed(() => {
    if (!sessionToken.value || !encodingApiUrl.value) return null;
    const s = currentStatus.value;
    if (!s || s === 'created' || s === 'uploading') return null;
    let url = `${encodingApiUrl.value}/api/sessions/${sessionId.value}/preview/playlist.m3u8?token=${sessionToken.value}`;
    if (previewAudioTracks.value.length > 1) {
        url += `&audio=${selectedAudioTrack.value}`;
    }
    return url;
});

// Fetch audio tracks when preview becomes available
watch(previewPlaybackUrl, (url) => {
    if (url && previewAudioTracks.value.length === 0) {
        fetchPreviewAudioTracks();
    }
});

// Active playback URL — preview during encoding, S3 after completion (ABR)
// For encrypted sessions, wait for the encryption key before switching to S3
// (otherwise the player loads the raw playlist with unrewritten #EXT-X-KEY URIs).
const activePlaybackUrl = computed(() => {
    if (isCompleted.value) {
        const hasKey = !!(encryptionKeyHex.value || poller.encryptionKeyHex.value);
        if (isEncrypted.value && !hasKey) return previewPlaybackUrl.value;
        return playbackUrl.value ?? previewPlaybackUrl.value;
    }
    return previewPlaybackUrl.value;
});

// Display metadata from the session detail or poller
const displayEncoder = computed<AccelMode | string | undefined>(
    () => poller.encoder.value ?? session.value?.encoder,
);

const displaySegmentFormat = computed<SegmentFormat | string | undefined>(
    () => poller.segmentFormat.value ?? session.value?.segmentFormat,
);

// ---------------------------------------------------------------------------
// ETA calculation
// ---------------------------------------------------------------------------

function computeEtaFromSamples(
    samples: { time: number; progress: number }[],
    currentProgress: number,
    now: number,
): { remainingSec: number } | undefined {
    if (samples.length < 2) return undefined;
    const oldest = samples[0];
    const elapsed = (now - oldest.time) / 1000;
    const progressDelta = currentProgress - oldest.progress;
    if (progressDelta <= 0 || elapsed <= 0) return undefined;
    const rate = progressDelta / elapsed;
    const remainingSec = (100 - currentProgress) / rate;
    if (remainingSec < 0 || !isFinite(remainingSec)) return undefined;
    return { remainingSec };
}

const etaSamples: { time: number; progress: number }[] = [];
const etaDisplay = ref<string | undefined>();

watch(
    () => poller.pipelineProgress.value?.encoding ?? poller.progress.value,
    (encodingProgress) => {
        if (encodingProgress == null || encodingProgress <= 0) {
            etaDisplay.value = undefined;
            return;
        }

        const now = Date.now();
        etaSamples.push({ time: now, progress: encodingProgress });

        // Keep last 30 seconds of samples
        const cutoff = now - 30_000;
        while (etaSamples.length > 1 && etaSamples[0].time < cutoff) {
            etaSamples.shift();
        }

        const eta = computeEtaFromSamples(etaSamples, encodingProgress, now);
        if (!eta) {
            etaDisplay.value = undefined;
            return;
        }
        const { remainingSec } = eta;

        const remainingLabel =
            remainingSec >= 3600
                ? `~${Math.round(remainingSec / 3600)} hr remaining`
                : remainingSec >= 60
                  ? `~${Math.round(remainingSec / 60)} min remaining`
                  : `~${Math.round(remainingSec)} sec remaining`;

        const completionTime = new Date(now + remainingSec * 1000);
        const timeStr = completionTime.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });

        etaDisplay.value = `${remainingLabel} \u00B7 Est. completion: ${timeStr}`;
    },
);

// URL ingest ETA — separate sample buffer from the encoding ETA so the two
// phases don't pollute each other (rates differ by orders of magnitude).
const ingestEtaSamples: { time: number; progress: number }[] = [];
const ingestEtaDisplay = ref<string | undefined>();

watch(
    () => ({ status: currentStatus.value, progress: poller.progress.value }),
    ({ status, progress }) => {
        if (status !== 'uploading' || progress == null || progress <= 0) {
            ingestEtaSamples.length = 0;
            ingestEtaDisplay.value = undefined;
            return;
        }

        const now = Date.now();
        ingestEtaSamples.push({ time: now, progress });

        const cutoff = now - 30_000;
        while (ingestEtaSamples.length > 1 && ingestEtaSamples[0].time < cutoff) {
            ingestEtaSamples.shift();
        }

        const eta = computeEtaFromSamples(ingestEtaSamples, progress, now);
        if (!eta) {
            ingestEtaDisplay.value = undefined;
            return;
        }
        const { remainingSec } = eta;

        const remainingLabel =
            remainingSec >= 3600
                ? `~${Math.round(remainingSec / 3600)} hr remaining`
                : remainingSec >= 60
                  ? `~${Math.round(remainingSec / 60)} min remaining`
                  : `~${Math.round(remainingSec)} sec remaining`;

        const completionTime = new Date(now + remainingSec * 1000);
        const timeStr = completionTime.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });

        ingestEtaDisplay.value = `${remainingLabel} \u00B7 Est. completion: ${timeStr}`;
    },
);


// ---------------------------------------------------------------------------
// Player — angle switching, playback URL, copy, files
// ---------------------------------------------------------------------------

const playerRef = ref<InstanceType<typeof HlsPlayer> | null>(null);
const currentAngleIndex = ref(0);
const copied = ref(false);
const copiedKey = ref(false);
const showFiles = ref(false);
let copyTimeout: ReturnType<typeof setTimeout> | null = null;
let copyKeyTimeout: ReturnType<typeof setTimeout> | null = null;

const displayMasterPlaylist = computed(
    () => poller.masterPlaylist.value ?? session.value?.masterPlaylist,
);
const displayAnglePlaylists = computed(
    () => poller.anglePlaylists.value ?? session.value?.anglePlaylists,
);
const displayFiles = computed<string[] | undefined>(
    () => (poller.files.value ?? session.value?.files) as string[] | undefined,
);
const displayThumbnailsVtt = computed(
    () => poller.thumbnailsVtt.value ?? session.value?.thumbnailsVtt,
);

const uniqueAnglePlaylists = computed(() => {
    const lists = displayAnglePlaylists.value;
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

const showAngleSwitcher = computed(() => uniqueAnglePlaylists.value.length > 1);

const currentAngleIsAudioOnly = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (!lists.length) return false;
    return lists[currentAngleIndex.value]?.name === 'Audio only';
});

const isAudioOnly = computed(
    () => encodingType.value === 'audio' || currentAngleIsAudioOnly.value,
);

const primaryPlaylistKey = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (lists.length) {
        return lists[currentAngleIndex.value]?.key ?? lists[0]?.key;
    }
    return displayMasterPlaylist.value;
});

const s3Url = computed(() => {
    if (!primaryPlaylistKey.value || !s3PublicBaseUrl.value) return null;
    return `${s3PublicBaseUrl.value}/${primaryPlaylistKey.value}`;
});

const playbackUrl = computed(() => {
    if (!primaryPlaylistKey.value) return null;
    return s3Url.value;
});

const thumbnailVttUrl = computed(() => {
    if (!displayThumbnailsVtt.value || !s3PublicBaseUrl.value) return null;
    return `${s3PublicBaseUrl.value}/${displayThumbnailsVtt.value}`;
});

const shouldCollapseFiles = computed(() => (displayFiles.value?.length ?? 0) > 10);

function switchToAngle(index: number) {
    if (index === currentAngleIndex.value) return;
    if (playerRef.value) {
        const currentTime = playerRef.value.getCurrentTime();
        playerRef.value.setPendingSeek(currentTime);
    }
    currentAngleIndex.value = index;
}

async function copyPlaybackUrl() {
    if (!s3Url.value) return;
    await navigator.clipboard.writeText(s3Url.value);
    copied.value = true;
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(() => { copied.value = false; }, 2000);
}

async function copyEncryptionKey() {
    if (!encryptionKeyHex.value) return;
    await navigator.clipboard.writeText(encryptionKeyHex.value);
    copiedKey.value = true;
    if (copyKeyTimeout) clearTimeout(copyKeyTimeout);
    copyKeyTimeout = setTimeout(() => { copiedKey.value = false; }, 2000);
}

// ---------------------------------------------------------------------------
// Delete session
// ---------------------------------------------------------------------------

const deleting = ref(false);

const hasS3Files = computed(
    () => !!session.value?.s3ConfigId && !!(session.value?.s3Config?.pathPrefix || session.value?.files?.length),
);

async function onConfirmDelete(withFiles: boolean) {
    deleting.value = true;
    try {
        const token = await getAccessTokenSilently();
        await deleteSession(sessionId.value, token, withFiles);
        router.push('/sessions');
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        deleting.value = false;
    }
}

// ---------------------------------------------------------------------------
// Move files
// ---------------------------------------------------------------------------

const showMoveForm = ref(false);
const moving = ref(false);
const moveError = ref<string | null>(null);
const s3Configs = ref<any[]>([]);
const selectedTargetConfigId = ref('');
const moveNewPrefix = ref('');
const movePrefixWarning = ref<string | null>(null);
const moveConfirmedOverwrite = ref(false);
const checkingMovePrefix = ref(false);

async function openMoveForm() {
    moveError.value = null;
    movePrefixWarning.value = null;
    moveConfirmedOverwrite.value = false;
    try {
        const token = await getAccessTokenSilently();
        const result = await listS3Configs(token);
        s3Configs.value = result.configs ?? result;
    } catch (e) {
        moveError.value = e instanceof Error ? e.message : String(e);
        return;
    }
    selectedTargetConfigId.value = '';
    moveNewPrefix.value = session.value?.s3Config?.pathPrefix ?? '';
    showMoveForm.value = true;
}

async function checkMovePrefix() {
    movePrefixWarning.value = null;
    moveConfirmedOverwrite.value = false;
    if (!selectedTargetConfigId.value || !moveNewPrefix.value.trim()) return;
    checkingMovePrefix.value = true;
    try {
        const token = await getAccessTokenSilently();
        const result = await checkPrefix(token, selectedTargetConfigId.value, moveNewPrefix.value.trim());
        if (result.exists) {
            movePrefixWarning.value = `This prefix already contains ${result.count} file(s). Moving here will add files alongside existing ones.`;
        }
    } catch {
        // Non-critical — proceed without warning
    } finally {
        checkingMovePrefix.value = false;
    }
}

const canMove = computed(() =>
    !!selectedTargetConfigId.value &&
    !!moveNewPrefix.value.trim() &&
    !moving.value &&
    !checkingMovePrefix.value &&
    (!movePrefixWarning.value || moveConfirmedOverwrite.value),
);

async function confirmMove() {
    if (!canMove.value) return;
    moving.value = true;
    moveError.value = null;
    try {
        const token = await getAccessTokenSilently();
        await moveSessionFiles(token, sessionId.value, selectedTargetConfigId.value, moveNewPrefix.value.trim());
        showMoveForm.value = false;
        await fetchSession();
    } catch (e) {
        moveError.value = e instanceof Error ? e.message : String(e);
    } finally {
        moving.value = false;
    }
}

// ---------------------------------------------------------------------------
// Rename prefix
// ---------------------------------------------------------------------------

const showRenameForm = ref(false);
const renaming = ref(false);
const renameError = ref<string | null>(null);
const renameNewPrefix = ref('');
const renamePrefixWarning = ref<string | null>(null);
const renameConfirmedOverwrite = ref(false);
const checkingRenamePrefix = ref(false);

function openRenameForm() {
    renameError.value = null;
    renamePrefixWarning.value = null;
    renameConfirmedOverwrite.value = false;
    renameNewPrefix.value = session.value?.s3Config?.pathPrefix ?? '';
    showRenameForm.value = true;
}

async function checkRenamePrefix() {
    renamePrefixWarning.value = null;
    renameConfirmedOverwrite.value = false;
    if (!renameNewPrefix.value.trim() || !session.value?.s3ConfigId) return;
    checkingRenamePrefix.value = true;
    try {
        const token = await getAccessTokenSilently();
        const result = await checkPrefix(token, session.value.s3ConfigId, renameNewPrefix.value.trim());
        if (result.exists) {
            renamePrefixWarning.value = `This prefix already contains ${result.count} file(s). Renaming here will add files alongside existing ones.`;
        }
    } catch {
        // Non-critical
    } finally {
        checkingRenamePrefix.value = false;
    }
}

const canRename = computed(() =>
    !!renameNewPrefix.value.trim() &&
    !renaming.value &&
    !checkingRenamePrefix.value &&
    (!renamePrefixWarning.value || renameConfirmedOverwrite.value),
);

async function confirmRename() {
    if (!canRename.value) return;
    renaming.value = true;
    renameError.value = null;
    try {
        const token = await getAccessTokenSilently();
        await renameSessionPrefix(token, sessionId.value, renameNewPrefix.value.trim());
        showRenameForm.value = false;
        await fetchSession();
    } catch (e) {
        renameError.value = e instanceof Error ? e.message : String(e);
    } finally {
        renaming.value = false;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fetch session detail from SaaS
// ---------------------------------------------------------------------------

async function fetchSession() {
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const detail = await getSessionDetail(token, sessionId.value);
        session.value = detail;
        sessionName.value = detail.name ?? '';
        encryptionKeyHex.value = detail.encryptionKeyHex ?? undefined;

        // Store active session tokens if present
        sessionToken.value = detail.sessionToken ?? null;
        encodingApiUrl.value = detail.encodingApiUrl ?? null;

        // Determine encoding type from session data
        if (detail.encodingType) {
            encodingType.value = detail.encodingType;
        }
        if (detail.byteRange != null) {
            byteRangeEnabled.value = detail.byteRange !== false;
        }

        // Route to appropriate behavior based on status
        await handleStatusAfterLoad(detail.status);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

// ---------------------------------------------------------------------------
// Status-based initialization after loading session detail
// ---------------------------------------------------------------------------

async function handleStatusAfterLoad(status: string) {
    if (status === 'uploaded' && isActiveSession.value) {
        // Fetch probe results from encoding API
        await fetchProbeResults();
    } else if (
        (status === 'queued' || status === 'encoding' || status === 'encrypting' || status === 'uploading_to_s3') &&
        isActiveSession.value
    ) {
        // Start poller for encoding progress
        poller.start(sessionId.value, encodingApiUrl.value!, sessionToken.value!);
    } else if (
        (status === 'created' || status === 'uploading') &&
        isActiveSession.value &&
        !activeUploads.uploads.value[sessionId.value]
    ) {
        // No client-side upload tracked — ingest is happening server-side
        // (URL download or initiated from another tab). Poller delivers the
        // server-emitted progress events and the eventual flip to 'uploaded'.
        poller.start(sessionId.value, encodingApiUrl.value!, sessionToken.value!);
    }
    // completed / failed / imported / expired => no additional setup needed
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fetch probe results from Encoding API
// ---------------------------------------------------------------------------

async function fetchProbeResults() {
    if (!encodingApiUrl.value || !sessionToken.value) return;
    probeLoading.value = true;
    try {
        // Status is already 'uploaded' so probe results should be available — poll directly
        const probe = await pollForProbe(
            encodingApiUrl.value,
            sessionId.value,
            sessionToken.value,
        );
        probeResult.value = probe;
        if (probe) {
            encodingType.value = probe.videoTracks.length ? 'video' : 'audio';
        }
    } catch (e) {
        submissionError.value = e instanceof Error ? e.message : String(e);
    } finally {
        probeLoading.value = false;
    }
}

async function pollForProbe(
    apiUrl: string,
    sid: string,
    token: string,
): Promise<ProbeResult | null> {
    for (let i = 0; i < 60; i++) {
        const data = await getSessionStatus(apiUrl, sid, token);
        // Update session status from encoding API so the UI reflects
        // the actual state (e.g. 'uploaded' after probe completes)
        if (session.value && data.status) {
            session.value = { ...session.value, status: data.status };
        }
        if (data.probeResult) return data.probeResult;
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

// ---------------------------------------------------------------------------
// Encode submission
// ---------------------------------------------------------------------------

async function onEncodeSubmit(config: EncodeConfig) {
    if (!encodingApiUrl.value || !sessionToken.value) return;

    submitting.value = true;
    submissionError.value = null;

    try {
        encodingType.value = config.type;

        // If upload is still in progress, wait for it to complete
        if (activeUpload.value && !activeUpload.value.done) {
            await activeUpload.value.promise;
        }

        // Wait for status to become 'uploaded' (probe may still be running)
        if (currentStatus.value !== 'uploaded') {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for upload to complete')), 120_000);
                const unwatch = watch(currentStatus, (s) => {
                    if (s === 'uploaded') {
                        clearTimeout(timeout);
                        unwatch();
                        resolve();
                    } else if (s === 'failed') {
                        clearTimeout(timeout);
                        unwatch();
                        reject(new Error('Upload failed'));
                    }
                }, { immediate: true });
            });
        }

        // Strip audioTrackMetadata before sending to API, add trim segments
        const { audioTrackMetadata: _, ...apiConfig } = config;
        const submitConfig = trimSegments.value.length > 0
            ? { ...apiConfig, trimSegments: trimSegments.value }
            : apiConfig;
        await startEncode(
            encodingApiUrl.value,
            sessionId.value,
            submitConfig,
            sessionToken.value,
        );

        // Save config for future reuse (strip trimSegments — session-specific)
        if (probeResult.value) {
            const layoutKey = computeLayoutKey(probeResult.value, config.type);
            saveConfig(layoutKey, config);
        }

        // Reload preview with filtered playlist when trim segments are active
        if (trimSegments.value.length > 0 && playerRef.value && previewPlaybackUrl.value) {
            playerRef.value.setSource(previewPlaybackUrl.value);
        }

        // Start polling for encoding progress
        poller.start(sessionId.value, encodingApiUrl.value, sessionToken.value);
    } catch (e) {
        submissionError.value = e instanceof Error ? e.message : String(e);
    } finally {
        submitting.value = false;
    }
}

function onEncodeBack() {
    router.push('/sessions');
}

// ---------------------------------------------------------------------------
// Cancel actions
// ---------------------------------------------------------------------------

async function cancelUpload() {
    const upload = activeUpload.value;
    if (upload) {
        upload.abort();
        activeUploads.remove(sessionId.value);
    }

    try {
        const accessToken = await getAccessTokenSilently();
        await deleteSession(sessionId.value, accessToken);
    } catch {
        // Best-effort cleanup
    }

    router.push('/sessions/new');
}

async function onCancelEncode() {
    poller.stop();

    try {
        const accessToken = await getAccessTokenSilently();
        await deleteSession(sessionId.value, accessToken);
    } catch {
        // Best-effort cleanup
    }

    router.push('/sessions/new');
}

// ---------------------------------------------------------------------------
// Watch for encryption key from poller (included in completion SSE event)
// ---------------------------------------------------------------------------

watch(
    () => poller.encryptionKeyHex.value,
    (key) => {
        if (key) encryptionKeyHex.value = key;
    },
);

// Watch for the upload completing (if tracked locally)
// After tus upload finishes, the Encoding API probes the file which takes time.
// Poll the SaaS until the status advances beyond uploading.
watch(
    () => activeUpload.value?.done,
    (done) => {
        if (done && !activeUpload.value?.error) {
            // Poll encoding API for probe results after upload completes
            if (encodingApiUrl.value && sessionToken.value) {
                fetchProbeResults();
            }
        }
    },
);

// URL-ingest path: no client-side upload entry exists, so the tus-completion
// watch above never fires. Watch the poller's status flip to 'uploaded' and
// fetch probe results from the same handler.
watch(
    () => poller.status.value,
    (status, prev) => {
        if (status === 'uploaded' && prev !== 'uploaded' && !probeResult.value) {
            if (encodingApiUrl.value && sessionToken.value) {
                fetchProbeResults();
            }
        }
    },
);

// ---------------------------------------------------------------------------
// Chapter editor — load / save / discard
// ---------------------------------------------------------------------------

// Load chapters once a post-submit state is reached (preview is then live).
// Uploaded / uploading / created phases use the trim editor on a separate branch.
const isPostSubmit = computed(() => {
    const s = currentStatus.value;
    return s === 'queued' || s === 'encoding' || s === 'encrypting'
        || s === 'uploading_to_s3' || s === 'completed';
});

watch(
    [isPostSubmit, () => sessionId.value],
    async ([active, id]) => {
        if (!active || !id) return;
        if (chapters.isLoaded.value) return;
        try {
            await chapters.load(id);
        } catch (err) {
            chaptersSaveError.value = err instanceof Error ? err.message : String(err);
        }
    },
    { immediate: true },
);

async function onSaveChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.saveRemote();
    } catch (err) {
        chaptersSaveError.value = err instanceof Error ? err.message : String(err);
    }
}

async function onDiscardChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.discardLocal();
    } catch (err) {
        chaptersSaveError.value = err instanceof Error ? err.message : String(err);
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(fetchSession);

onUnmounted(() => {
    poller.stop();
    chapters.unload();
});
</script>

<template>
    <div :class="['mx-auto transition-all duration-300', showProbeConfig ? 'max-w-fit' : 'max-w-2xl']">
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

            <!-- Load error -->
            <div v-else-if="error" class="rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                <p class="text-sm text-red-400">{{ error }}</p>
            </div>

            <!-- Session loaded -->
            <template v-else-if="session">
                <!-- Header -->
                <div class="flex items-center justify-between mb-6">
                    <div>
                        <!-- Editable session name -->
                        <div v-if="editingName" class="flex items-center gap-2">
                            <input
                                v-model="nameInput"
                                type="text"
                                class="input text-lg font-semibold"
                                placeholder="Session name"
                                @keyup.enter="saveName"
                                @keyup.escape="cancelEditName"
                            />
                            <button
                                type="button"
                                :disabled="savingName"
                                @click="saveName"
                                class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                            >
                                {{ savingName ? '...' : 'Save' }}
                            </button>
                            <button
                                type="button"
                                @click="cancelEditName"
                                class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                            >
                                Cancel
                            </button>
                        </div>
                        <h2
                            v-else
                            class="text-lg font-semibold text-zinc-100 cursor-pointer hover:text-indigo-400 transition-colors"
                            @click="startEditName"
                            :title="sessionName ? 'Click to rename' : 'Click to add a name'"
                        >
                            {{ sessionName || 'Untitled session' }}
                        </h2>
                        <p class="mt-0.5 font-mono text-xs text-zinc-500">{{ sessionId }}</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                        <StatusBadge
                            v-if="displayEncoder && encoderConfig[displayEncoder]"
                            :label="encoderConfig[displayEncoder].label"
                            :icon="encoderConfig[displayEncoder].icon"
                            :color="displayEncoder === 'cpu' ? 'text-zinc-400' : 'text-violet-400'"
                            :border-color="displayEncoder === 'cpu' ? 'border-zinc-700' : 'border-violet-700/60'"
                        />
                        <StatusBadge
                            v-if="displaySegmentFormat === 'mpegts'"
                            label="MPEG-TS"
                            color="text-amber-400"
                            border-color="border-amber-700/60"
                            :icon="ICON_PATHS.warning"
                            title="MPEG-TS segments used because source streams have misaligned start times."
                        />
                        <StatusBadge
                            v-if="isEncrypted"
                            label="Encrypted"
                            color="text-amber-400"
                            border-color="border-amber-700/60"
                            :icon="ICON_PATHS.lock"
                        />
                        <StatusBadge
                            v-if="session.imported"
                            label="Imported"
                            color="text-violet-400"
                            border-color="border-violet-700/60"
                        />
                        <StatusBadge
                            :label="currentStatus ? statusConfig[currentStatus]?.label ?? currentStatus : '--'"
                            :color="statusConfig[currentStatus ?? '']?.color ?? 'text-zinc-400'"
                            :border-color="statusConfig[currentStatus ?? '']?.borderColor ?? 'border-zinc-700'"
                        />
                    </div>
                </div>

                <!-- ============================================================ -->
                <!-- Source file preview (visible throughout lifecycle when File   -->
                <!-- was registered in this browser session)                       -->
                <!-- ============================================================ -->
                <!-- Unified HLS player — shows local preview during upload/encoding,
                     swaps to S3 output when encoding completes -->
                <div v-if="activePlaybackUrl" class="mb-4">
                    <HlsPlayer
                        ref="playerRef"
                        :playback-url="activePlaybackUrl"
                        :thumbnail-vtt-url="isCompleted ? thumbnailVttUrl : undefined"
                        :encoding-type="encodingType"
                        :is-audio-only="isAudioOnly"
                        :encryption-key-hex="isCompleted ? (encryptionKeyHex || poller.encryptionKeyHex.value) : undefined"
                        :show-controls="false"
                        preserve-state-on-source-change
                        @quality-levels="onPreviewQualityLevels"
                        @playing-change="isPreviewPlaying = $event"
                        @duration-change="playerDuration = $event"
                        @audio-tracks="onNativeAudioTracks"
                    />
                </div>


                <!-- Submission error banner -->
                <div
                    v-if="submissionError"
                    class="mb-6 rounded-lg bg-red-950/40 border border-red-800/50 p-4"
                >
                    <p class="text-sm text-red-400">{{ submissionError }}</p>
                </div>

                <!-- ============================================================ -->
                <!-- Upload progress (shown independently — not exclusive with    -->
                <!-- the encode config form, which can appear during upload when   -->
                <!-- early probe results are available from moov extraction)       -->
                <!-- ============================================================ -->
                <div v-if="showUploadProgress && !showProbeConfig" class="mb-4">
                    <ProgressBar
                        :label="activeUpload!.progress >= 100 ? 'Finalizing upload...' : 'Uploading...'"
                        :progress="activeUpload!.progress"
                        :indeterminate="activeUpload!.progress >= 100"
                    />
                    <div class="flex justify-end pt-2">
                        <button
                            v-if="activeUpload!.progress < 100"
                            type="button"
                            class="rounded-lg border border-zinc-700 px-4 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                            @click="cancelUpload"
                        >
                            Cancel
                        </button>
                    </div>
                </div>

                <!-- STATUS: upload done, waiting for probe -->
                <div v-else-if="showUploadDoneWaiting && !showProbeConfig" class="mb-4">
                    <ProgressBar label="Analyzing..." indeterminate />
                </div>

                <!-- STATUS: created / uploading — upload happening server-side
                     (URL ingest) or initiated from another browser tab -->
                <div v-else-if="showUploadRemoteMessage" class="mb-4">
                    <p v-if="ingestEtaDisplay" class="mb-2 text-xs text-zinc-500 text-right">
                        {{ ingestEtaDisplay }}
                    </p>
                    <ProgressBar
                        v-if="remoteIngestProgress !== undefined"
                        :label="remoteIngestLabel"
                        :progress="remoteIngestProgress"
                    />
                    <ProgressBar
                        v-else-if="poller.ingestTotalBytes.value != null"
                        :label="remoteIngestLabel"
                        indeterminate
                    />
                    <ProgressBar
                        v-else
                        label="Uploading..."
                        indeterminate
                        subtitle="Started elsewhere"
                    />
                </div>

                <!-- ============================================================ -->
                <!-- STATUS: uploaded — probe loading spinner                     -->
                <!-- ============================================================ -->
                <div v-else-if="currentStatus === 'uploaded' && probeLoading" class="flex flex-col items-center gap-4 py-16">
                    <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <p class="text-sm text-zinc-400">Fetching probe results...</p>
                </div>

                <!-- ============================================================ -->
                <!-- Encode config form (shown after probe, including during      -->
                <!-- upload when early probe results arrived via moov)             -->
                <!-- ============================================================ -->
                <template v-if="showProbeConfig">
                    <!-- Compact upload progress bar when config form is visible -->
                    <div v-if="showUploadProgress" class="mb-4">
                        <ProgressBar
                            :label="activeUpload!.progress >= 100 ? 'Finalizing upload...' : 'Uploading...'"
                            :progress="activeUpload!.progress"
                            :indeterminate="activeUpload!.progress >= 100"
                        />
                    </div>

                    <!-- Segment editor (trim/cut) -->
                    <SegmentEditor
                        v-if="activePlaybackUrl && probeResult?.format?.duration"
                        v-model="editorSegments"
                        mode="trim"
                        :duration="probeResult.format.duration"
                        :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                        :on-seek="(t) => playerRef?.seek(t)"
                        :on-play-pause="() => playerRef?.togglePlay()"
                        :is-playing="isPreviewPlaying"
                    >
                        <template v-if="previewAudioTracks.length > 1" #playback-start>
                            <label class="text-xs text-zinc-400">Audio:</label>
                            <select
                                v-model.number="selectedAudioTrack"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                            >
                                <option
                                    v-for="track in previewAudioTracks"
                                    :key="track.index"
                                    :value="track.index"
                                >{{ audioTrackLabel(track) }}</option>
                            </select>
                        </template>
                        <template
                            v-if="previewQualityLevels.length > 1 && encodingType !== 'audio'"
                            #playback-end
                        >
                            <label class="text-xs text-zinc-400">Quality:</label>
                            <select
                                :value="selectedQualityId"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                                @change="onQualityChange(($event.target as HTMLSelectElement).value || null)"
                            >
                                <option :value="''">Auto</option>
                                <option
                                    v-for="level in previewQualityLevels"
                                    :key="level.id"
                                    :value="level.id"
                                >
                                    {{ level.height > 0 ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}kbps` }}
                                </option>
                            </select>
                        </template>
                    </SegmentEditor>

                    <EncodeConfigForm
                        ref="configFormRef"
                        :probe-result="probeResult!"
                        :byte-range="byteRangeEnabled"
                        @submit="onEncodeSubmit"
                        @back="onEncodeBack"
                    />
                </template>

                <!-- ============================================================ -->
                <!-- Submitting encoding config spinner                           -->
                <!-- ============================================================ -->
                <div v-else-if="submitting" class="flex flex-col items-center gap-4 py-16">
                    <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <p class="text-sm text-zinc-400">Starting encoding...</p>
                </div>

                <!-- ============================================================ -->
                <!-- ENCODING PROGRESS (queue, encoding, encrypting, s3 upload)   -->
                <!-- ============================================================ -->
                <template v-else-if="showEncoding || isCompleted || currentStatus === 'failed'">

                    <!-- Chapter editor (sidecar). Available throughout encoding and after completion.
                         Uses player-reported duration so trimmed encodes and imported sessions both
                         render with the correct timeline length. -->
                    <SegmentEditor
                        v-if="activePlaybackUrl && chapterTimelineDuration > 0 && currentStatus !== 'failed'"
                        v-model="chapterSegments"
                        mode="chapters"
                        :duration="chapterTimelineDuration"
                        :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                        :on-seek="(t) => playerRef?.seek(t)"
                        :on-play-pause="() => playerRef?.togglePlay()"
                        :is-playing="isPreviewPlaying"
                        :ripple-edit="false"
                        title="Chapters"
                        class="mb-4"
                    >
                        <!-- Audio track selector.
                             During preview the on-demand HLS bakes one audio track in per
                             playlist URL, so we still drive it via the existing URL-based
                             selectedAudioTrack. After encoding completes the final HLS master
                             carries every track natively, so we drive Video.js directly. -->
                        <template
                            v-if="(isCompleted && nativeAudioTracks.length > 1) || (!isCompleted && previewAudioTracks.length > 1)"
                            #playback-start
                        >
                            <label class="text-xs text-zinc-400">Audio:</label>
                            <select
                                v-if="isCompleted"
                                :value="selectedNativeAudioId ?? ''"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                                @change="onNativeAudioChange(($event.target as HTMLSelectElement).value)"
                            >
                                <option
                                    v-for="track in nativeAudioTracks"
                                    :key="track.id"
                                    :value="track.id"
                                >{{ nativeAudioLabel(track) }}</option>
                            </select>
                            <select
                                v-else
                                v-model.number="selectedAudioTrack"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                            >
                                <option
                                    v-for="track in previewAudioTracks"
                                    :key="track.index"
                                    :value="track.index"
                                >{{ audioTrackLabel(track) }}</option>
                            </select>
                        </template>

                        <!-- Video quality selector (drives VHS qualityLevel.enabled directly). -->
                        <template
                            v-if="previewQualityLevels.length > 1 && encodingType !== 'audio'"
                            #playback-end
                        >
                            <label class="text-xs text-zinc-400">Quality:</label>
                            <select
                                :value="selectedQualityId ?? ''"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                                @change="onQualityChange(($event.target as HTMLSelectElement).value || null)"
                            >
                                <option :value="''">Auto</option>
                                <option
                                    v-for="level in previewQualityLevels"
                                    :key="level.id"
                                    :value="level.id"
                                >
                                    {{ level.height > 0 ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}kbps` }}
                                </option>
                            </select>
                        </template>

                        <template #toolbar-end>
                            <span
                                v-if="chapters.isDirty.value"
                                class="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                                title="Unsaved changes are stored locally; click Save to commit to S3."
                            >Unsaved</span>
                            <button
                                v-if="chapters.isDirty.value"
                                type="button"
                                class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="chapters.isSaving.value"
                                @click="onDiscardChapters"
                            >Discard</button>
                            <button
                                type="button"
                                class="rounded border border-indigo-600 bg-indigo-600/30 px-3 py-1 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-600/50 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="!chapters.isDirty.value || chapters.isSaving.value"
                                @click="onSaveChapters"
                            >{{ chapters.isSaving.value ? 'Saving…' : 'Save' }}</button>
                        </template>
                    </SegmentEditor>

                    <p v-if="chaptersSaveError" class="mb-3 text-xs text-red-400">{{ chaptersSaveError }}</p>

                    <!-- Queue position -->
                    <div v-if="poller.status.value === 'queued' && poller.queuePosition.value != null" class="mb-4 rounded-lg bg-zinc-900/60 p-4">
                        <p class="text-sm text-zinc-400">
                            Queue position: <span class="font-semibold text-amber-400">{{ poller.queuePosition.value }}</span>
                        </p>
                    </div>

                    <!-- Pipeline progress bars (encoding + encrypting + uploading) -->
                    <div
                        v-if="poller.status.value === 'encoding' || poller.status.value === 'encrypting' || poller.status.value === 'uploading_to_s3'"
                        class="mb-4 space-y-3"
                    >
                        <!-- ETA (based on encoding progress) -->
                        <p v-if="etaDisplay" class="text-xs text-zinc-500 text-right">
                            {{ etaDisplay }}
                        </p>
                        <!-- Encoding progress -->
                        <ProgressBar
                            label="Encoding"
                            :progress="poller.pipelineProgress.value?.encoding ?? poller.progress.value"
                        />
                        <!-- Encrypting progress (appears when encryption starts) -->
                        <ProgressBar
                            v-if="poller.pipelineProgress.value?.encrypting != null"
                            label="Encrypting"
                            :progress="poller.pipelineProgress.value.encrypting"
                        />
                        <!-- Uploading progress (appears when uploads start) -->
                        <ProgressBar
                            v-if="poller.pipelineProgress.value?.uploading != null"
                            label="Uploading to S3"
                            :progress="poller.pipelineProgress.value.uploading"
                        />
                    </div>

                    <!-- Failed banner -->
                    <div v-if="currentStatus === 'failed'" class="mb-4 rounded-lg bg-red-950/40 border border-red-800/50 p-4">
                        <p class="text-sm font-medium text-red-400">Encoding failed</p>
                        <p
                            v-if="poller.error.value || session.error"
                            class="mt-1 text-sm text-red-300/80"
                        >
                            {{ poller.error.value || session.error }}
                        </p>
                    </div>

                    <!-- Player, files, encryption key (shown when completed) -->
                    <div v-if="isCompleted" class="space-y-3">
                        <!-- Angle switcher -->
                        <div v-if="showAngleSwitcher" class="flex flex-wrap items-center gap-2">
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

                        <!-- Video player is now unified at the top of the page -->

                        <!-- Master Playlist URL + Copy -->
                        <div v-if="displayMasterPlaylist" class="rounded-lg bg-zinc-900/60 p-4">
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
                                    {{ copied ? 'Copied!' : 'Copy URL' }}
                                </button>
                            </div>
                            <p class="break-all font-mono text-sm text-indigo-400">{{ s3Url ?? displayMasterPlaylist }}</p>
                        </div>

                        <!-- Encryption key display -->
                        <div v-if="isEncrypted && encryptionKeyHex" class="rounded-lg bg-zinc-900/60 p-4">
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
                                    {{ copiedKey ? 'Copied!' : 'Copy Key' }}
                                </button>
                            </div>
                            <code class="block break-all rounded bg-zinc-800 px-3 py-2 font-mono text-xs text-amber-400">{{ encryptionKeyHex }}</code>
                        </div>

                        <!-- Output files -->
                        <div v-if="displayFiles?.length" class="rounded-lg bg-zinc-900/60 p-4">
                            <template v-if="shouldCollapseFiles">
                                <button
                                    type="button"
                                    class="flex w-full items-center justify-between cursor-pointer"
                                    @click="showFiles = !showFiles"
                                >
                                    <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                        Output Files ({{ displayFiles.length }})
                                    </p>
                                    <svg
                                        class="h-4 w-4 text-zinc-500 transition-transform"
                                        :class="{ 'rotate-180': showFiles }"
                                        fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                                    >
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                                    </svg>
                                </button>
                                <ul v-if="showFiles" class="mt-3 max-h-60 space-y-1 overflow-y-auto">
                                    <li v-for="f in displayFiles" :key="f" class="break-all font-mono text-xs text-zinc-400">{{ f }}</li>
                                </ul>
                            </template>
                            <template v-else>
                                <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Output Files</p>
                                <ul class="max-h-60 space-y-1 overflow-y-auto">
                                    <li v-for="f in displayFiles" :key="f" class="break-all font-mono text-xs text-zinc-400">{{ f }}</li>
                                </ul>
                            </template>
                        </div>
                    </div>

                    <!-- Metadata grid -->
                    <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                        <div class="rounded-lg bg-zinc-900/60 p-3">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Created</p>
                            <p class="text-sm text-zinc-200">{{ formatDate(session.createdAt) }}</p>
                        </div>
                        <div v-if="session.completedAt" class="rounded-lg bg-zinc-900/60 p-3">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Completed</p>
                            <p class="text-sm text-zinc-200">{{ formatDate(session.completedAt) }}</p>
                        </div>
                    </div>

                    <!-- Move / Rename forms -->
                    <div v-if="showMoveForm && isCompleted && hasS3Files" class="mt-4 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4 space-y-3">
                        <p class="text-sm font-semibold text-zinc-300">Move Files to Another S3 Config</p>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Target S3 Config</label>
                            <select
                                v-model="selectedTargetConfigId"
                                class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
                                @change="checkMovePrefix"
                            >
                                <option value="" disabled>Select a config...</option>
                                <option v-for="c in s3Configs" :key="c.id" :value="c.id">
                                    {{ c.name }} ({{ c.bucket }})
                                </option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Path Prefix</label>
                            <input
                                v-model="moveNewPrefix"
                                type="text"
                                placeholder="e.g. videos/project-1/"
                                class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
                                @blur="checkMovePrefix"
                            />
                        </div>
                        <div v-if="movePrefixWarning" class="rounded-md bg-amber-950/40 border border-amber-800/50 p-3">
                            <p class="text-xs text-amber-400">{{ movePrefixWarning }}</p>
                            <label class="mt-2 flex items-center gap-2 text-xs text-amber-300 cursor-pointer">
                                <input v-model="moveConfirmedOverwrite" type="checkbox" class="rounded border-amber-700" />
                                I understand, proceed anyway
                            </label>
                        </div>
                        <p v-if="moveError" class="text-xs text-red-400">{{ moveError }}</p>
                        <div class="flex gap-2">
                            <button
                                type="button"
                                :disabled="!canMove"
                                class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 cursor-pointer"
                                @click="confirmMove"
                            >
                                <template v-if="moving">Moving...</template>
                                <template v-else>Move</template>
                            </button>
                            <button
                                type="button"
                                :disabled="moving"
                                class="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 cursor-pointer"
                                @click="showMoveForm = false"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>

                    <div v-if="showRenameForm && isCompleted && hasS3Files" class="mt-4 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4 space-y-3">
                        <p class="text-sm font-semibold text-zinc-300">Rename Path Prefix</p>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">New Path Prefix</label>
                            <input
                                v-model="renameNewPrefix"
                                type="text"
                                placeholder="e.g. production/client-x/"
                                class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
                                @blur="checkRenamePrefix"
                            />
                        </div>
                        <div v-if="renamePrefixWarning" class="rounded-md bg-amber-950/40 border border-amber-800/50 p-3">
                            <p class="text-xs text-amber-400">{{ renamePrefixWarning }}</p>
                            <label class="mt-2 flex items-center gap-2 text-xs text-amber-300 cursor-pointer">
                                <input v-model="renameConfirmedOverwrite" type="checkbox" class="rounded border-amber-700" />
                                I understand, proceed anyway
                            </label>
                        </div>
                        <p v-if="renameError" class="text-xs text-red-400">{{ renameError }}</p>
                        <div class="flex gap-2">
                            <button
                                type="button"
                                :disabled="!canRename"
                                class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 cursor-pointer"
                                @click="confirmRename"
                            >
                                <template v-if="renaming">Renaming...</template>
                                <template v-else>Rename</template>
                            </button>
                            <button
                                type="button"
                                :disabled="renaming"
                                class="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 cursor-pointer"
                                @click="showRenameForm = false"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>

                    <!-- Action buttons -->
                    <div class="mt-4 flex flex-wrap gap-3">
                        <button
                            v-if="showEncoding && (poller.status.value === 'queued' || poller.status.value === 'encoding')"
                            type="button"
                            class="flex-1 rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                            @click="onCancelEncode"
                        >
                            Cancel
                        </button>
                        <button
                            v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                            type="button"
                            class="rounded-lg border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                            @click="openMoveForm"
                        >
                            Move Files
                        </button>
                        <button
                            v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                            type="button"
                            class="rounded-lg border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                            @click="openRenameForm"
                        >
                            Rename Prefix
                        </button>
                        <button
                            v-if="isTerminal"
                            type="button"
                            class="flex-1 rounded-lg bg-zinc-800 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer"
                            @click="router.push('/sessions/new')"
                        >
                            New Session
                        </button>
                        <InlineConfirm
                            v-if="isTerminal"
                            label="Delete"
                            prompt="Delete session?"
                            :secondary-prompt="hasS3Files ? 'Also delete S3 files?' : undefined"
                            secondary-confirm-label="Yes, delete files"
                            secondary-decline-label="No, keep files"
                            :loading="deleting"
                            size="md"
                            @confirm="onConfirmDelete"
                        />
                    </div>
                </template>

                <!-- ============================================================ -->
                <!-- Expired / no session token for non-terminal status           -->
                <!-- ============================================================ -->
                <div v-else-if="isExpired" class="flex flex-col items-center gap-4 py-16">
                    <svg class="h-10 w-10 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="text-sm text-zinc-400">Session expired</p>
                    <p class="text-xs text-zinc-500">The encoding session is no longer active and cannot be interacted with.</p>

                    <!-- Metadata grid for expired sessions -->
                    <div class="mt-4 w-full grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div class="rounded-lg bg-zinc-900/60 p-3">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</p>
                            <p class="text-sm text-zinc-200">{{ statusConfig[session.status]?.label ?? session.status }}</p>
                        </div>
                        <div v-if="session.s3Config?.endPoint" class="rounded-lg bg-zinc-900/60 p-3">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">S3 Endpoint</p>
                            <p class="font-mono text-xs text-zinc-200 break-all">
                                {{ session.s3Config.endPoint }}{{ session.s3Config.port ? `:${session.s3Config.port}` : '' }}
                            </p>
                        </div>
                        <div class="rounded-lg bg-zinc-900/60 p-3">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Created</p>
                            <p class="text-sm text-zinc-200">{{ formatDate(session.createdAt) }}</p>
                        </div>
                    </div>

                    <button
                        type="button"
                        class="mt-4 rounded-lg bg-zinc-800 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 cursor-pointer"
                        @click="router.push('/sessions/new')"
                    >
                        New Session
                    </button>
                </div>

            </template>
        </div>
    </div>
</template>
