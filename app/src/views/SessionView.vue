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
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import SessionWorkflowStepper from '../components/SessionWorkflowStepper.vue';
import FormSelect from '../components/FormSelect.vue';
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
    editorSegments.value.map((s: Segment) => ({ inSec: s.inSec, outSec: s.outSec })),
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

/** Duration for the beside-player chapters panel (player > in-memory probe > session doc probe). */
const chaptersSidePanelDuration = computed(() => {
    const pd = playerDuration.value;
    if (pd != null && pd > 0) return pd;
    const pr = probeResult.value?.format?.duration;
    if (typeof pr === 'number' && pr > 0) return pr;
    const sp = (session.value?.probeResult as ProbeResult | undefined)?.format?.duration;
    if (typeof sp === 'number' && sp > 0) return sp;
    return 0;
});

/** Chapters list + editor beside the video whenever we have a playback URL (any workflow tab). */
const showChaptersSidePanel = computed(
    () =>
        !!session.value
        && !isExpired.value
        && !!activePlaybackUrl.value
        && currentStatus.value !== 'failed'
        && chaptersSidePanelDuration.value > 0,
);

/** Probe video FPS for SegmentEditor comma/period frame steps (same source as EncodeConfigForm). */
const segmentEditorProbeFps = computed(() => {
    const v = probeResult.value?.videoTracks?.[0];
    const f = v?.frameRate;
    if (typeof f !== 'number' || f <= 0 || f > 120) return 0;
    return Math.round(f);
});

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
    created: { label: 'Created', color: 'text-zinc-700 dark:text-zinc-400', borderColor: 'border-zinc-300 dark:border-zinc-700' },
    uploading: { label: 'Uploading', color: 'text-cyan-700 dark:text-cyan-400', borderColor: 'border-cyan-300 dark:border-cyan-700/60' },
    uploaded: { label: 'Uploaded', color: 'text-zinc-700 dark:text-zinc-400', borderColor: 'border-zinc-300 dark:border-zinc-700' },
    queued: { label: 'Queued', color: 'text-amber-700 dark:text-amber-400', borderColor: 'border-amber-300 dark:border-amber-700/60' },
    encoding: { label: 'Encoding', color: 'text-indigo-700 dark:text-indigo-400', borderColor: 'border-indigo-300 dark:border-indigo-700/60' },
    encrypting: { label: 'Encrypting', color: 'text-amber-700 dark:text-amber-400', borderColor: 'border-amber-300 dark:border-amber-700/60' },
    uploading_to_s3: { label: 'Uploading to S3', color: 'text-cyan-700 dark:text-cyan-400', borderColor: 'border-cyan-300 dark:border-cyan-700/60' },
    completed: { label: 'Completed', color: 'text-emerald-700 dark:text-emerald-400', borderColor: 'border-emerald-300 dark:border-emerald-700/60' },
    failed: { label: 'Failed', color: 'text-red-700 dark:text-red-400', borderColor: 'border-red-300 dark:border-red-700/60' },
    imported: { label: 'Imported', color: 'text-violet-700 dark:text-violet-400', borderColor: 'border-violet-300 dark:border-violet-700/60' },
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

const previewAudioSelectOptions = computed(() =>
    previewAudioTracks.value.map((t) => ({
        value: t.index,
        label: audioTrackLabel(t),
    })),
);

const previewQualitySelectOptions = computed(() => [
    { value: '', label: 'Auto' },
    ...previewQualityLevels.value.map((level) => ({
        value: level.id,
        label:
            level.height > 0
                ? `${level.height}p`
                : `${Math.round(level.bitrate / 1000)}kbps`,
    })),
]);

const nativeAudioSelectOptions = computed(() =>
    nativeAudioTracks.value.map((t) => ({
        value: t.id,
        label: nativeAudioLabel(t),
    })),
);

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

function seekPlayerTime(t: number) {
    playerRef.value?.seek(t);
}

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

const deleteModalOpen = ref(false);

const deleteModalLabel = computed(() => {
    const n = sessionName.value?.trim();
    if (n) return n;
    const id = sessionId.value;
    if (!id) return '';
    return id.length > 16 ? `${id.slice(0, 12)}…` : id;
});

