<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, unref, nextTick } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRoute, useRouter } from 'vue-router';
import { computeLayoutKey, saveConfig } from '@luminary-media-converter/encode-config';
import type { ProbeResult, EncodeConfig, TrimSegment } from '@luminary-media-converter/encode-config';
import type { Segment } from '@luminary-media-converter/segment-editor';
import { useChapters, clearChapterDraftForSession } from '../composables/useChapters';
import type { AudioTrackInfo, QualityLevelInfo } from '../components/HlsPlayer.vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import SessionOutputPanel from '../components/session-view/SessionOutputPanel.vue';
import SessionPostProcessPanel from '../components/session-view/SessionPostProcessPanel.vue';
import SessionPlayerStrip from '../components/session-view/SessionPlayerStrip.vue';
import SessionViewHeader from '../components/session-view/SessionViewHeader.vue';
import SessionTrimWorkspace from '../components/session-view/SessionTrimWorkspace.vue';
import SessionWorkflowPanel from '../components/session-view/SessionWorkflowPanel.vue';
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
const outputPanelRef = ref<InstanceType<typeof SessionOutputPanel> | null>(null);
/** Ladder validity from EncodeConfigForm (for Trim tab Start Encoding). */
const encodeConfigCanSubmit = ref(false);

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
    created: { label: 'Created', color: 'text-slate-700 dark:text-slate-400', borderColor: 'border-slate-300 dark:border-slate-700' },
    uploading: { label: 'Uploading', color: 'text-cyan-700 dark:text-cyan-400', borderColor: 'border-cyan-300 dark:border-cyan-700/60' },
    uploaded: { label: 'Uploaded', color: 'text-slate-700 dark:text-slate-400', borderColor: 'border-slate-300 dark:border-slate-700' },
    queued: { label: 'Queued', color: 'text-amber-700 dark:text-amber-400', borderColor: 'border-amber-300 dark:border-amber-700/60' },
    encoding: { label: 'Encoding', color: 'text-slate-700 dark:text-slate-400', borderColor: 'border-slate-300 dark:border-slate-700/60' },
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
    return !!((s === 'created' || s === 'uploading') && activeUpload.value && !activeUpload.value.done);
});

const showUploadDoneWaiting = computed(() => {
    const s = currentStatus.value;
    return !!((s === 'created' || s === 'uploading') && activeUpload.value?.done && !activeUpload.value?.error);
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
    return s === 'uploaded' && isActiveSession.value && !!probeResult.value && !submitting.value;
});

watch(showProbeConfig, (ready) => {
    if (!ready) encodeConfigCanSubmit.value = false;
});