async function onConfirmDelete(withFiles: boolean) {
    deleting.value = true;
    try {
        const token = await getAccessTokenSilently();
        await deleteSession(sessionId.value, token, withFiles);
        deleteModalOpen.value = false;
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

const moveTargetS3SelectOptions = computed(() =>
    s3Configs.value.map((c: any) => ({
        value: c.id,
        label: `${c.name} (${c.bucket})`,
    }))
);

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

// Load chapters from localStorage / S3 whenever this session has preview playback (any status).
watch(
    () => sessionId.value,
    (id, prev) => {
        if (id !== prev && prev != null) {
            chapters.unload();
            chaptersSaveError.value = null;
        }
    },
);

watch(
    [() => sessionId.value, activePlaybackUrl, isExpired],
    async ([id, url, expired]) => {
        if (!id || !url || expired) return;
        if (chapters.isLoaded.value) return;
        try {
            chaptersSaveError.value = null;
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
        syncChaptersFromTrim();
    } catch (err) {
        chaptersSaveError.value = err instanceof Error ? err.message : String(err);
    }
}

/** While configuring trim before encode, chapter list mirrors trim ranges (labels preserved by row index). */
const hadTrimForChapterSync = ref(false);

function segmentTimesAlmostEqual(a: Segment, b: Segment): boolean {
    return Math.abs(a.inSec - b.inSec) < 1e-4 && Math.abs(a.outSec - b.outSec) < 1e-4;
}

function sameTrimAsChapterBoundaries(trim: Segment[], ch: Segment[]): boolean {
    if (trim.length !== ch.length) return false;
    return trim.every((t, i) => segmentTimesAlmostEqual(t, ch[i]!));
}

function syncChaptersFromTrim() {
    if (!showProbeConfig.value || !chapters.isLoaded.value) return;

    const trim = editorSegments.value;
    if (trim.length === 0) {
        if (hadTrimForChapterSync.value) {
            chapterSegments.value = [];
            hadTrimForChapterSync.value = false;
        }
        return;
    }

    hadTrimForChapterSync.value = true;
    const prev = chapterSegments.value;
    const next: Segment[] = trim.map((t: Segment, i: number) => ({
        ...t,
        label: i < prev.length ? (prev[i]!.label ?? '') : '',
    }));

    if (
        sameTrimAsChapterBoundaries(trim, prev)
        && next.every((s, i) => (s.label ?? '') === (prev[i]?.label ?? ''))
    ) {
        return;
    }

    chapterSegments.value = next;
}

watch(editorSegments, () => {
    syncChaptersFromTrim();
}, { deep: true });

watch(
    () => chapters.isLoaded.value,
    (loaded) => {
        if (loaded) syncChaptersFromTrim();
    },
);

watch(showProbeConfig, (probe) => {
    if (!probe) hadTrimForChapterSync.value = false;
});

// ---------------------------------------------------------------------------
// Session workspace — tabs, stepper, activity log
// ---------------------------------------------------------------------------

type SessionTabId = 'workflow' | 'output' | 'trim' | 'post';

const activeTab = ref<SessionTabId>('workflow');

const effectiveProbe = computed<ProbeResult | null>(() => {
    const raw = probeResult.value ?? session.value?.probeResult;
    return (raw as ProbeResult | null) ?? null;
});

const sessionLogLines = ref<string[]>([]);
const MAX_SESSION_LOG = 80;

function pushSessionLog(message: string) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = `[${t}] ${message}`;
    sessionLogLines.value = [...sessionLogLines.value.slice(-(MAX_SESSION_LOG - 1)), line];
}

function clearSessionLogs() {
    sessionLogLines.value = [];
}

function relativeCreatedLabel(dateStr: string | null | undefined): string {
    if (!dateStr) return '';
    const then = new Date(dateStr).getTime();
    const diff = Date.now() - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Created just now';
    if (mins < 60) return `Created ${mins} min${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Created ${hrs} hr${hrs === 1 ? '' : 's'} ago`;
    const days = Math.floor(hrs / 24);
    return `Created ${days} day${days === 1 ? '' : 's'} ago`;
}

const isImportedFlow = computed(() => !!session.value?.imported);

const stepperIngest = computed(() => {
    if (isImportedFlow.value) return 'done' as const;
    const s = currentStatus.value;
    if (!s) return 'pending' as const;
    if (s === 'created' || s === 'uploading') return 'active' as const;
    return 'done' as const;
});

const stepperProbe = computed(() => {
    if (isImportedFlow.value) return 'done' as const;
    const s = currentStatus.value;
    if (!s || s === 'created' || s === 'uploading') return 'pending' as const;
    if (s === 'uploaded') {
        if (probeLoading.value) return 'active' as const;
        if (effectiveProbe.value) return 'done' as const;
        return 'active' as const;
    }
    return 'done' as const;
});

const stepperEncoding = computed(() => {
    if (isImportedFlow.value) return 'done' as const;
    const s = currentStatus.value;
    if (s === 'failed') return 'error' as const;
    if (s === 'queued' || s === 'encoding' || s === 'encrypting') return 'active' as const;
    if (s === 'uploading_to_s3' || s === 'completed') return 'done' as const;
    return 'pending' as const;
});

const stepperUpload = computed(() => {
    if (isImportedFlow.value) return 'done' as const;
    const s = currentStatus.value;
    if (s === 'failed') return 'pending' as const;
    if (s === 'uploading_to_s3') return 'active' as const;
    if (s === 'completed') return 'done' as const;
    return 'pending' as const;
});

const stepperFinalize = computed(() => {
    if (isImportedFlow.value) return 'done' as const;
    const s = currentStatus.value;
    if (s === 'completed') return 'done' as const;
    if (s === 'failed') return 'error' as const;
    return 'pending' as const;
});

function inferOutputFileKind(key: string): string {
    const lower = key.toLowerCase();
    if (lower.endsWith('.m3u8')) return 'HLS playlist';
    if (lower.endsWith('.ts')) return 'MPEG-TS';
    if (lower.endsWith('.m4s')) return 'fMP4 media';
    if (lower.endsWith('.mp4')) return 'MP4';
    if (lower.endsWith('.vtt')) return 'WebVTT';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) return 'Image';
    return 'Object';
}

async function copyOutputObjectKey(key: string) {
    const base = s3PublicBaseUrl.value;
    const text = base ? `${base}/${key}` : key;
    await navigator.clipboard.writeText(text);
}

watch(currentStatus, (s, prev) => {
    if (s && s !== prev) pushSessionLog(`Status: ${s}`);
});

watch(
    () => poller.error.value,
    (err) => {
        if (err) pushSessionLog(`Error: ${err}`);
    },
);

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
    <div class="app-view w-full max-w-none">
        <div class="mx-auto w-full max-w-7xl px-4 transition-all duration-300 sm:px-6">
        <div class="mb-6">
            <router-link
                to="/sessions"
                class="inline-flex items-center gap-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                Back to sessions
            </router-link>
        </div>

        <div v-if="loading" class="flex justify-center rounded-2xl border border-zinc-200/90 bg-white/90 py-16 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10">
            <svg class="h-8 w-8 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <div v-else-if="error" class="rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-950/30">
            <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
        </div>

        <template v-else-if="session">
            <!-- Page header -->
            <header class="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="min-w-0 flex-1">
                    <div v-if="editingName" class="flex flex-wrap items-center gap-2">
                        <input
                            v-model="nameInput"
                            type="text"
                            class="input min-w-0 flex-1 text-lg font-semibold"
                            placeholder="Session name"
                            @keyup.enter="saveName"
                            @keyup.escape="cancelEditName"
                        />
                        <StatusBadge
                            class="shrink-0"
                            :label="currentStatus ? statusConfig[currentStatus]?.label ?? currentStatus : '--'"
                            :color="statusConfig[currentStatus ?? '']?.color ?? 'text-zinc-700 dark:text-zinc-400'"
                            :border-color="statusConfig[currentStatus ?? '']?.borderColor ?? 'border-zinc-300 dark:border-zinc-700'"
                        />
                        <button
                            type="button"
                            :disabled="savingName"
                            @click="saveName"
                            class="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            {{ savingName ? '…' : 'Save' }}
                        </button>
                        <button
                            type="button"
                            @click="cancelEditName"
                            class="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            Cancel
                        </button>
                    </div>
                    <div
                        v-else
                        class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
                    >
                        <h1
                            class="min-w-0 cursor-pointer text-2xl font-semibold tracking-tight text-zinc-900 transition-colors hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                            @click="startEditName"
                            :title="sessionName ? 'Click to rename' : 'Click to add a name'"
                        >
                            {{ sessionName || 'Untitled session' }}
                        </h1>
                        <StatusBadge
                            class="shrink-0"
                            :label="currentStatus ? statusConfig[currentStatus]?.label ?? currentStatus : '--'"
                            :color="statusConfig[currentStatus ?? '']?.color ?? 'text-zinc-700 dark:text-zinc-400'"
                            :border-color="statusConfig[currentStatus ?? '']?.borderColor ?? 'border-zinc-300 dark:border-zinc-700'"
                        />
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                        <p class="font-mono text-xs text-zinc-500 dark:text-zinc-400">{{ sessionId }}</p>
                        <span v-if="session.createdAt" class="text-xs text-zinc-500 dark:text-zinc-500">·</span>
                        <p v-if="session.createdAt" class="text-xs text-zinc-500 dark:text-zinc-400">{{ relativeCreatedLabel(session.createdAt) }}</p>
                    </div>
                    <div
                        v-if="
                            (displayEncoder && encoderConfig[displayEncoder])
                            || displaySegmentFormat === 'mpegts'
                            || isEncrypted
                            || session.imported
                        "
                        class="mt-3 flex flex-wrap items-center gap-2"
                    >
                        <StatusBadge
                            v-if="displayEncoder && encoderConfig[displayEncoder]"
                            :label="encoderConfig[displayEncoder].label"
                            :icon="encoderConfig[displayEncoder].icon"
                            :color="displayEncoder === 'cpu' ? 'text-zinc-700 dark:text-zinc-400' : 'text-violet-700 dark:text-violet-400'"
                            :border-color="displayEncoder === 'cpu' ? 'border-zinc-300 dark:border-zinc-700' : 'border-violet-300 dark:border-violet-700/60'"
                        />
                        <StatusBadge
                            v-if="displaySegmentFormat === 'mpegts'"
                            label="MPEG-TS"
                            color="text-amber-700 dark:text-amber-400"
                            border-color="border-amber-300 dark:border-amber-700/60"
                            :icon="ICON_PATHS.warning"
                            title="MPEG-TS segments used because source streams have misaligned start times."
                        />
                        <StatusBadge
                            v-if="isEncrypted"
                            label="Encrypted"
                            color="text-amber-700 dark:text-amber-400"
                            border-color="border-amber-300 dark:border-amber-700/60"
                            :icon="ICON_PATHS.lock"
                        />
                        <StatusBadge
                            v-if="session.imported"
                            label="Imported"
                            color="text-violet-700 dark:text-violet-400"
                            border-color="border-violet-300 dark:border-violet-700/60"
                        />
                    </div>
                </div>
                <div class="flex shrink-0 flex-wrap items-center gap-2">
                    <router-link
                        to="/sessions/new"
                        class="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
                    >
                        New session
                    </router-link>
                    <details class="relative">
                        <summary
                            class="flex cursor-pointer list-none items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden"
                        >
                            <span class="sr-only">More actions</span>
                            <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 8a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
                            </svg>
                        </summary>
                        <div
                            class="absolute right-0 z-20 mt-2 min-w-[12rem] overflow-hidden rounded-xl border border-zinc-200/90 bg-white py-1 text-sm shadow-xl ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-white/10"
                        >
                            <button
                                v-if="showEncoding && (poller.status.value === 'queued' || poller.status.value === 'encoding' || poller.status.value === 'encrypting')"
                                type="button"
                                class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                @click="onCancelEncode"
                            >
                                Cancel encoding
                            </button>
                            <button
                                v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                                type="button"
                                class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                @click="() => { void openMoveForm(); activeTab = 'post'; }"
                            >
                                Move files…
                            </button>
                            <button
                                v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                                type="button"
                                class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                @click="() => { openRenameForm(); activeTab = 'post'; }"
                            >
                                Rename prefix…
                            </button>
                            <button
                                v-if="isTerminal"
                                type="button"
                                class="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                                @click="deleteModalOpen = true"
                            >
                                Delete session…
                            </button>
                        </div>
                    </details>
                </div>
            </header>

            <!-- Expired -->
            <div
                v-if="isExpired"
                class="rounded-2xl border border-zinc-200/90 bg-white/90 p-8 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10"
            >
                <div class="flex flex-col items-center gap-4 py-8">
                    <svg class="h-10 w-10 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="text-sm text-zinc-700 dark:text-zinc-300">Session expired</p>
                    <p class="max-w-md text-center text-xs text-zinc-500">The encoding session is no longer active and cannot be interacted with.</p>
                    <div class="mt-2 grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
                        <div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Status</p>
                            <p class="text-sm text-zinc-800 dark:text-zinc-200">{{ statusConfig[session.status]?.label ?? session.status }}</p>
                        </div>
                        <div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Created</p>
                            <p class="text-sm text-zinc-800 dark:text-zinc-200">{{ formatDate(session.createdAt) }}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        class="mt-2 rounded-xl border border-zinc-300 bg-zinc-100 px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-200 dark:border-transparent dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        @click="router.push('/sessions/new')"
                    >
                        New session
                    </button>
                </div>
            </div>

            <!-- Main column -->
            <div v-else class="min-w-0 space-y-5">
                    <div
                        class="rounded-2xl border border-zinc-200/90 bg-white/90 p-4 shadow-lg shadow-zinc-900/5 ring-1 ring-zinc-900/5 backdrop-blur sm:p-6 dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10"
                    >
                        <div
                            v-if="activePlaybackUrl"
                            class="flex flex-col gap-4"
                            :class="showChaptersSidePanel ? 'lg:flex-row lg:items-stretch lg:gap-4' : ''"
                        >
                            <div :class="showChaptersSidePanel ? 'min-w-0 flex-1' : 'w-full'">
                                <div class="overflow-hidden rounded-xl bg-black shadow-lg shadow-black/20 ring-1 ring-black/10 dark:ring-white/5">
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
                            </div>
                            <aside
                                v-if="showChaptersSidePanel"
                                class="w-full shrink-0 lg:w-[min(26rem,38vw)] lg:max-w-md"
                            >
                                <div
                                    class="max-h-[min(85vh,56rem)] overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200/90 bg-white/95 p-3 shadow-sm ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900/80 dark:ring-white/10 sm:p-4"
                                >
                                    <SegmentEditor
                                        v-model="chapterSegments"
                                        mode="chapters"
                                        :duration="chaptersSidePanelDuration"
                                        :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                                        :on-seek="(t: number) => playerRef?.seek(t)"
                                        :on-play-pause="() => playerRef?.togglePlay()"
                                        :is-playing="isPreviewPlaying"
                                        :ripple-edit="false"
                                        :show-timeline="false"
                                        :show-toolbar="false"
                                        :show-playback-controls="false"
                                        :show-help="false"
                                        title="Chapters"
                                        keyboard-scope="global"
                                        :fps="segmentEditorProbeFps"
                                    />
                                </div>
                                <p
                                    v-if="chaptersSaveError && activeTab !== 'trim'"
                                    class="mt-2 text-xs text-red-600 dark:text-red-400"
                                >{{ chaptersSaveError }}</p>
                            </aside>
                        </div>

                        <p
                            v-if="chaptersSaveError && !showChaptersSidePanel"
                            class="mt-2 text-xs text-red-600 dark:text-red-400"
                        >{{ chaptersSaveError }}</p>

                        <div v-if="isCompleted && showAngleSwitcher" class="mt-4 flex flex-wrap items-center gap-2">
                            <span class="text-xs font-medium text-zinc-500 dark:text-zinc-400">Angle</span>
                            <div class="flex flex-wrap gap-1.5">
                                <button
                                    v-for="(ap, i) in uniqueAnglePlaylists"
                                    :key="ap.key"
                                    type="button"
                                    class="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                                    :class="i === currentAngleIndex
                                        ? 'bg-indigo-600 text-white dark:bg-indigo-600 dark:text-white'
                                        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'"
                                    @click="switchToAngle(i)"
                                >
                                    {{ ap.name }}
                                </button>
                            </div>
                        </div>

                        <div
                            v-if="submissionError"
                            class="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-950/40"
                        >
                            <p class="text-sm text-red-800 dark:text-red-300">{{ submissionError }}</p>
                        </div>

                        <!-- Tabs -->
                        <div class="mt-6">
                            <div class="flex gap-1 overflow-x-auto rounded-xl border border-zinc-200/90 bg-zinc-100/80 p-1 dark:border-zinc-700 dark:bg-zinc-900/50">
                                <button
                                    v-for="tab in [
                                        { id: 'workflow' as const, label: 'Encode workflow' },
                                        { id: 'output' as const, label: 'Output configuration' },
                                        { id: 'trim' as const, label: 'Trim & chapters' },
                                        { id: 'post' as const, label: 'Post-process' },
                                    ]"
                                    :key="tab.id"
                                    type="button"
                                    class="whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition-colors sm:text-sm"
                                    :class="activeTab === tab.id
                                        ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                                        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'"
                                    @click="activeTab = tab.id"
                                >
                                    {{ tab.label }}
                                </button>
                            </div>

                            <!-- Encode workflow -->
                            <div v-show="activeTab === 'workflow'" class="mt-5 space-y-5">
                                <SessionWorkflowStepper
                                    :ingest="stepperIngest"
                                    :probe="stepperProbe"
                                    :encoding="stepperEncoding"
                                    :upload="stepperUpload"
                                    :finalize="stepperFinalize"
                                />

                                <template v-if="!showProbeConfig && !submitting && !(showEncoding || isCompleted || currentStatus === 'failed')">
                                    <div v-if="showUploadProgress">
                                        <ProgressBar
                                            :label="activeUpload!.progress >= 100 ? 'Finalizing upload…' : 'Uploading…'"
                                            :progress="activeUpload!.progress"
                                            :indeterminate="activeUpload!.progress >= 100"
                                        />
                                        <div class="flex justify-end pt-2">
                                            <button
                                                v-if="activeUpload!.progress < 100"
                                                type="button"
                                                class="cursor-pointer rounded-lg border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                                @click="cancelUpload"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                    <div v-else-if="showUploadDoneWaiting">
                                        <ProgressBar label="Analyzing…" indeterminate />
                                    </div>
                                    <div v-else-if="showUploadRemoteMessage">
                                        <p v-if="ingestEtaDisplay" class="mb-2 text-right text-xs text-zinc-500">{{ ingestEtaDisplay }}</p>
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
                                        <ProgressBar v-else label="Uploading…" indeterminate subtitle="Started elsewhere" />
                                    </div>
                                    <div v-else-if="currentStatus === 'uploaded' && probeLoading" class="flex flex-col items-center gap-3 py-10">
                                        <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        <p class="text-sm text-zinc-500">Fetching probe results…</p>
                                    </div>
                                </template>

                                <template v-if="showProbeConfig">
                                    <div v-if="showUploadProgress">
                                        <ProgressBar
                                            :label="activeUpload!.progress >= 100 ? 'Finalizing upload…' : 'Uploading…'"
                                            :progress="activeUpload!.progress"
                                            :indeterminate="activeUpload!.progress >= 100"
                                        />
                                    </div>
                                    <div class="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400">
                                        <p class="font-medium text-zinc-900 dark:text-zinc-200">Ready to configure</p>
                                        <p class="mt-1 text-xs leading-relaxed">
                                            Set the HLS ladder in
                                            <button type="button" class="font-semibold text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400" @click="activeTab = 'output'">Output configuration</button>
                                            and optional cuts in
                                            <button type="button" class="font-semibold text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400" @click="activeTab = 'trim'">Trim & chapters</button>.
                                        </p>
                                    </div>
                                </template>

                                <div v-if="submitting" class="flex flex-col items-center gap-3 py-12">
                                    <svg class="h-8 w-8 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    <p class="text-sm text-zinc-500">Starting encoding…</p>
                                </div>

                                <template v-if="(showEncoding || isCompleted || currentStatus === 'failed') && !submitting">
                                    <div
                                        v-if="currentStatus === 'failed'"
                                        class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-950/40"
                                    >
                                        <p class="text-sm font-medium text-red-900 dark:text-red-400">Encoding failed</p>
                                        <p v-if="poller.error.value || session.error" class="mt-1 text-sm text-red-700 dark:text-red-300">
                                            {{ poller.error.value || session.error }}
                                        </p>
                                    </div>

                                    <div
                                        v-else
                                        class="rounded-2xl border border-zinc-200/90 bg-white/95 p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/50"
                                    >
                                        <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
                                            <div>
                                                <h2 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">HLS package</h2>
                                                <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                                    <template v-if="displayEncoder && encoderConfig[displayEncoder]">{{ encoderConfig[displayEncoder].label }}</template>
                                                    <template v-if="displaySegmentFormat"> · {{ displaySegmentFormat === 'fmp4' ? 'fMP4' : 'MPEG-TS' }}</template>
                                                    <template v-if="encodingType === 'audio'"> · Audio-only</template>
                                                </p>
                                            </div>
                                            <div v-if="poller.status.value === 'queued' && poller.queuePosition.value != null" class="text-xs font-medium text-amber-700 dark:text-amber-400">
                                                Queue #{{ poller.queuePosition.value }}
                                            </div>
                                        </div>

                                        <div
                                            v-if="poller.status.value === 'encoding' || poller.status.value === 'encrypting' || poller.status.value === 'uploading_to_s3'"
                                            class="space-y-3"
                                        >
                                            <p v-if="etaDisplay" class="text-right text-xs text-zinc-500">{{ etaDisplay }}</p>
                                            <ProgressBar
                                                label="Encoding"
                                                :progress="poller.pipelineProgress.value?.encoding ?? poller.progress.value"
                                            />
                                            <ProgressBar
                                                v-if="poller.pipelineProgress.value?.encrypting != null"
                                                label="Encrypting manifest"
                                                :progress="poller.pipelineProgress.value.encrypting"
                                            />
                                            <ProgressBar
                                                v-if="poller.pipelineProgress.value?.uploading != null"
                                                label="S3 parallel upload"
                                                :progress="poller.pipelineProgress.value.uploading"
                                            />
                                        </div>

                                        <div v-if="isCompleted" class="mt-4 rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
                                            Encoding finished. Delivery links and storage tools are on the
                                            <button type="button" class="font-semibold underline-offset-2 hover:underline" @click="activeTab = 'post'">Post-process</button>
                                            tab.
                                        </div>

                                        <div class="mt-4 flex flex-wrap gap-2">
                                            <button
                                                v-if="showEncoding && (poller.status.value === 'queued' || poller.status.value === 'encoding' || poller.status.value === 'encrypting')"
                                                type="button"
                                                class="cursor-pointer rounded-xl border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                                                @click="onCancelEncode"
                                            >
                                                Cancel encoding
                                            </button>
                                        </div>
                                    </div>
                                </template>

                                <div
                                    class="rounded-2xl border border-zinc-200/90 bg-white/90 p-4 shadow-sm ring-1 ring-zinc-900/5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:ring-white/10"
                                >
                                    <div class="mb-2 flex items-center justify-between gap-2">
                                        <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                                            Real-time logs
                                        </h3>
                                        <button
                                            v-if="sessionLogLines.length"
                                            type="button"
                                            class="rounded-md px-2 py-1 text-[10px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                                            @click="clearSessionLogs"
                                        >
                                            Clear
                                        </button>
                                    </div>
                                    <div
                                        class="max-h-48 overflow-y-auto rounded-lg bg-zinc-950 px-2 py-2 font-mono text-[10px] leading-relaxed text-emerald-200/90 ring-1 ring-zinc-800"
                                    >
                                        <p v-for="(line, i) in sessionLogLines" :key="i" class="whitespace-pre-wrap break-all">
                                            {{ line }}
                                        </p>
                                        <p v-if="!sessionLogLines.length" class="text-zinc-500">Waiting for session events…</p>
                                    </div>
                                </div>
                            </div>

                            <!-- Output configuration -->
                            <div v-show="activeTab === 'output'" class="mt-5">
                                <EncodeConfigForm
                                    v-if="showProbeConfig"
                                    ref="configFormRef"
                                    :probe-result="probeResult!"
                                    :byte-range="byteRangeEnabled"
                                    @submit="onEncodeSubmit"
                                    @back="onEncodeBack"
                                />
                                <p v-else class="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                                    Output settings are only editable while the session is probed and waiting to encode. For active jobs, use the Encode workflow tab for progress and logs.
                                </p>
                            </div>

                            <!-- Post-process -->
                            <div v-show="activeTab === 'post'" class="mt-5 space-y-5">
                                <p v-if="!isCompleted && currentStatus !== 'failed'" class="text-sm text-zinc-500 dark:text-zinc-400">
                                    When the package completes, this tab lists output keys, URLs, prefix tools, and delete options.
                                </p>
                                <p v-else-if="currentStatus === 'failed'" class="text-sm text-zinc-500 dark:text-zinc-400">
                                    Encoding did not complete. See the Encode workflow tab for the error detail.
                                </p>

                                <template v-if="isCompleted">
                                    <div v-if="displayMasterPlaylist" class="rounded-xl border border-zinc-200 bg-zinc-50/95 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                                        <div class="mb-2 flex items-center justify-between gap-2">
                                            <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Master playlist</p>
                                            <button
                                                v-if="s3Url"
                                                type="button"
                                                class="cursor-pointer rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium transition-colors"
                                                :class="copied ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15' : 'bg-white text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'"
                                                @click="copyPlaybackUrl"
                                            >
                                                {{ copied ? 'Copied' : 'Copy URL' }}
                                            </button>
                                        </div>
                                        <p class="break-all font-mono text-sm text-indigo-700 dark:text-indigo-400">{{ s3Url ?? displayMasterPlaylist }}</p>
                                    </div>

                                    <div v-if="isEncrypted && encryptionKeyHex" class="rounded-xl border border-zinc-200 bg-zinc-50/95 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                                        <div class="mb-2 flex items-center justify-between gap-2">
                                            <p class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Encryption key</p>
                                            <button
                                                type="button"
                                                class="cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
                                                :class="copiedKey ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40' : 'border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-800'"
                                                @click="copyEncryptionKey"
                                            >
                                                {{ copiedKey ? 'Copied' : 'Copy key' }}
                                            </button>
                                        </div>
                                        <code class="block break-all rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-amber-800 dark:bg-zinc-800 dark:text-amber-400">{{ encryptionKeyHex }}</code>
                                    </div>

                                    <details
                                        v-if="displayFiles?.length"
                                        class="group rounded-xl border border-zinc-200 bg-zinc-50/95 dark:border-zinc-800 dark:bg-zinc-900/60"
                                    >
                                        <summary
                                            class="flex cursor-pointer list-none items-center gap-2 rounded-xl p-4 text-left [&::-webkit-details-marker]:hidden"
                                        >
                                            <svg class="h-4 w-4 shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                            </svg>
                                            <h3 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Generated assets</h3>
                                            <span class="text-xs text-zinc-500 dark:text-zinc-400">({{ displayFiles.length }} {{ displayFiles.length === 1 ? 'file' : 'files' }})</span>
                                            <svg
                                                class="ml-auto h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-180"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                                aria-hidden="true"
                                            >
                                                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                                            </svg>
                                        </summary>
                                        <div class="border-t border-zinc-200 px-4 pb-4 pt-2 dark:border-zinc-700">
                                            <div class="overflow-x-auto">
                                                <table class="w-full min-w-[28rem] text-left text-xs">
                                                    <thead>
                                                        <tr class="border-b border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                                                            <th class="pb-2 pr-2 font-medium">File</th>
                                                            <th class="pb-2 pr-2 font-medium">Type</th>
                                                            <th class="pb-2 pr-2 font-medium">Size</th>
                                                            <th class="pb-2 font-medium text-right">Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        <tr
                                                            v-for="f in (shouldCollapseFiles && !showFiles ? (displayFiles ?? []).slice(0, 12) : (displayFiles ?? []))"
                                                            :key="f"
                                                            class="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                                                        >
                                                            <td class="py-1.5 pr-2 font-mono text-zinc-800 dark:text-zinc-200">{{ f.split('/').pop() || f }}</td>
                                                            <td class="py-1.5 pr-2 text-zinc-600 dark:text-zinc-400">{{ inferOutputFileKind(f) }}</td>
                                                            <td class="py-1.5 pr-2 text-zinc-400">—</td>
                                                            <td class="py-1.5 text-right">
                                                                <button
                                                                    type="button"
                                                                    class="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                                                    title="Copy URL"
                                                                    @click="copyOutputObjectKey(f)"
                                                                >
                                                                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                                                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m0 0V18a2 2 0 01-2 2h-3m3 0l-3-3" />
                                                                    </svg>
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </div>
                                            <button
                                                v-if="shouldCollapseFiles"
                                                type="button"
                                                class="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                                                @click="showFiles = !showFiles"
                                            >
                                                {{ showFiles ? 'Show less' : `Show all ${displayFiles.length} files` }}
                                            </button>
                                        </div>
                                    </details>

                                    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div v-if="session.s3Config?.endPoint" class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">S3 endpoint</p>
                                            <p class="break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">
                                                {{ session.s3Config.endPoint }}{{ session.s3Config.port ? `:${session.s3Config.port}` : '' }}
                                            </p>
                                        </div>
                                        <div v-if="session.s3Config?.bucket" class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Bucket</p>
                                            <p class="text-sm text-zinc-800 dark:text-zinc-200">{{ session.s3Config.bucket }}</p>
                                        </div>
                                        <div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Created</p>
                                            <p class="text-sm text-zinc-800 dark:text-zinc-200">{{ formatDate(session.createdAt) }}</p>
                                        </div>
                                        <div v-if="session.completedAt" class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Completed</p>
                                            <p class="text-sm text-zinc-800 dark:text-zinc-200">{{ formatDate(session.completedAt) }}</p>
                                        </div>
                                    </div>

                                    <div
                                        v-if="showMoveForm && hasS3Files"
                                        class="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3 dark:border-zinc-700 dark:bg-zinc-900/80"
                                    >
                                        <p class="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Move files to another S3 config</p>
                                        <div>
                                            <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Target S3 config</label>
                                            <FormSelect
                                                v-model="selectedTargetConfigId"
                                                :options="moveTargetS3SelectOptions"
                                                placeholder="Select a config…"
                                                @change="checkMovePrefix"
                                            />
                                        </div>
                                        <div>
                                            <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">Path prefix</label>
                                            <input v-model="moveNewPrefix" type="text" placeholder="e.g. videos/project-1/" class="input" @blur="checkMovePrefix" />
                                        </div>
                                        <div v-if="movePrefixWarning" class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-950/40">
                                            <p class="text-xs text-amber-800 dark:text-amber-400">{{ movePrefixWarning }}</p>
                                            <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                                                <input v-model="moveConfirmedOverwrite" type="checkbox" class="rounded accent-amber-600" />
                                                I understand, proceed anyway
                                            </label>
                                        </div>
                                        <p v-if="moveError" class="text-xs text-red-700 dark:text-red-400">{{ moveError }}</p>
                                        <div class="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                :disabled="!canMove"
                                                class="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                                                @click="confirmMove"
                                            >{{ moving ? 'Moving…' : 'Apply move' }}</button>
                                            <button type="button" :disabled="moving" class="cursor-pointer rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-600" @click="showMoveForm = false">Cancel</button>
                                        </div>
                                    </div>

                                    <div
                                        v-if="showRenameForm && hasS3Files"
                                        class="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3 dark:border-zinc-700 dark:bg-zinc-900/80"
                                    >
                                        <p class="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Rename path prefix</p>
                                        <div>
                                            <label class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">New prefix</label>
                                            <input v-model="renameNewPrefix" type="text" placeholder="e.g. production/client-x/" class="input" @blur="checkRenamePrefix" />
                                        </div>
                                        <div v-if="renamePrefixWarning" class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-950/40">
                                            <p class="text-xs text-amber-800 dark:text-amber-400">{{ renamePrefixWarning }}</p>
                                            <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                                                <input v-model="renameConfirmedOverwrite" type="checkbox" class="rounded accent-amber-600" />
                                                I understand, proceed anyway
                                            </label>
                                        </div>
                                        <p v-if="renameError" class="text-xs text-red-700 dark:text-red-400">{{ renameError }}</p>
                                        <div class="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                :disabled="!canRename"
                                                class="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                                                @click="confirmRename"
                                            >{{ renaming ? 'Renaming…' : 'Apply rename' }}</button>
                                            <button type="button" :disabled="renaming" class="cursor-pointer rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-600" @click="showRenameForm = false">Cancel</button>
                                        </div>
                                    </div>

                                    <div class="rounded-2xl border border-red-200/80 bg-red-50/50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
                                        <p class="text-sm font-semibold text-red-900 dark:text-red-300">Danger zone</p>
                                        <p class="mt-1 text-xs text-red-800/90 dark:text-red-400/90">Deleting removes this session from your history. Optionally delete objects from your bucket with the checkbox in the dialog.</p>
                                        <button
                                            type="button"
                                            class="mt-3 cursor-pointer rounded-xl border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
                                            @click="deleteModalOpen = true"
                                        >
                                            Delete session permanently
                                        </button>
                                    </div>

                                    <div class="flex flex-wrap gap-3">
                                        <button
                                            v-if="hasS3Files && !showMoveForm && !showRenameForm"
                                            type="button"
                                            class="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                            @click="openMoveForm"
                                        >
                                            Move files
                                        </button>
                                        <button
                                            v-if="hasS3Files && !showMoveForm && !showRenameForm"
                                            type="button"
                                            class="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                            @click="openRenameForm"
                                        >
                                            Rename prefix
                                        </button>
                                        <button
                                            type="button"
                                            class="cursor-pointer rounded-xl border border-zinc-300 bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-800 hover:bg-zinc-200 dark:border-transparent dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                                            @click="router.push('/sessions/new')"
                                        >
                                            New session
                                        </button>
                                    </div>
                                </template>
                            </div>
                        </div>
                    </div>
            </div>
        </template>
        </div>

        <section
            v-if="session && !isExpired && activeTab === 'trim'"
            class="mt-2 w-full border-t border-zinc-200/90 pt-8 dark:border-zinc-800"
        >
            <div
                v-if="showChaptersSidePanel"
                class="mx-auto mb-5 w-full max-w-7xl px-4 sm:px-6"
            >
                <div
                    class="flex flex-col gap-3 rounded-xl border border-zinc-200/80 bg-zinc-50/95 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900/55 sm:flex-row sm:items-center sm:justify-between"
                >
                    <p class="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                        <span class="font-semibold text-zinc-800 dark:text-zinc-200">Chapters</span>
                        (sidecar VTT). Unsaved / Save / Discard apply to the chapter list beside the player, not trim ranges.
                    </p>
                    <div class="flex flex-wrap items-center justify-end gap-2 shrink-0">
                        <span
                            v-if="chapters.isDirty.value"
                            class="chapter-unsaved-pill"
                            title="Unsaved changes are stored locally; click Save to commit to S3."
                        >Unsaved</span>
                        <button
                            v-if="chapters.isDirty.value"
                            type="button"
                            class="chapter-toolbar-muted"
                            :disabled="chapters.isSaving.value"
                            @click="onDiscardChapters"
                        >Discard</button>
                        <button
                            type="button"
                            class="chapter-save-btn"
                            :disabled="!chapters.isDirty.value || chapters.isSaving.value"
                            @click="onSaveChapters"
                        >{{ chapters.isSaving.value ? 'Saving…' : 'Save chapters' }}</button>
                    </div>
                </div>
                <p v-if="chaptersSaveError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ chaptersSaveError }}</p>
            </div>

            <div
                v-if="showProbeConfig && activePlaybackUrl && probeResult?.format?.duration"
                class="relative left-1/2 mb-6 w-screen max-w-[90vw] -translate-x-1/2 px-4 sm:px-6"
            >
                <SegmentEditor
                    v-model="editorSegments"
                    mode="trim"
                    :duration="probeResult.format.duration"
                    :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                    :on-seek="(t: number) => playerRef?.seek(t)"
                    :on-play-pause="() => playerRef?.togglePlay()"
                    :is-playing="isPreviewPlaying"
                    :show-list="false"
                    keyboard-scope="global"
                    :fps="segmentEditorProbeFps"
                >
                    <template v-if="previewAudioTracks.length > 1" #playback-start>
                        <label class="playback-slot-label">Audio:</label>
                        <FormSelect
                            variant="playback"
                            presentation="custom"
                            numeric
                            v-model="selectedAudioTrack"
                            :options="previewAudioSelectOptions"
                        />
                    </template>
                    <template
                        v-if="previewQualityLevels.length > 1 && encodingType !== 'audio'"
                        #playback-end
                    >
                        <label class="playback-slot-label">Quality:</label>
                        <FormSelect
                            variant="playback"
                            presentation="custom"
                            :model-value="selectedQualityId ?? ''"
                            :options="previewQualitySelectOptions"
                            @update:model-value="onQualityChange($event === '' ? null : String($event))"
                        />
                    </template>
                </SegmentEditor>
            </div>

            <div class="mx-auto w-full max-w-7xl px-4 sm:px-6">
                <p
                    v-if="
                        !(
                            (showProbeConfig && activePlaybackUrl && probeResult?.format?.duration)
                            || showChaptersSidePanel
                        )
                    "
                    class="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400"
                >
                    Trim ranges appear below once the source is probed. Chapters are edited in the panel beside the player when preview is available.
                </p>
            </div>
        </section>

        <DeleteSessionModal
            v-model:open="deleteModalOpen"
            :session-label="deleteModalLabel"
            :has-s3-files="hasS3Files"
            :loading="deleting"
            @confirm="onConfirmDelete"
        />
    </div>
</template>