const showEncoding = computed(() => {
    const s = currentStatus.value;
    return s === 'queued' || s === 'encoding' || s === 'encrypting' || s === 'uploading_to_s3';
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
    const formTrack = outputPanelRef.value?.getEncodeForm()?.editableAudioTracks?.[track.index];
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

function onTrimQualityChange(id: string | null) {
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

/**
 * Trim timeline: same layout whenever playback exists — configure, pipeline, or completed (final HLS).
 * Trim ranges only affect the submitted encode before the job is queued; after that, edits are for reference / chapter sync only.
 */
const canEditTrimTimeline = computed(
    () => showProbeConfig.value || showEncoding.value || isCompleted.value,
);

/**
 * Chapter list beside the player whenever preview/final playback exists: before Start Encoding,
 * during the encode pipeline, and after completion. Separate from trim (bottom timeline).
 */
const canEditChaptersPlayback = computed(
    () => showProbeConfig.value || showEncoding.value || isCompleted.value,
);

/** Preview is ready for chapter editing (duration + URL); Trim segments tab, panel beside player. */
const showChaptersSidePanel = computed(
    () =>
        !!session.value
        && !isExpired.value
        && !!activePlaybackUrl.value
        && currentStatus.value !== 'failed'
        && chaptersSidePanelDuration.value > 0
        && canEditChaptersPlayback.value,
);

const showTrimSegmentEditor = computed(
    () => !!(canEditTrimTimeline.value && activePlaybackUrl.value && chaptersSidePanelDuration.value > 0),
);

const trimEditorProbeDuration = computed(() => {
    // Prefer player-reported duration (reflects encoded trim cuts); fall back through
    // in-memory probe then session-doc probe so completed sessions always get a value.
    return chaptersSidePanelDuration.value;
});

// Display metadata from the session detail or poller
const displayEncoder = computed<AccelMode | string | undefined>(
    () => poller.encoder.value ?? session.value?.encoder,
);

const displayEncoderLabel = computed(() => {
    const d = displayEncoder.value;
    return d && encoderConfig[d] ? encoderConfig[d].label : undefined;
});

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

const sessionPlayerStripRef = ref<InstanceType<typeof SessionPlayerStrip> | null>(null);
const playerRef = computed(() => {
    const inner = sessionPlayerStripRef.value?.playerRef;
    if (inner == null) return null;
    return unref(inner);
});

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

const previewAngleSelectOptions = computed(() =>
    uniqueAnglePlaylists.value.map((ap, i) => ({ value: i, label: ap.name })),
);

/** Multi-angle dropdown lives in trim timeline next to audio; hide duplicate under player. */
const anglesEmbeddedInTrimToolbar = computed(
    () =>
        isCompleted.value
        && showAngleSwitcher.value
        && showTrimSegmentEditor.value
        && activeTab.value === 'trim',
);

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
        clearChapterDraftForSession(sessionId.value);
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
    activeTab.value = 'workflow';
}

function onEncodeNextToTrim() {
    activeTab.value = 'trim';
}

function onEncodeCanSubmitChange(valid: boolean) {
    encodeConfigCanSubmit.value = valid;
}

async function onStartEncodingFromTrim() {
    submissionError.value = null;
    const cfg = outputPanelRef.value?.getEncodeForm()?.buildEncodeConfig() ?? null;
    if (cfg) {
        await onEncodeSubmit(cfg);
    } else {
        activeTab.value = 'output';
        submissionError.value =
            'Encoding options are incomplete or invalid. Use the Encode settings tab to fix any highlighted fields, then return here and click Start Encoding again.';
    }
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
            editorSegments.value = [];
        }
    },
);

watch(
    [() => sessionId.value, activePlaybackUrl, isExpired],
    async ([id, url, expired]) => {
        if (!id || !url || expired) return;
        if (chapters.isLoaded.value && chapters.loadedSessionId.value === id) return;
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

/** While trim timeline is editable, chapter list mirrors trim ranges (labels preserved by row index). */
const hadTrimForChapterSync = ref(false);

function segmentTimesAlmostEqual(a: Segment, b: Segment): boolean {
    return Math.abs(a.inSec - b.inSec) < 1e-4 && Math.abs(a.outSec - b.outSec) < 1e-4;
}

function sameTrimAsChapterBoundaries(trim: Segment[], ch: Segment[]): boolean {
    if (trim.length !== ch.length) return false;
    return trim.every((t, i) => segmentTimesAlmostEqual(t, ch[i]!));
}

/** True when trim timeline and chapter list already match (times + labels, same order). */
function editorMatchesChapters(ed: Segment[], ch: Segment[]): boolean {
    if (ed.length !== ch.length) return false;
    return ed.every((s, i) => {
        const c = ch[i]!;
        return (
            segmentTimesAlmostEqual(s, c)
            && (s.label ?? '') === (c.label ?? '')
        );
    });
}

/** Keeps the trim timeline in sync with the chapter list whenever trim editing is enabled. */
function syncEditorFromChaptersIfNeeded() {
    if (!canEditTrimTimeline.value || !chapters.isLoaded.value) return;
    if (editorMatchesChapters(editorSegments.value, chapterSegments.value)) return;
    editorSegments.value = chapterSegments.value.map((s) => ({ ...s }));
}

function syncChaptersFromTrim() {
    if (!canEditTrimTimeline.value || !chapters.isLoaded.value) return;

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
        if (loaded) {
            syncChaptersFromTrim();
            syncEditorFromChaptersIfNeeded();
        }
    },
);

watch(
    chapterSegments,
    () => {
        syncEditorFromChaptersIfNeeded();
    },
    { deep: true },
);

watch(canEditTrimTimeline, (can) => {
    if (!can) hadTrimForChapterSync.value = false;
    else syncEditorFromChaptersIfNeeded();
});

// ---------------------------------------------------------------------------
// Session workspace — tabs, stepper, activity log
// ---------------------------------------------------------------------------

type SessionTabId = 'workflow' | 'output' | 'trim' | 'post';

const activeTab = ref<SessionTabId>('workflow');

const trimTimelineWorkspaceRef = ref<InstanceType<typeof SessionTrimWorkspace> | null>(null);

watch(
    () => [activeTab.value, showTrimSegmentEditor.value] as const,
    async ([tab, showTrim]) => {
        if (tab !== 'trim' || !showTrim) return;
        await nextTick();
        trimTimelineWorkspaceRef.value?.focusSegmentEditor?.();
    },
);

/** Chapter list beside the player on the Trim segments tab (when playback + duration are ready). */
const showChaptersBesidePlayer = computed(
    () => activeTab.value === 'trim' && showChaptersSidePanel.value,
);

/** Trim tab panel below tabs: hide when there is nothing to show (timeline + chapters live elsewhere). */
const hasTrimToolbarContent = computed(() => {
    if (showChaptersBesidePlayer.value && chaptersSaveError.value) return true;
    if (showChaptersBesidePlayer.value && !showTrimSegmentEditor.value) return true;
    return !(showTrimSegmentEditor.value || showChaptersBesidePlayer.value);
});

/** Includes `showProbeConfig` so the card (and SessionOutputPanel / EncodeConfigForm) stay mounted on the Trim tab — otherwise `buildEncodeConfig()` is null and Start Encoding shows a false "incomplete" alert. */
const showSessionDetailCard = computed(
    () =>
        activeTab.value !== 'trim' ||
        hasTrimToolbarContent.value ||
        showProbeConfig.value,
);

/** Wide breakout for trim tab — maximize horizontal space for segment editing. */
const trimPlayerBreakoutClass = computed(() => {
    if (activeTab.value !== 'trim' || !showTrimSegmentEditor.value) {
        return '';
    }
    return 'relative left-1/2 w-screen max-w-[min(100vw-1rem,96rem)] -translate-x-1/2 px-1 sm:px-2';
});

/** Tab label for the trim/chapters tab: "Trim segments" pre-encode, "Chapters" once encoding starts. */
const trimTabLabel = computed(() =>
    showEncoding.value || isCompleted.value ? 'Chapters' : 'Trim segments',
);

// Lock page scroll when on the trim tab so it becomes a true full-viewport workspace.
watch(
    () => activeTab.value,
    (tab) => {
        document.documentElement.style.overflowY = tab === 'trim' ? 'hidden' : '';
    },
    { immediate: true },
);

// Auto-advance to Encode settings the first time probe results are ready
// so the user lands directly on the configuration form instead of the status tab.
let autoSwitchedToOutput = false;
watch(showProbeConfig, (ready) => {
    if (ready && !autoSwitchedToOutput) {
        autoSwitchedToOutput = true;
        activeTab.value = 'output';
    }
    if (!ready) autoSwitchedToOutput = false;
});

// If the session transitions to completed while the Encode settings tab is open, redirect away.
watch(isCompleted, (completed) => {
    if (completed && activeTab.value === 'output') {
        activeTab.value = 'workflow';
    }
});

const effectiveProbe = computed<ProbeResult | null>(() => {
    const raw = probeResult.value ?? session.value?.probeResult;
    return (raw as ProbeResult | null) ?? null;
});

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

async function copyOutputObjectKey(key: string) {
    const base = s3PublicBaseUrl.value;
    const text = base ? `${base}/${key}` : key;
    await navigator.clipboard.writeText(text);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(fetchSession);

onUnmounted(() => {
    poller.stop();
    chapters.unload();
    document.documentElement.style.overflowY = '';
});
</script>

<template>
    <div class="app-view flex min-h-dvh w-full max-w-none flex-col">
        <div
            class="mx-auto w-full max-w-7xl flex-1 pb-8 pt-4 transition-all duration-300"
            :class="session && !loading && activeTab === 'trim' ? 'min-h-0 flex flex-col px-2 sm:px-3' : 'px-4 sm:px-6'"
        >

        <div v-if="loading" class="flex justify-center rounded-2xl border border-slate-200/90 bg-white/90 py-16 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10">
            <svg class="h-8 w-8 animate-spin text-slate-500 dark:text-slate-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
        </div>

        <div v-else-if="error" class="rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-950/30">
            <p class="text-sm text-red-800 dark:text-red-300">{{ error }}</p>
        </div>

        <template v-else-if="session">
            <!-- Trim tab: compact name + status strip — same horizontal breakout as the player so edges align -->
            <div
                v-if="activeTab === 'trim'"
                class="mb-2 flex shrink-0 items-center"
                :class="[
                    showChaptersBesidePlayer ? 'lg:gap-3' : '',
                    trimPlayerBreakoutClass,
                ]"
            >
                <div
                    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                    :class="showChaptersBesidePlayer ? 'lg:flex-5' : 'w-full'"
                >
                    <router-link
                        to="/sessions"
                        class="-ml-1 inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        title="Back to sessions list"
                    >
                        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                        <span class="sr-only">Back to sessions list</span>
                    </router-link>
                    <span
                        class="min-w-0 truncate text-xl font-semibold tracking-tight text-slate-800 dark:text-slate-100"
                        :title="sessionName || 'Untitled session'"
                    >{{ sessionName || 'Untitled session' }}</span>
                    <template v-if="session?.createdAt">
                        <span class="shrink-0 text-slate-400" aria-hidden="true">·</span>
                        <span class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">{{ relativeCreatedLabel(session.createdAt) }}</span>
                    </template>
                    <StatusBadge
                        v-if="currentStatus"
                        class="shrink-0"
                        :label="statusConfig[currentStatus]?.label ?? currentStatus"
                        :color="statusConfig[currentStatus]?.color ?? 'text-slate-700 dark:text-slate-400'"
                        :border-color="statusConfig[currentStatus]?.borderColor ?? 'border-slate-300 dark:border-slate-700'"
                    />
                </div>
                <!-- Spacer matching the chapters column so name/badge stays above the player -->
                <div v-if="showChaptersBesidePlayer" class="hidden lg:block lg:flex-3" />
            </div>

            <div v-show="activeTab !== 'trim'" class="mb-4">
                <SessionViewHeader
                    class="min-w-0"
                    v-model:name-input="nameInput"
                    show-back-to-sessions
                    :session-name="sessionName"
                    :session="session"
                    :editing-name="editingName"
                    :saving-name="savingName"
                    :created-subtitle="relativeCreatedLabel(session.createdAt)"
                    :display-encoder="displayEncoder"
                    :display-segment-format="displaySegmentFormat"
                    :is-encrypted="isEncrypted"
                    @save-name="saveName"
                    @cancel-edit-name="cancelEditName"
                    @start-edit-name="startEditName"
                />
            </div>

            <!-- Expired -->
            <div
                v-if="isExpired"
                class="rounded-2xl border border-slate-200/90 bg-white/90 p-8 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
            >
                <div class="flex flex-col items-center gap-4 py-8">
                    <svg class="h-10 w-10 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="text-sm text-slate-700 dark:text-slate-300">Session expired</p>
                    <p class="max-w-md text-center text-xs text-slate-500">The encoding session is no longer active and cannot be interacted with.</p>
                    <div class="mt-2 grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
                        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Status</p>
                            <p class="text-sm text-slate-800 dark:text-slate-200">{{ statusConfig[session.status]?.label ?? session.status }}</p>
                        </div>
                        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                            <p class="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Created</p>
                            <p class="text-sm text-slate-800 dark:text-slate-200">{{ formatDate(session.createdAt) }}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        class="mt-2 rounded-xl border border-slate-300 bg-slate-100 px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:border-transparent dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                        @click="router.push('/sessions/new')"
                    >
                        New session
                    </button>
                </div>
            </div>

            <!-- Main column -->
            <div
                v-else
                :class="[
                    'min-w-0 flex flex-col',
                    activeTab === 'trim' ? 'min-h-0 flex-1 gap-2' : 'space-y-5',
                ]"
            >
                <div class="min-w-0" :class="trimPlayerBreakoutClass">
                    <SessionPlayerStrip
                        ref="sessionPlayerStripRef"
                        v-model:chapter-segments="chapterSegments"
                        :active-playback-url="activePlaybackUrl"
                        :is-completed="isCompleted"
                        :thumbnail-vtt-url="thumbnailVttUrl"
                        :encoding-type="encodingType"
                        :is-audio-only="isAudioOnly"
                        :encryption-key-hex="encryptionKeyHex"
                        :poller-encryption-key-hex="poller.encryptionKeyHex.value ?? undefined"
                        :show-chapters-side-panel="showChaptersBesidePlayer"
                        :chapters-side-panel-duration="chaptersSidePanelDuration"
                        :is-preview-playing="isPreviewPlaying"
                        :segment-editor-probe-fps="segmentEditorProbeFps"
                        :chapters-save-error="chaptersSaveError"
                        :active-tab="activeTab"
                        :show-angle-switcher="showAngleSwitcher"
                        :hide-angle-switcher="anglesEmbeddedInTrimToolbar"
                        :unique-angle-playlists="uniqueAnglePlaylists"
                        :current-angle-index="currentAngleIndex"
                        @quality-levels="onPreviewQualityLevels"
                        @playing-change="isPreviewPlaying = $event"
                        @duration-change="playerDuration = $event"
                        @audio-tracks="onNativeAudioTracks"
                        @angle-change="switchToAngle"
                    />
                </div>

                <Teleport to="#app-session-workflow-teleport">
                    <div class="flex w-full min-w-0 items-center justify-end gap-1.5 sm:gap-2">
                        <!-- Workflow tabs -->
                        <div class="flex shrink-0 gap-0.5 overflow-x-auto rounded-lg border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-slate-700 dark:bg-slate-800/50">
                            <button
                                v-for="tab in [
                                    { id: 'workflow' as const, label: 'Workflow' },
                                    ...(!isCompleted ? [{ id: 'output' as const, label: 'Encode' }] : []),
                                    { id: 'trim' as const, label: trimTabLabel },
                                    { id: 'post' as const, label: 'Delivery' },
                                ]"
                                :key="tab.id"
                                type="button"
                                class="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium transition-colors sm:px-2.5 sm:py-1.5 sm:text-xs"
                                :class="activeTab === tab.id
                                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'"
                                @click="activeTab = tab.id"
                            >
                                {{ tab.label }}
                            </button>
                        </div>

                        <!-- Start Encoding (trim tab, pre-encode only) -->
                        <div v-if="activeTab === 'trim' && showProbeConfig" class="shrink-0">
                            <button
                                type="button"
                                class="cursor-pointer rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600 sm:px-3 sm:py-1.5 sm:text-xs"
                                :disabled="!encodeConfigCanSubmit || submitting"
                                :title="!encodeConfigCanSubmit && !submitting
                                    ? 'Open Encode settings and complete the ladder (all required options) first.'
                                    : undefined"
                                @click="onStartEncodingFromTrim"
                            >
                                {{ submitting ? 'Starting…' : 'Start encoding' }}
                            </button>
                        </div>
                    </div>
                </Teleport>

                <SessionTrimWorkspace
                    ref="trimTimelineWorkspaceRef"
                    v-if="activeTab === 'trim' && showTrimSegmentEditor"
                    section="timeline"
                    v-model:editor-segments="editorSegments"
                    v-model:selected-audio-track="selectedAudioTrack"
                    v-model:selected-quality-id="selectedQualityId"
                    :show-chapters-side-panel="showChaptersBesidePlayer"
                    :chapters-is-dirty="chapters.isDirty.value"
                    :chapters-is-saving="chapters.isSaving.value"
                    :chapters-save-error="chaptersSaveError"
                    :show-trim-segment-editor="showTrimSegmentEditor"
                    :thumbnail-vtt-url="thumbnailVttUrl"
                    :probe-duration="trimEditorProbeDuration"
                    :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                    :on-seek="(t: number) => playerRef?.seek(t)"
                    :on-play-pause="() => playerRef?.togglePlay()"
                    :is-preview-playing="isPreviewPlaying"
                    :segment-editor-probe-fps="segmentEditorProbeFps"
                    :show-audio-select="previewAudioTracks.length > 1"
                    :preview-audio-select-options="previewAudioSelectOptions"
                    :show-angle-select="isCompleted && showAngleSwitcher"
                    :angle-index="currentAngleIndex"
                    :preview-angle-select-options="previewAngleSelectOptions"
                    :show-quality-select="previewQualityLevels.length > 1 && encodingType !== 'audio'"
                    :preview-quality-select-options="previewQualitySelectOptions"
                    @update:selected-quality-id="onTrimQualityChange"
                    @angle-change="switchToAngle"
                    @discard-chapters="onDiscardChapters"
                    @save-chapters="onSaveChapters"
                />

                <div
                    v-if="showSessionDetailCard"
                    class="w-full rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur sm:p-6 dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
                    :class="{ hidden: activeTab === 'trim' }"
                >
                    <!-- Encode workflow -->
                    <div v-show="activeTab === 'workflow'" class="mt-5">
                                <SessionWorkflowPanel
                                    :ingest="stepperIngest"
                                    :probe="stepperProbe"
                                    :encoding="stepperEncoding"
                                    :upload="stepperUpload"
                                    :finalize="stepperFinalize"
                                    :show-probe-config="showProbeConfig"
                                    :submitting="submitting"
                                    :show-encoding="showEncoding"
                                    :is-completed="isCompleted"
                                    :current-status="currentStatus"
                                    :show-upload-progress="showUploadProgress"
                                    :show-upload-done-waiting="showUploadDoneWaiting"
                                    :show-upload-remote-message="showUploadRemoteMessage"
                                    :active-upload-progress="activeUpload?.progress"
                                    :active-upload-can-cancel="activeUpload ? activeUpload.progress < 100 : false"
                                    :remote-ingest-progress="remoteIngestProgress"
                                    :remote-ingest-label="remoteIngestLabel"
                                    :ingest-eta-display="ingestEtaDisplay"
                                    :poller-ingest-total-bytes="poller.ingestTotalBytes.value"
                                    :probe-loading="probeLoading"
                                    :session-error="session?.error"
                                    :encoder-label="displayEncoderLabel"
                                    :display-segment-format="displaySegmentFormat"
                                    :encoding-type="encodingType"
                                    :eta-display="etaDisplay"
                                    :poller-status="poller.status.value"
                                    :poller-queue-position="poller.queuePosition.value"
                                    :pipeline-encoding="poller.pipelineProgress.value?.encoding ?? poller.progress.value"
                                    :pipeline-encrypting="poller.pipelineProgress.value?.encrypting"
                                    :pipeline-uploading="poller.pipelineProgress.value?.uploading"
                                    :poller-progress="poller.progress.value"
                                    :poller-error="poller.error.value"
                                    @switch-tab="activeTab = $event"
                                    @cancel-upload="cancelUpload"
                                    @cancel-encode="onCancelEncode"
                                />
                            </div>

                            <!-- Output configuration -->
                            <div v-show="activeTab === 'output'" class="mt-5 space-y-4">
                                <div
                                    v-if="showProbeConfig"
                                    class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                                >
                                    <p class="text-xs text-slate-500 dark:text-slate-400">
                                        Choose <strong class="text-slate-700 dark:text-slate-300">trim segments</strong> on the next tab (timeline) and optional <strong class="text-slate-700 dark:text-slate-300">chapter titles</strong> beside the player anytime preview is available — including before you start encoding.
                                    </p>
                                    <button
                                        type="button"
                                        class="shrink-0 rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                        @click="activeTab = 'trim'"
                                    >
                                        Trim segments →
                                    </button>
                                </div>
                                <SessionOutputPanel
                                    ref="outputPanelRef"
                                    :show-probe-config="showProbeConfig"
                                    :probe-result="probeResult"
                                    :byte-range-enabled="byteRangeEnabled"
                                    encode-primary-action="next-to-trim"
                                    appearance="session"
                                    @submit="onEncodeSubmit"
                                    @next-to-trim="onEncodeNextToTrim"
                                    @can-submit-change="onEncodeCanSubmitChange"
                                    @back="onEncodeBack"
                                />
                            </div>

                            <!-- Post-process -->
                            <div v-show="activeTab === 'post'" class="mt-5">
                                <SessionPostProcessPanel
                                    v-model:show-files="showFiles"
                                    v-model:selected-target-config-id="selectedTargetConfigId"
                                    v-model:move-new-prefix="moveNewPrefix"
                                    v-model:move-confirmed-overwrite="moveConfirmedOverwrite"
                                    v-model:rename-new-prefix="renameNewPrefix"
                                    v-model:rename-confirmed-overwrite="renameConfirmedOverwrite"
                                    :is-completed="isCompleted"
                                    :is-terminal="isTerminal"
                                    :current-status="currentStatus"
                                    :display-master-playlist="displayMasterPlaylist"
                                    :s3-url="s3Url"
                                    :copied="copied"
                                    :is-encrypted="isEncrypted"
                                    :encryption-key-hex="encryptionKeyHex"
                                    :copied-key="copiedKey"
                                    :display-files="displayFiles"
                                    :should-collapse-files="shouldCollapseFiles"
                                    :session="session"
                                    :has-s3-files="hasS3Files"
                                    :show-move-form="showMoveForm"
                                    :show-rename-form="showRenameForm"
                                    :move-target-s3-select-options="moveTargetS3SelectOptions"
                                    :move-prefix-warning="movePrefixWarning"
                                    :move-error="moveError"
                                    :can-move="canMove"
                                    :moving="moving"
                                    :rename-prefix-warning="renamePrefixWarning"
                                    :rename-error="renameError"
                                    :can-rename="canRename"
                                    :renaming="renaming"
                                    @copy-playback-url="copyPlaybackUrl"
                                    @copy-encryption-key="copyEncryptionKey"
                                    @copy-output-object-key="copyOutputObjectKey"
                                    @open-move-form="openMoveForm"
                                    @open-rename-form="openRenameForm"
                                    @check-move-prefix="checkMovePrefix"
                                    @confirm-move="confirmMove"
                                    @cancel-move="showMoveForm = false"
                                    @check-rename-prefix="checkRenamePrefix"
                                    @confirm-rename="confirmRename"
                                    @cancel-rename="showRenameForm = false"
                                    @delete-session="deleteModalOpen = true"
                                />
                            </div>

                            <!-- Trim segments toolbar (chapter save/discard when chapter panel is visible) -->
                            <SessionTrimWorkspace
                                v-show="activeTab === 'trim'"
                                section="toolbar"
                                v-model:editor-segments="editorSegments"
                                v-model:selected-audio-track="selectedAudioTrack"
                                v-model:selected-quality-id="selectedQualityId"
                                :show-chapters-side-panel="showChaptersBesidePlayer"
                                :chapters-is-dirty="chapters.isDirty.value"
                                :chapters-is-saving="chapters.isSaving.value"
                                :chapters-save-error="chaptersSaveError"
                                :show-trim-segment-editor="showTrimSegmentEditor"
                                :thumbnail-vtt-url="thumbnailVttUrl"
                                :can-edit-trim-timeline="canEditTrimTimeline"
                                :can-edit-chapters-playback="canEditChaptersPlayback"
                                :probe-duration="trimEditorProbeDuration"
                                :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                                :on-seek="(t: number) => playerRef?.seek(t)"
                                :on-play-pause="() => playerRef?.togglePlay()"
                                :is-preview-playing="isPreviewPlaying"
                                :segment-editor-probe-fps="segmentEditorProbeFps"
                                :show-audio-select="previewAudioTracks.length > 1"
                                :preview-audio-select-options="previewAudioSelectOptions"
                                :show-quality-select="previewQualityLevels.length > 1 && encodingType !== 'audio'"
                                :preview-quality-select-options="previewQualitySelectOptions"
                                @update:selected-quality-id="onTrimQualityChange"
                                @discard-chapters="onDiscardChapters"
                                @save-chapters="onSaveChapters"
                            />
                </div>

            </div>
        </template>
        </div>

        <DeleteSessionModal
            v-model:open="deleteModalOpen"
            :session-label="deleteModalLabel"
            :has-s3-files="hasS3Files"
            :loading="deleting"
            @confirm="onConfirmDelete"
        />

        <Transition name="session-toast">
            <div
                v-if="submissionError"
                role="alert"
                class="fixed top-4 right-4 z-[60] flex max-w-md items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-lg shadow-red-900/10 sm:top-6 sm:right-6 dark:border-red-800/60 dark:bg-red-950/90 dark:text-red-100 dark:shadow-black/40"
            >
                <svg class="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p class="min-w-0 flex-1 leading-snug">{{ submissionError }}</p>
                <button
                    type="button"
                    class="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/50"
                    @click="submissionError = null"
                >
                    Dismiss
                </button>
            </div>
        </Transition>
    </div>
</template>

<style scoped>
.session-toast-enter-active,
.session-toast-leave-active {
    transition: opacity 0.18s ease, transform 0.18s ease;
}
.session-toast-enter-from,
.session-toast-leave-to {
    opacity: 0;
    transform: translate(6px, -6px);
}
</style>
