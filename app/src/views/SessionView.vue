<script setup lang="ts">
import {
    ref,
    computed,
    watch,
    onMounted,
    onUnmounted,
    unref,
    nextTick,
} from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useRoute, useRouter } from 'vue-router';
import {
    computeLayoutKey,
    saveConfig,
} from '@luminary-media-converter/encode-config';
import type {
    ProbeResult,
    EncodeConfig,
    TrimSegment,
} from '@luminary-media-converter/encode-config';
import { SegmentEditor, formatTime } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import {
    useChapters,
    clearChapterDraftForSession,
} from '../composables/useChapters';
import type {
    AudioTrackInfo,
    QualityLevelInfo,
} from '../components/HlsPlayer.vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import SessionOutputPanel from '../components/session-view/SessionOutputPanel.vue';
import SessionPostProcessPanel from '../components/session-view/SessionPostProcessPanel.vue';
import SessionPlayerStrip from '../components/session-view/SessionPlayerStrip.vue';
import SessionTrimWorkspace from '../components/session-view/SessionTrimWorkspace.vue';
import SessionWorkflowPanel from '../components/session-view/SessionWorkflowPanel.vue';
import {
    getSessionDetail,
    getSessionStatus,
    startEncode,
    deleteSession,
    updateSessionName,
    getSessionWaveform,
} from '../api';
import { useSessionPoller } from '../composables/useSessionPoller';
import { useActiveUploads } from '../composables/useActiveUploads';
import { useAppLayout } from '../composables/useAppLayout';
import { useEncodeEta } from '../composables/useEncodeEta';
import { useSessionFileOps } from '../composables/useSessionFileOps';
import { useChapterTrimSync } from '../composables/useChapterTrimSync';
import { useTrimDeletions } from '../composables/useTrimDeletions';
import { useTrimPlayback } from '../composables/useTrimPlayback';
import {
    invertRanges,
    mapSegmentsFromTimeline,
    mapSegmentsToTimeline,
    outputToSource,
    slicePeaksToTrims,
    sourceToOutput,
    sourceToOutputClamped,
    trimmedDuration,
} from '../utils/trimTimeline';
import type { AccelMode, SegmentFormat } from '../types';
import { formatBytes, formatDateTime, formatRelative } from '../utils/format';
import { errorMessage } from '../utils/errors';
import { statusLabel } from '../utils/status';

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
const waveformPeaks = ref<number[] | null>(null);
const editorSegments = ref<Segment[]>([]);
const trimSegments = computed<TrimSegment[]>(() =>
    editorSegments.value.map((s: Segment) => ({
        inSec: s.inSec,
        outSec: s.outSec,
    }))
);
/**
 * Ranges removed from the trim timeline. They stay listed beside the player so a
 * deletion can be undone, right up until the encode consumes the markers.
 */
const trimDeletions = useTrimDeletions(editorSegments);

/**
 * Only pre-encode removals are trim deletions. Once the encode is submitted the
 * timeline holds chapters, and removing one of those is not "removed from the
 * encode" — it is a chapter edit, with its own undo and its own save path.
 */
function onTimelineSegmentRemoved(segment: Segment) {
    if (!showProbeConfig.value) return;
    // The editor works in timeline time, which stops matching source time as soon
    // as the first deletion shortens the timeline. Deletions are held in source
    // time, so map before recording — otherwise the second deletion onwards cuts
    // whatever happens to sit at those numbers in the source, and a couple of
    // deletions can collapse a two-minute video to a few seconds.
    const [inSourceTime] = timelineIsShortened.value
        ? mapSegmentsFromTimeline([segment], timelineRanges.value)
        : [segment];
    trimDeletions.record(inSourceTime);
}

const removedTrimSegments = computed(() =>
    showProbeConfig.value ? trimDeletions.removed.value : []
);


const outputPanelRef = ref<InstanceType<typeof SessionOutputPanel> | null>(
    null
);
/** Ladder validity from EncodeConfigForm (for Trim tab Start Encoding). */
const encodeConfigCanSubmit = ref(false);

// Chapter editor — sidecar VTT in S3, autosaves to localStorage, explicit save to S3.
const chapters = useChapters({
    getAccessToken: () => getAccessTokenSilently(),
});
const chapterSegments = chapters.segments;
const chaptersSaveError = ref<string | null>(null);

// Playback duration as reported by the player — the only correct source for
// the chapter timeline since it reflects trim cuts on encoded output and is
// the only signal available for imported sessions (which never run probe).
const playerDuration = ref<number | null>(null);
const chapterTimelineDuration = computed(
    () => playerDuration.value ?? probeResult.value?.format?.duration ?? 0
);

/** Duration for the beside-player chapters panel (player > in-memory probe > session doc probe). */
const chaptersSidePanelDuration = computed(() => {
    const pd = playerDuration.value;
    if (pd != null && pd > 0) return pd;
    const pr = probeResult.value?.format?.duration;
    if (typeof pr === 'number' && pr > 0) return pr;
    const sp = (session.value?.probeResult as ProbeResult | undefined)?.format
        ?.duration;
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
const { setHeaderLayout, headerLayout } = useAppLayout();

// ---------------------------------------------------------------------------
// Status badge config
// ---------------------------------------------------------------------------

// Status text/border colors for the badge under the player. Labels live in
// utils/status.ts (shared with the history list); colors stay local because the
// two surfaces use different visual treatments.
const statusColors: Record<string, { color: string; borderColor: string }> = {
    created: {
        color: 'text-slate-700 dark:text-slate-400',
        borderColor: 'border-slate-300 dark:border-slate-700',
    },
    uploading: {
        color: 'text-cyan-700 dark:text-cyan-400',
        borderColor: 'border-cyan-300 dark:border-cyan-700/60',
    },
    uploaded: {
        color: 'text-slate-700 dark:text-slate-400',
        borderColor: 'border-slate-300 dark:border-slate-700',
    },
    queued: {
        color: 'text-amber-700 dark:text-amber-400',
        borderColor: 'border-amber-300 dark:border-amber-700/60',
    },
    encoding: {
        color: 'text-slate-700 dark:text-slate-400',
        borderColor: 'border-slate-300 dark:border-slate-700/60',
    },
    encrypting: {
        color: 'text-amber-700 dark:text-amber-400',
        borderColor: 'border-amber-300 dark:border-amber-700/60',
    },
    uploading_to_s3: {
        color: 'text-cyan-700 dark:text-cyan-400',
        borderColor: 'border-cyan-300 dark:border-cyan-700/60',
    },
    completed: {
        color: 'text-emerald-700 dark:text-emerald-400',
        borderColor: 'border-emerald-300 dark:border-emerald-700/60',
    },
    failed: {
        color: 'text-red-700 dark:text-red-400',
        borderColor: 'border-red-300 dark:border-red-700/60',
    },
    imported: {
        color: 'text-violet-700 dark:text-violet-400',
        borderColor: 'border-violet-300 dark:border-violet-700/60',
    },
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

const isActiveSession = computed(
    () => !!sessionToken.value && !!encodingApiUrl.value
);

const isTerminal = computed(() => {
    const ps = pollerStatus.value;
    const ss = sessionDocStatus.value;
    return (
        ps === 'completed' ||
        ps === 'failed' ||
        ss === 'completed' ||
        ss === 'failed' ||
        ss === 'imported'
    );
});

const isCompleted = computed(() => {
    const ps = pollerStatus.value;
    const ss = sessionDocStatus.value;
    return ps === 'completed' || ss === 'completed' || ss === 'imported';
});

const isExpired = computed(() => {
    // Non-terminal status but no session token means the encoding session expired
    return (
        !isTerminal.value &&
        !isActiveSession.value &&
        !loading.value &&
        session.value
    );
});

const s3PublicBaseUrl = computed(() => {
    const s3 = session.value?.s3Config;
    if (s3?.publicUrl) return s3.publicUrl.replace(/\/+$/, '');
    if (!s3?.endPoint || !s3?.bucket) return undefined;
    // Strip any protocol prefix from endPoint to avoid double https://
    const bareHost = s3.endPoint
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
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
    return !!(
        (s === 'created' || s === 'uploading') &&
        activeUpload.value &&
        !activeUpload.value.done
    );
});

const showUploadDoneWaiting = computed(() => {
    const s = currentStatus.value;
    return !!(
        (s === 'created' || s === 'uploading') &&
        activeUpload.value?.done &&
        !activeUpload.value?.error
    );
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

const remoteIngestLabel = computed<string>(() => {
    const total = poller.ingestTotalBytes.value;
    return total != null
        ? `Uploading from URL... (${formatBytes(total)})`
        : 'Uploading from URL...';
});

const showProbeConfig = computed(() => {
    const s = currentStatus.value;
    return (
        s === 'uploaded' &&
        isActiveSession.value &&
        !!probeResult.value &&
        !submitting.value
    );
});

watch(showProbeConfig, (ready) => {
    if (!ready) encodeConfigCanSubmit.value = false;
});

const showEncoding = computed(() => {
    const s = currentStatus.value;
    return (
        s === 'queued' ||
        s === 'encoding' ||
        s === 'encrypting' ||
        s === 'uploading_to_s3'
    );
});

/** Upload / encode progress panel on the Timeline tab (and when the detail card is visible). */
const showSessionWorkflowPanel = computed(() => {
    const cs = currentStatus.value;
    const preEncodeFlow =
        !showProbeConfig.value &&
        !submitting.value &&
        !(showEncoding.value || isCompleted.value || cs === 'failed');
    if (preEncodeFlow) {
        if (showUploadProgress.value && activeUpload.value?.progress != null)
            return true;
        if (showUploadDoneWaiting.value) return true;
        if (showUploadRemoteMessage.value) return true;
        if (cs === 'uploaded' && probeLoading.value) return true;
        return false;
    }
    if (
        showProbeConfig.value &&
        showUploadProgress.value &&
        activeUpload.value?.progress != null
    ) {
        return true;
    }
    if (submitting.value) return true;
    if (
        (showEncoding.value || isCompleted.value || cs === 'failed') &&
        !submitting.value
    )
        return true;
    return false;
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
    const formTrack =
        outputPanelRef.value?.getEncodeForm()?.editableAudioTracks?.[
            track.index
        ];
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
    }))
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
    }))
);

async function fetchPreviewAudioTracks() {
    if (!sessionToken.value || !encodingApiUrl.value) return;
    try {
        const res = await fetch(
            `${encodingApiUrl.value}/api/sessions/${sessionId.value}/preview/audio-tracks?token=${sessionToken.value}`
        );
        if (res.ok) {
            const tracks = await res.json();
            previewAudioTracks.value = tracks;
            const defaultTrack = tracks.find(
                (t: PreviewAudioTrack) => t.isDefault
            );
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
        const hasKey = !!(
            encryptionKeyHex.value || poller.encryptionKeyHex.value
        );
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
    () => showProbeConfig.value || showEncoding.value || isCompleted.value
);

/**
 * Chapter list beside the player whenever preview/final playback exists: before Start Encoding,
 * during the encode pipeline, and after completion. Separate from trim (bottom timeline).
 */
const canEditChaptersPlayback = computed(
    () => showProbeConfig.value || showEncoding.value || isCompleted.value
);

/** Preview is ready for chapter editing (duration + URL); Trim segments tab, panel beside player. */
const showChaptersSidePanel = computed(
    () =>
        !!session.value &&
        !isExpired.value &&
        !!activePlaybackUrl.value &&
        currentStatus.value !== 'failed' &&
        chaptersSidePanelDuration.value > 0 &&
        canEditChaptersPlayback.value
);

/**
 * The panel beside the player is a clip list before the encode and a chapter list
 * after it, so it has to read whichever list is live for the phase. It used to be
 * bound to the chapter list alone, which only showed trim ranges because the two
 * were mirrored — once that mirroring went (#51), the clip list came up empty.
 */
const asidePanelSegments = computed<Segment[]>({
    get: () =>
        showProbeConfig.value ? editorSegments.value : chapterSegments.value,
    set: (next) => {
        if (showProbeConfig.value) editorSegments.value = next;
        else chapterSegments.value = next;
    },
});

const showTrimSegmentEditor = computed(
    () =>
        !!(
            canEditTrimTimeline.value &&
            activePlaybackUrl.value &&
            chaptersSidePanelDuration.value > 0
        )
);

/**
 * Trim ranges the encode was submitted with, echoed back by the API so the output
 * timeline still renders correctly after a page reload mid-encode.
 */
const submittedTrimSegments = computed<TrimSegment[]>(
    () => (poller.trimSegments.value as TrimSegment[] | undefined) ?? []
);

/**
 * True once trimming has been applied — the timeline then represents the encoded
 * output (the retained ranges, concatenated), not the source file.
 */
const showsOutputTimeline = computed(
    () => !showProbeConfig.value && submittedTrimSegments.value.length > 0
);

/** Source-file duration — the scale the waveform peaks were computed against. */
const sourceProbeDuration = computed(() => {
    const pr = probeResult.value?.format?.duration;
    if (typeof pr === 'number' && pr > 0) return pr;
    const sp = (session.value?.probeResult as ProbeResult | undefined)?.format
        ?.duration;
    return typeof sp === 'number' && sp > 0 ? sp : 0;
});

const trimEditorProbeDuration = computed(() => {
    if (timelineIsShortened.value) return trimmedDuration(timelineRanges.value);
    // Prefer player-reported duration (reflects encoded trim cuts); fall back through
    // in-memory probe then session-doc probe so completed sessions always get a value.
    if (showsOutputTimeline.value) {
        const player = playerDuration.value;
        if (player != null && player > 0) return player;
        // Playback not ready yet: use the retained ranges rather than letting the
        // fallbacks stretch the timeline back out to the full source duration.
        return trimmedDuration(submittedTrimSegments.value);
    }
    return chaptersSidePanelDuration.value;
});

/**
 * Waveform drawn under the timeline. Peaks are computed from the source file
 * pre-encode, so once trimming is applied they have to be sliced down to the
 * retained ranges. After completion the sidecar fetched from S3 is generated from
 * the concat list and is already trimmed — slicing again would cut it twice.
 */
const timelineWaveformPeaks = computed(() => {
    if (timelineIsShortened.value) {
        return slicePeaksToTrims(
            waveformPeaks.value,
            sourceProbeDuration.value,
            timelineRanges.value
        );
    }
    if (!showsOutputTimeline.value || isCompleted.value) {
        return waveformPeaks.value;
    }
    return slicePeaksToTrims(
        waveformPeaks.value,
        sourceProbeDuration.value,
        submittedTrimSegments.value
    );
});

// Display metadata from the session detail or poller
const displayEncoder = computed<AccelMode | string | undefined>(
    () => poller.encoder.value ?? session.value?.encoder
);

const displayEncoderLabel = computed(() => {
    const d = displayEncoder.value;
    return d && encoderConfig[d] ? encoderConfig[d].label : undefined;
});

const displaySegmentFormat = computed<SegmentFormat | string | undefined>(
    () => poller.segmentFormat.value ?? session.value?.segmentFormat
);

// ---------------------------------------------------------------------------
// ETA labels — encoding (pipeline) + URL ingest. Each phase keeps its own
// sample buffer inside useEncodeEta, since their rates differ by orders of
// magnitude and would otherwise pollute each other.
// ---------------------------------------------------------------------------

const { etaDisplay } = useEncodeEta(
    () => poller.pipelineProgress.value?.encoding ?? poller.progress.value,
);
const { etaDisplay: ingestEtaDisplay } = useEncodeEta(() =>
    currentStatus.value === 'uploading' ? poller.progress.value : null,
);

// ---------------------------------------------------------------------------
// Player — angle switching, playback URL, copy, files
// ---------------------------------------------------------------------------

const sessionPlayerStripRef = ref<InstanceType<
    typeof SessionPlayerStrip
> | null>(null);
const chapterSegmentEditorRef = ref<{ focus?: () => void } | null>(null);
const playerRef = computed(() => {
    const inner = sessionPlayerStripRef.value?.playerRef;
    if (inner == null) return null;
    return unref(inner);
});

function seekPlayerTime(t: number) {
    playerRef.value?.seek(t);
}

/**
 * Preview playback follows the trim: discarded stretches are skipped, so what you
 * hear and see while previewing is the programme that will be encoded. Only while
 * the markers are live — afterwards the preview is already trim-aware server-side.
 */
/**
 * Deleting a clip takes that material out of the video, so the timeline loses it:
 * the waveform closes up, the total shortens, and the clips after it move earlier.
 * Material that was merely never marked stays put — it is still there to mark, and
 * collapsing it would make marking one clip look like discarding everything else.
 */
/**
 * The ranges the encode will keep. Normally the clips; when every clip has been
 * deleted, the source minus what was deleted — otherwise deleting them all would
 * send no trim at all and the encoder would take the whole source back, deletions
 * included.
 */
const effectiveKeepRanges = computed<TrimSegment[]>(() => {
    if (trimSegments.value.length > 0) return trimSegments.value;
    if (deletedRanges.value.length === 0) return [];
    return invertRanges(deletedRanges.value, sourceProbeDuration.value);
});

const deletedRanges = computed<TrimSegment[]>(() =>
    trimDeletions.removed.value.map((s) => ({ inSec: s.inSec, outSec: s.outSec }))
);

const timelineRanges = computed<TrimSegment[]>(() =>
    invertRanges(deletedRanges.value, sourceProbeDuration.value)
);

const timelineIsShortened = computed(
    () =>
        showProbeConfig.value &&
        deletedRanges.value.length > 0 &&
        sourceProbeDuration.value > 0
);

const timelineSegments = computed<Segment[]>({
    get: () =>
        timelineIsShortened.value
            ? mapSegmentsToTimeline(editorSegments.value, timelineRanges.value)
            : editorSegments.value,
    set: (next) => {
        editorSegments.value = timelineIsShortened.value
            ? mapSegmentsFromTimeline(next, timelineRanges.value)
            : next;
    },
});

/** The player runs on source time; the timeline may be shorter than that. */
function timelineCurrentTime(): number {
    const t = playerRef.value?.getCurrentTime() ?? 0;
    if (!timelineIsShortened.value) return t;
    // Playback can be inside material the timeline no longer shows; the playhead
    // belongs at the seam, not back at zero.
    return sourceToOutputClamped(t, timelineRanges.value);
}

function timelineSeek(t: number) {
    playerRef.value?.seek(
        timelineIsShortened.value ? outputToSource(t, timelineRanges.value) : t
    );
}

useTrimPlayback({
    ranges: effectiveKeepRanges,
    active: computed(
        () => showProbeConfig.value && effectiveKeepRanges.value.length > 0
    ),
    isPlaying: isPreviewPlaying,
    getCurrentTime: () => playerRef.value?.getCurrentTime() ?? 0,
    seek: (t: number) => playerRef.value?.seek(t),
});

const currentAngleIndex = ref(0);
const copied = ref(false);
const copiedKey = ref(false);
const showFiles = ref(false);
let copyTimeout: ReturnType<typeof setTimeout> | null = null;
let copyKeyTimeout: ReturnType<typeof setTimeout> | null = null;

const displayMasterPlaylist = computed(
    () => poller.masterPlaylist.value ?? session.value?.masterPlaylist
);
const displayAnglePlaylists = computed(
    () => poller.anglePlaylists.value ?? session.value?.anglePlaylists
);
const displayFiles = computed<string[] | undefined>(
    () => (poller.files.value ?? session.value?.files) as string[] | undefined
);
const displayThumbnailsVtt = computed(
    () => poller.thumbnailsVtt.value ?? session.value?.thumbnailsVtt
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
    uniqueAnglePlaylists.value.map((ap, i) => ({ value: i, label: ap.name }))
);

const currentAngleIsAudioOnly = computed(() => {
    const lists = uniqueAnglePlaylists.value;
    if (!lists.length) return false;
    return lists[currentAngleIndex.value]?.name === 'Audio only';
});

const isAudioOnly = computed(
    () => encodingType.value === 'audio' || currentAngleIsAudioOnly.value
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
    // Before the encode there is no storyboard in S3 — the encode is what writes
    // one. The API generates a storyboard for the source instead, so the trim
    // timeline has frames while the user is still choosing what to keep.
    if (showProbeConfig.value) {
        if (!encodingApiUrl.value || !sessionToken.value) return null;
        return (
            `${encodingApiUrl.value}/api/sessions/${sessionId.value}` +
            `/thumbnails/thumbnails.vtt?token=${encodeURIComponent(sessionToken.value)}`
        );
    }
    if (!displayThumbnailsVtt.value || !s3PublicBaseUrl.value) return null;
    return `${s3PublicBaseUrl.value}/${displayThumbnailsVtt.value}`;
});

const shouldCollapseFiles = computed(
    () => (displayFiles.value?.length ?? 0) > 10
);

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
    copyTimeout = setTimeout(() => {
        copied.value = false;
    }, 2000);
}

async function copyEncryptionKey() {
    if (!encryptionKeyHex.value) return;
    await navigator.clipboard.writeText(encryptionKeyHex.value);
    copiedKey.value = true;
    if (copyKeyTimeout) clearTimeout(copyKeyTimeout);
    copyKeyTimeout = setTimeout(() => {
        copiedKey.value = false;
    }, 2000);
}

// ---------------------------------------------------------------------------
// Delete session
// ---------------------------------------------------------------------------

const deleting = ref(false);

const hasS3Files = computed(
    () =>
        !!session.value?.s3ConfigId &&
        !!(session.value?.s3Config?.pathPrefix || session.value?.files?.length)
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
        error.value = errorMessage(e);
    } finally {
        deleting.value = false;
    }
}

// ---------------------------------------------------------------------------
// Move + rename output files (post-encode)
// ---------------------------------------------------------------------------

const {
    showMoveForm,
    moving,
    moveError,
    selectedTargetConfigId,
    moveNewPrefix,
    movePrefixWarning,
    moveConfirmedOverwrite,
    checkingMovePrefix,
    moveTargetS3SelectOptions,
    openMoveForm,
    checkMovePrefix,
    canMove,
    confirmMove,
    showRenameForm,
    renaming,
    renameError,
    renameNewPrefix,
    renamePrefixWarning,
    renameConfirmedOverwrite,
    checkingRenamePrefix,
    openRenameForm,
    checkRenamePrefix,
    canRename,
    confirmRename,
} = useSessionFileOps({
    getAccessToken: () => getAccessTokenSilently(),
    sessionId,
    session,
    refresh: fetchSession,
});

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

        // Kick off waveform fetch (non-critical):
        // - completed sessions read the persisted sidecar via the SaaS proxy
        // - active pre-encode sessions compute it on-demand from the source
        fetchWaveform();

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
        error.value = errorMessage(e);
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
        (status === 'queued' ||
            status === 'encoding' ||
            status === 'encrypting' ||
            status === 'uploading_to_s3') &&
        isActiveSession.value
    ) {
        // Start poller for encoding progress
        poller.start(
            sessionId.value,
            encodingApiUrl.value!,
            sessionToken.value!
        );
    } else if (
        (status === 'created' || status === 'uploading') &&
        isActiveSession.value &&
        !activeUploads.uploads.value[sessionId.value]
    ) {
        // No client-side upload tracked — ingest is happening server-side
        // (URL download or initiated from another tab). Poller delivers the
        // server-emitted progress events and the eventual flip to 'uploaded'.
        poller.start(
            sessionId.value,
            encodingApiUrl.value!,
            sessionToken.value!
        );
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
            sessionToken.value
        );
        probeResult.value = probe;
        if (probe) {
            encodingType.value = probe.videoTracks.length ? 'video' : 'audio';
        }
    } catch (e) {
        submissionError.value = errorMessage(e);
    } finally {
        probeLoading.value = false;
    }
}

async function pollForProbe(
    apiUrl: string,
    sid: string,
    token: string
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

async function fetchWaveform() {
    // Post-encode: fetch the persisted waveform.json sidecar from S3 via the
    // SaaS proxy. Imported sessions or sessions encoded before the sidecar
    // landed return 404 — the proxy returns null and we silently skip render.
    if (isCompleted.value) {
        try {
            const token = await getAccessTokenSilently();
            const data = await getSessionWaveform(token, sessionId.value);
            waveformPeaks.value = data?.peaks ?? null;
        } catch {
            // Non-critical: waveform is a UX enhancement, don't error the whole view
        }
        return;
    }

    // Pre-encode: compute on-demand from the source file still on the API's disk.
    if (!encodingApiUrl.value || !sessionToken.value) return;
    try {
        const response = await fetch(
            `${encodingApiUrl.value}/api/sessions/${sessionId.value}/waveform?token=${sessionToken.value}`
        );
        if (!response.ok) {
            // Waveform generation may not be available or may fail - don't treat as critical error
            return;
        }
        const data = await response.json();
        waveformPeaks.value = data.peaks ?? null;
    } catch {
        // Non-critical: waveform is a UX enhancement, don't error the whole view
    }
}

// Re-fetch the waveform when a session transitions to completed: the encode
// pipeline writes waveform.json to S3 at the end, so the persisted sidecar
// becomes available exactly when we cross this edge.
watch(isCompleted, (now, prev) => {
    if (now && !prev) {
        fetchWaveform();
    }
});

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
                const timeout = setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Timed out waiting for upload to complete'
                            )
                        ),
                    120_000
                );
                const unwatch = watch(
                    currentStatus,
                    (s) => {
                        if (s === 'uploaded') {
                            clearTimeout(timeout);
                            unwatch();
                            resolve();
                        } else if (s === 'failed') {
                            clearTimeout(timeout);
                            unwatch();
                            reject(new Error('Upload failed'));
                        }
                    },
                    { immediate: true }
                );
            });
        }

        // Strip audioTrackMetadata before sending to API, add trim segments
        const { audioTrackMetadata: _, ...apiConfig } = config;
        const submittedTrims = effectiveKeepRanges.value;
        const submitConfig =
            submittedTrims.length > 0
                ? { ...apiConfig, trimSegments: submittedTrims }
                : apiConfig;
        await startEncode(
            encodingApiUrl.value,
            sessionId.value,
            submitConfig,
            sessionToken.value
        );

        // The trim ranges have now been consumed by the encode. They are markers,
        // not content: they described which parts of the source to keep, and say
        // nothing about the encoded result. Drop them rather than leaving source
        // positions drawn over a timeline that no longer matches them.
        if (submittedTrims.length > 0) {
            editorSegments.value = [];
            trimDeletions.clear();
        }

        // Save config for future reuse (strip trimSegments — session-specific)
        if (probeResult.value) {
            const layoutKey = computeLayoutKey(probeResult.value, config.type);
            saveConfig(layoutKey, config);
        }

        // Reload preview with filtered playlist when trim segments are active
        if (
            trimSegments.value.length > 0 &&
            playerRef.value &&
            previewPlaybackUrl.value
        ) {
            playerRef.value.setSource(previewPlaybackUrl.value);
        }

        // Start polling for encoding progress
        poller.start(sessionId.value, encodingApiUrl.value, sessionToken.value);
    } catch (e) {
        submissionError.value = errorMessage(e);
    } finally {
        submitting.value = false;
    }
}

function onEncodeCanSubmitChange(valid: boolean) {
    encodeConfigCanSubmit.value = valid;
}

async function onStartEncodingFromTrim() {
    submissionError.value = null;
    const cfg =
        outputPanelRef.value?.getEncodeForm()?.buildEncodeConfig() ?? null;
    if (cfg) {
        await onEncodeSubmit(cfg);
    } else {
        encodeSidePanelTab.value = 'encode';
        submissionError.value =
            'Encoding options are incomplete or invalid. Fix any highlighted fields in the Encode settings panel, then click Start Encoding again.';
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
    }
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
                fetchWaveform();
            }
        }
    }
);

// URL-ingest path: no client-side upload entry exists, so the tus-completion
// watch above never fires. Watch the poller's status flip to 'uploaded' and
// fetch probe results from the same handler.
watch(
    () => poller.status.value,
    (status, prev) => {
        if (
            status === 'uploaded' &&
            prev !== 'uploaded' &&
            !probeResult.value
        ) {
            if (encodingApiUrl.value && sessionToken.value) {
                fetchProbeResults();
                fetchWaveform();
            }
        }
    }
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
    }
);

watch(
    [() => sessionId.value, activePlaybackUrl, isExpired],
    async ([id, url, expired]) => {
        if (!id || !url || expired) return;
        if (chapters.isLoaded.value && chapters.loadedSessionId.value === id)
            return;
        try {
            chaptersSaveError.value = null;
            await chapters.load(id);
        } catch (err) {
            chaptersSaveError.value =
                errorMessage(err);
        }
    },
    { immediate: true }
);

async function onSaveChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.saveRemote();
    } catch (err) {
        chaptersSaveError.value =
            errorMessage(err);
    }
}

async function onDiscardChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.discardLocal();
        syncChaptersFromTimeline();
    } catch (err) {
        chaptersSaveError.value =
            errorMessage(err);
    }
}

// Once the encode is submitted the bottom timeline becomes the chapter editor,
// and it stays in step with the chapter list beside the player in both
// directions. Trim markers never take part — see #51.
const { syncChaptersFromTimeline } = useChapterTrimSync({
    editorSegments,
    chapterSegments,
    // Before the encode is submitted the timeline holds trim markers, which have
    // nothing to say about chapters: mirroring stays off so they cannot seed the
    // chapter list, and a chapter sidecar cannot overwrite them. Afterwards the
    // timeline *is* the chapter editor and the two are kept in step.
    mirrorActive: computed(
        () => canEditTrimTimeline.value && !showProbeConfig.value
    ),
    chaptersLoaded: chapters.isLoaded,
});

// ---------------------------------------------------------------------------
// Session workspace — tabs, stepper, activity log
// ---------------------------------------------------------------------------

const activeTab = ref<'trim'>('trim');

/** Sub-tab within the aside panel when encode config is shown (pre-encode). */
const encodeSidePanelTab = ref<'encode' | 'chapters'>('encode');

/** Sub-tab within the aside panel during active encoding. */
const encodingAsideTab = ref<'progress' | 'chapters'>('progress');

const trimTimelineWorkspaceRef = ref<InstanceType<
    typeof SessionTrimWorkspace
> | null>(null);

watch(
    () => [activeTab.value, showTrimSegmentEditor.value] as const,
    async ([tab, showTrim]) => {
        if (tab !== 'trim' || !showTrim) return;
        await nextTick();
        trimTimelineWorkspaceRef.value?.focusSegmentEditor?.();
    }
);

const showAside = computed(
    () =>
        activeTab.value === 'trim' &&
        (showProbeConfig.value ||
            showChaptersBesidePlayer.value ||
            showEncoding.value ||
            isCompleted.value)
);

/** Chapter card is shown whenever we have a duration to work with, regardless of playback URL. */
const showChaptersBesidePlayer = computed(
    () =>
        !!session.value &&
        !isExpired.value &&
        currentStatus.value !== 'failed' &&
        chaptersSidePanelDuration.value > 0 &&
        canEditChaptersPlayback.value
);

/**
 * Chapters become persistable only once an encode has been submitted. Before that
 * the timeline holds trim markers: ephemeral ranges that decide what gets encoded
 * when Start Encoding is pressed, and are meaningless afterwards. Offering to save
 * them would write that throwaway state to S3 as the session's chapters.vtt.
 */
const canSaveChapters = computed(
    () =>
        showChaptersBesidePlayer.value &&
        !showProbeConfig.value &&
        // showProbeConfig also goes false while the encode request is in flight,
        // which would flash the save controls back on during exactly the phase
        // this is meant to cover.
        !submitting.value
);

/** Detail card: only visible during pre-encode upload/probe flow (progress below the player). */
const showSessionDetailCard = computed(
    () =>
        showSessionWorkflowPanel.value &&
        !showProbeConfig.value &&
        !showEncoding.value &&
        !isCompleted.value
);

const sessionDetailChromeCollapsed = computed(() => false);

const sessionDetailCardSurfaceClass = computed(
    () =>
        'rounded-xl border border-slate-200/90 bg-white/90 p-3 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur sm:p-4 dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10'
);

/** Wide container for trim tab — fills available width up to 96rem with standard padding. */
const trimPlayerBreakoutClass = computed(() => {
    if (activeTab.value !== 'trim' || !showTrimSegmentEditor.value) {
        return '';
    }
    return 'w-full max-w-[96rem] mx-auto px-4 sm:px-6';
});

/** Primary editing tab: timeline + trim before encode; chapters after. */
const trimTabLabel = computed(() => (isCompleted.value ? 'Chapters' : 'Trim'));

// Lock page scroll and fix header max-width to the trim layout (single view now).
watch(
    () => activeTab.value,
    (tab) => {
        document.documentElement.style.overflowY =
            tab === 'trim' ? 'hidden' : '';
        setHeaderLayout(tab === 'trim' ? 'session-trim' : 'session');
    },
    { immediate: true }
);

/** Sub-tab within the aside panel after encoding completes. */
const completedAsideTab = ref<'chapters' | 'delivery'>('chapters');

// Reset aside sub-tab back to encode settings when probe config becomes available again.
watch(showProbeConfig, (ready) => {
    if (ready) encodeSidePanelTab.value = 'encode';
});

function relativeCreatedLabel(dateStr: string | null | undefined): string {
    if (!dateStr) return '';
    return `Created ${formatRelative(dateStr)}`;
}

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
    setHeaderLayout('default');
});
</script>

<template>
    <div
        :class="
            headerLayout === 'session-trim'
                ? 'flex h-full w-full flex-col'
                : 'flex min-h-dvh w-full max-w-none flex-col'
        "
    >
        <div
            class="w-full flex-1 transition-all duration-300"
            :class="
                session && !loading && activeTab === 'trim'
                    ? 'flex flex-1 flex-col min-h-0'
                    : 'pb-8 pt-4'
            "
        >
            <div
                v-if="loading"
                class="flex justify-center rounded-2xl border border-slate-200/90 bg-white/90 py-16 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
            >
                <svg
                    class="h-8 w-8 animate-spin text-slate-500 dark:text-slate-400"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <circle
                        class="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="4"
                    />
                    <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                </svg>
            </div>

            <div
                v-else-if="error"
                class="rounded-2xl border border-red-300 bg-red-50 p-4 dark:border-red-800/50 dark:bg-red-950/30"
            >
                <p class="text-sm text-red-800 dark:text-red-300">
                    {{ error }}
                </p>
            </div>

            <template v-else-if="session">
                <!--
                    Header teleport keeps the back-arrow only — title, created
                    label, and status badge now sit under the player (rendered
                    via the SessionPlayerStrip #below-player slot below).
                -->
                <Teleport to="#app-session-meta-teleport">
                    <router-link
                        to="/sessions"
                        class="inline-flex shrink-0 items-center justify-center rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        title="Back to sessions"
                    >
                        <svg
                            class="h-6 w-6"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2.25"
                            aria-hidden="true"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M15 19l-7-7 7-7"
                            />
                        </svg>
                        <span class="sr-only">Back to sessions</span>
                    </router-link>
                </Teleport>

                <!--
                    Expired: card centered vertically + horizontally in the
                    remaining viewport. Uses min-h-[70dvh] so it sits in the
                    middle whether or not the parent gives this branch a fixed
                    height (App.vue's main switches between full-height and
                    constrained layouts depending on tab).
                -->
                <div
                    v-if="isExpired"
                    class="flex min-h-[70dvh] w-full items-center justify-center px-4 py-10"
                >
                    <div
                        class="w-full max-w-md rounded-2xl border border-slate-200/90 bg-white/90 p-8 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
                    >
                        <div
                            class="flex flex-col items-center gap-4 text-center"
                        >
                            <div
                                class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800/80"
                            >
                                <svg
                                    class="h-6 w-6 text-slate-600 dark:text-slate-300"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    stroke-width="1.5"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                                    />
                                </svg>
                            </div>
                            <h2
                                class="text-base font-semibold text-slate-800 dark:text-slate-100"
                            >
                                Session expired
                            </h2>
                            <p
                                class="text-xs text-slate-500 dark:text-slate-400"
                            >
                                The encoding session is no longer active and
                                cannot be interacted with.
                            </p>
                            <div
                                class="mt-2 grid w-full grid-cols-2 gap-3 text-left"
                            >
                                <div
                                    class="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
                                >
                                    <p
                                        class="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
                                    >
                                        Status
                                    </p>
                                    <p
                                        class="text-sm text-slate-800 dark:text-slate-200"
                                    >
                                        {{ statusLabel(session.status) }}
                                    </p>
                                </div>
                                <div
                                    class="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60"
                                >
                                    <p
                                        class="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
                                    >
                                        Created
                                    </p>
                                    <p
                                        class="text-sm text-slate-800 dark:text-slate-200"
                                    >
                                        {{ formatDateTime(session.createdAt) }}
                                    </p>
                                </div>
                            </div>
                            <div
                                class="mt-2 flex w-full flex-col gap-2 sm:flex-row"
                            >
                                <button
                                    type="button"
                                    class="flex-1 cursor-pointer rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                    @click="router.push('/sessions')"
                                >
                                    Back to sessions
                                </button>
                                <button
                                    type="button"
                                    class="flex-1 cursor-pointer rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-500 dark:bg-sky-700 dark:hover:bg-sky-600"
                                    @click="router.push('/sessions/new')"
                                >
                                    New session
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Main column -->
                <div
                    v-else
                    :class="[
                        'min-w-0 flex flex-col',
                        activeTab === 'trim' ? 'flex-1 min-h-0' : 'space-y-5',
                    ]"
                >
                    <!-- On trim: flex order shows progress card above player; player fills remaining height.
                         Hidden during pure upload/probe-loading state so the centered upload card can use the full viewport. -->
                    <div
                        v-if="!showSessionDetailCard"
                        :class="[
                            'min-w-0 flex flex-col',
                            activeTab === 'trim'
                                ? 'order-2 flex-1 min-h-0'
                                : '',
                        ]"
                    >
                        <SessionPlayerStrip
                            ref="sessionPlayerStripRef"
                            class="flex-1 min-h-0"
                            :active-playback-url="activePlaybackUrl"
                            :is-completed="isCompleted"
                            :thumbnail-vtt-url="thumbnailVttUrl"
                            :encoding-type="encodingType"
                            :is-audio-only="isAudioOnly"
                            :encryption-key-hex="encryptionKeyHex"
                            :poller-encryption-key-hex="
                                poller.encryptionKeyHex.value ?? undefined
                            "
                            :show-aside="showAside"
                            :active-tab="activeTab"
                            :show-angle-switcher="showAngleSwitcher"
                            :unique-angle-playlists="uniqueAnglePlaylists"
                            :current-angle-index="currentAngleIndex"
                            :show-audio-select="previewAudioTracks.length > 1"
                            :preview-audio-select-options="
                                previewAudioSelectOptions
                            "
                            :show-quality-select="
                                previewQualityLevels.length >= 1 &&
                                encodingType !== 'audio'
                            "
                            :preview-quality-select-options="
                                previewQualitySelectOptions
                            "
                            v-model:selected-audio-track="selectedAudioTrack"
                            v-model:selected-quality-id="selectedQualityId"
                            @update:selected-quality-id="onTrimQualityChange"
                            @quality-levels="onPreviewQualityLevels"
                            @playing-change="isPreviewPlaying = $event"
                            @duration-change="playerDuration = $event"
                            @audio-tracks="onNativeAudioTracks"
                            @angle-change="switchToAngle"
                        >
                            <!--
                                    Session title + status + relative created label,
                                    shown directly under the player so the page
                                    header stays minimal (just the back arrow).
                                    Clicking the title swaps in an inline rename
                                    field (Enter to save, Esc to cancel).
                                -->
                            <template #below-player>
                                <div
                                    v-if="editingName"
                                    class="flex min-w-0 flex-wrap items-center gap-2"
                                >
                                    <input
                                        v-model="nameInput"
                                        type="text"
                                        class="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-base font-semibold text-slate-800 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                                        placeholder="Session name"
                                        autofocus
                                        @keyup.enter="saveName"
                                        @keyup.escape="cancelEditName"
                                    />
                                    <button
                                        type="button"
                                        class="cursor-pointer rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
                                        :disabled="savingName"
                                        @click="saveName"
                                    >
                                        {{ savingName ? '…' : 'Save' }}
                                    </button>
                                    <button
                                        type="button"
                                        class="cursor-pointer rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
                                        @click="cancelEditName"
                                    >
                                        Cancel
                                    </button>
                                </div>
                                <div
                                    v-else
                                    class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                                >
                                    <button
                                        type="button"
                                        class="min-w-0 truncate text-base font-semibold text-slate-800 transition-colors hover:text-slate-600 dark:text-slate-100 dark:hover:text-slate-300 cursor-pointer"
                                        :title="
                                            sessionName
                                                ? 'Click to rename'
                                                : 'Click to add a name'
                                        "
                                        @click="startEditName"
                                    >
                                        {{ sessionName || 'Untitled session' }}
                                    </button>
                                    <StatusBadge
                                        v-if="currentStatus"
                                        class="shrink-0"
                                        :label="statusLabel(currentStatus)"
                                        :color="
                                            statusColors[currentStatus]?.color
                                        "
                                        :border-color="
                                            statusColors[currentStatus]
                                                ?.borderColor
                                        "
                                    />
                                    <span
                                        v-if="session?.createdAt"
                                        class="shrink-0 text-xs text-slate-500 dark:text-slate-400"
                                    >
                                        {{
                                            relativeCreatedLabel(
                                                session.createdAt
                                            )
                                        }}
                                    </span>
                                </div>
                            </template>

                            <template #aside>
                                <!-- Tab switcher: pre-encode (Encode settings / Chapters) -->
                                <div
                                    v-if="
                                        showProbeConfig &&
                                        showChaptersBesidePlayer
                                    "
                                    class="shrink-0 flex gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            encodeSidePanelTab === 'encode'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="encodeSidePanelTab = 'encode'"
                                    >
                                        Encode settings
                                    </button>
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            encodeSidePanelTab === 'chapters'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="encodeSidePanelTab = 'chapters'"
                                    >
                                        Clips
                                    </button>
                                </div>

                                <!-- Tab switcher: encoding phase (Progress / Chapters) — hidden once completed -->
                                <div
                                    v-if="
                                        showEncoding && showChaptersBesidePlayer
                                    "
                                    class="shrink-0 flex gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            encodingAsideTab === 'progress'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="encodingAsideTab = 'progress'"
                                    >
                                        Progress
                                    </button>
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            encodingAsideTab === 'chapters'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="encodingAsideTab = 'chapters'"
                                    >
                                        Chapters
                                    </button>
                                </div>

                                <!-- Encoding progress panel -->
                                <div
                                    v-if="
                                        showEncoding &&
                                        (!showChaptersBesidePlayer ||
                                            encodingAsideTab === 'progress')
                                    "
                                    class="min-h-0 flex-1 overflow-y-auto space-y-3"
                                >
                                    <div
                                        v-if="
                                            poller.status.value === 'queued' &&
                                            poller.queuePosition.value != null
                                        "
                                        class="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-400 inline-block"
                                    >
                                        Queue position #{{
                                            poller.queuePosition.value
                                        }}
                                    </div>
                                    <p
                                        v-if="etaDisplay"
                                        class="text-right text-xs text-slate-500"
                                    >
                                        {{ etaDisplay }}
                                    </p>
                                    <div
                                        class="space-y-3 rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-3 dark:border-slate-700/50 dark:bg-slate-800/30"
                                    >
                                        <ProgressBar
                                            label="Encoding"
                                            :progress="
                                                poller.pipelineProgress.value
                                                    ?.encoding ??
                                                poller.progress.value
                                            "
                                        />
                                        <ProgressBar
                                            v-if="
                                                poller.pipelineProgress.value
                                                    ?.encrypting != null
                                            "
                                            label="Encrypting"
                                            :progress="
                                                poller.pipelineProgress.value
                                                    .encrypting
                                            "
                                        />
                                        <ProgressBar
                                            v-if="
                                                poller.pipelineProgress.value
                                                    ?.uploading != null
                                            "
                                            label="S3 upload"
                                            :progress="
                                                poller.pipelineProgress.value
                                                    .uploading
                                            "
                                        />
                                    </div>
                                    <div
                                        v-if="
                                            poller.status.value === 'queued' ||
                                            poller.status.value ===
                                                'encoding' ||
                                            poller.status.value === 'encrypting'
                                        "
                                    >
                                        <button
                                            type="button"
                                            class="cursor-pointer rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40"
                                            @click="onCancelEncode"
                                        >
                                            Cancel encoding
                                        </button>
                                    </div>
                                </div>

                                <!--
                                    Encode config panel — hidden rather than
                                    unmounted when the aside shows another tab.
                                    Start Encoding reads the config straight off
                                    this form, so unmounting it made a perfectly
                                    valid config look invalid to anyone who
                                    started their encode from the Clips tab.
                                -->
                                <div
                                    v-if="showProbeConfig"
                                    v-show="
                                        !showChaptersBesidePlayer ||
                                        encodeSidePanelTab === 'encode'
                                    "
                                    class="min-h-0 flex-1 overflow-y-auto"
                                >
                                    <SessionOutputPanel
                                        ref="outputPanelRef"
                                        :show-probe-config="showProbeConfig"
                                        :probe-result="probeResult"
                                        :byte-range-enabled="byteRangeEnabled"
                                        encode-primary-action="start-encoding"
                                        appearance="session"
                                        @submit="onEncodeSubmit"
                                        @can-submit-change="
                                            onEncodeCanSubmitChange
                                        "
                                    />
                                </div>

                                <!-- Tab switcher: completed phase (Chapters / Delivery) -->
                                <div
                                    v-if="
                                        isCompleted && showChaptersBesidePlayer
                                    "
                                    class="shrink-0 flex gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-slate-700 dark:bg-slate-800/50"
                                >
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            completedAsideTab === 'chapters'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="completedAsideTab = 'chapters'"
                                    >
                                        Chapters
                                    </button>
                                    <button
                                        type="button"
                                        class="flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                                        :class="
                                            completedAsideTab === 'delivery'
                                                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                                                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                                        "
                                        @click="completedAsideTab = 'delivery'"
                                    >
                                        Delivery
                                    </button>
                                </div>

                                <!-- Chapter list panel -->
                                <div
                                    v-if="
                                        showChaptersBesidePlayer &&
                                        (!showProbeConfig ||
                                            encodeSidePanelTab ===
                                                'chapters') &&
                                        (!showEncoding ||
                                            encodingAsideTab === 'chapters') &&
                                        (!isCompleted ||
                                            completedAsideTab === 'chapters')
                                    "
                                    class="min-h-0 flex-1 flex flex-col overflow-hidden"
                                >
                                    <SegmentEditor
                                        ref="chapterSegmentEditorRef"
                                        v-model="asidePanelSegments"
                                        class="min-h-0 flex-1 overflow-hidden"
                                        mode="chapters"
                                        split-list-panel
                                        :duration="chaptersSidePanelDuration"
                                        :get-current-time="
                                            () =>
                                                playerRef?.getCurrentTime() ?? 0
                                        "
                                        :on-seek="
                                            (t: number) => playerRef?.seek(t)
                                        "
                                        :on-play-pause="
                                            () => playerRef?.togglePlay()
                                        "
                                        :is-playing="isPreviewPlaying"
                                        :ripple-edit="false"
                                        :show-timeline="false"
                                        :show-toolbar="false"
                                        :show-playback-controls="false"
                                        :show-help="false"
                                        :read-only="showProbeConfig"
                                        :title="
                                            showProbeConfig
                                                ? 'Clips'
                                                : 'Chapters'
                                        "
                                        :empty-title="
                                            showProbeConfig
                                                ? 'No clips yet'
                                                : 'No chapters yet'
                                        "
                                        :empty-hint="
                                            showProbeConfig
                                                ? 'Use the timeline below to add in/out marks for the ranges you want to keep. If nothing is selected, it will take the whole timline '
                                                : 'Use the trim timeline below to add in/out marks, or load chapters from a VTT sidecar.'
                                        "
                                        keyboard-scope="focus"
                                        :fps="segmentEditorProbeFps"
                                    />
                                    <!-- Clips removed from the encode: dropped from
                                         the timeline, restorable until Start Encoding -->
                                    <div
                                        v-if="removedTrimSegments.length > 0"
                                        class="shrink-0 mt-3 rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-800/50"
                                    >
                                        <div class="mb-2 flex items-center justify-between gap-2">
                                            <span class="text-xs font-medium text-slate-600 dark:text-slate-300">
                                                Removed ({{ removedTrimSegments.length }})
                                            </span>
                                            <button
                                                v-if="removedTrimSegments.length > 1"
                                                type="button"
                                                class="chapter-toolbar-muted"
                                                @click="trimDeletions.restoreAll"
                                            >Restore all</button>
                                        </div>
                                        <ul class="max-h-40 space-y-1 overflow-y-auto">
                                            <li
                                                v-for="seg in removedTrimSegments"
                                                :key="seg.id"
                                                class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1 dark:bg-slate-900/40"
                                            >
                                                <span class="font-mono text-xs text-slate-600 dark:text-slate-300">
                                                    {{ formatTime(seg.inSec) }} – {{ formatTime(seg.outSec) }}
                                                </span>
                                                <button
                                                    type="button"
                                                    class="chapter-toolbar-muted"
                                                    @click="trimDeletions.restore(seg.id)"
                                                >Undo</button>
                                            </li>
                                        </ul>
                                    </div>

                                    <p
                                        v-if="chaptersSaveError"
                                        class="shrink-0 text-xs text-red-600 dark:text-red-400"
                                    >
                                        {{ chaptersSaveError }}
                                    </p>
                                </div>

                                <!-- Delivery panel (post-encode, in aside) -->
                                <div
                                    v-if="
                                        isCompleted &&
                                        completedAsideTab === 'delivery'
                                    "
                                    class="min-h-0 flex-1 overflow-y-auto"
                                >
                                    <SessionPostProcessPanel
                                        v-model:show-files="showFiles"
                                        v-model:selected-target-config-id="
                                            selectedTargetConfigId
                                        "
                                        v-model:move-new-prefix="moveNewPrefix"
                                        v-model:move-confirmed-overwrite="
                                            moveConfirmedOverwrite
                                        "
                                        v-model:rename-new-prefix="
                                            renameNewPrefix
                                        "
                                        v-model:rename-confirmed-overwrite="
                                            renameConfirmedOverwrite
                                        "
                                        :is-completed="isCompleted"
                                        :is-terminal="isTerminal"
                                        :current-status="currentStatus"
                                        :display-master-playlist="
                                            displayMasterPlaylist
                                        "
                                        :s3-url="s3Url"
                                        :copied="copied"
                                        :is-encrypted="isEncrypted"
                                        :encryption-key-hex="encryptionKeyHex"
                                        :copied-key="copiedKey"
                                        :display-files="displayFiles"
                                        :should-collapse-files="
                                            shouldCollapseFiles
                                        "
                                        :session="session"
                                        :has-s3-files="hasS3Files"
                                        :show-move-form="showMoveForm"
                                        :show-rename-form="showRenameForm"
                                        :move-target-s3-select-options="
                                            moveTargetS3SelectOptions
                                        "
                                        :move-prefix-warning="movePrefixWarning"
                                        :move-error="moveError"
                                        :can-move="canMove"
                                        :moving="moving"
                                        :rename-prefix-warning="
                                            renamePrefixWarning
                                        "
                                        :rename-error="renameError"
                                        :can-rename="canRename"
                                        :renaming="renaming"
                                        @copy-playback-url="copyPlaybackUrl"
                                        @copy-encryption-key="copyEncryptionKey"
                                        @copy-output-object-key="
                                            copyOutputObjectKey
                                        "
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
                            </template>
                        </SessionPlayerStrip>

                        <Teleport to="#app-session-workflow-teleport">
                            <!-- Start Encoding button (pre-encode only) -->
                            <button
                                v-if="showProbeConfig"
                                type="button"
                                class="cursor-pointer rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600 sm:px-3 sm:py-1.5 sm:text-xs"
                                :disabled="!encodeConfigCanSubmit || submitting"
                                :title="
                                    !encodeConfigCanSubmit && !submitting
                                        ? 'Open Encode settings and complete the ladder (all required options) first.'
                                        : undefined
                                "
                                @click="onStartEncodingFromTrim"
                            >
                                {{
                                    submitting ? 'Starting…' : 'Start encoding'
                                }}
                            </button>
                        </Teleport>
                    </div>

                    <SessionTrimWorkspace
                        ref="trimTimelineWorkspaceRef"
                        v-if="activeTab === 'trim' && showTrimSegmentEditor"
                        class="order-3 shrink-0"
                        section="timeline"
                        v-model:editor-segments="timelineSegments"
                        :show-chapters-side-panel="showChaptersBesidePlayer"
                        :can-save-chapters="canSaveChapters"
                        :chapters-is-dirty="chapters.isDirty.value"
                        :chapters-is-saving="chapters.isSaving.value"
                        :chapters-save-error="chaptersSaveError"
                        :show-trim-segment-editor="showTrimSegmentEditor"
                        :thumbnail-vtt-url="thumbnailVttUrl"
                        :waveform-peaks="timelineWaveformPeaks"
                        @segment-removed="onTimelineSegmentRemoved"
                        :is-completed="isCompleted"
                        :probe-duration="trimEditorProbeDuration"
                        :add-gap-above-timeline="false"
                        :get-current-time="timelineCurrentTime"
                        :on-seek="timelineSeek"
                        :on-play-pause="() => playerRef?.togglePlay()"
                        :is-preview-playing="isPreviewPlaying"
                        :segment-editor-probe-fps="segmentEditorProbeFps"
                        @discard-chapters="onDiscardChapters"
                        @save-chapters="onSaveChapters"
                    />

                    <div
                        v-if="showSessionDetailCard"
                        class="order-1 flex w-full flex-1 flex-col"
                    >
                        <!-- Upload / probe progress (pre-encode only) — centered card in the viewport. -->
                        <div
                            class="flex w-full flex-1 items-center justify-center px-4 py-10 sm:px-6 min-h-[70dvh]"
                        >
                            <div
                                :class="[
                                    sessionDetailCardSurfaceClass,
                                    'w-full max-w-lg',
                                ]"
                            >
                                <SessionWorkflowPanel
                                    :show-probe-config="showProbeConfig"
                                    :submitting="submitting"
                                    :show-encoding="showEncoding"
                                    :is-completed="isCompleted"
                                    :current-status="currentStatus"
                                    :show-upload-progress="showUploadProgress"
                                    :show-upload-done-waiting="
                                        showUploadDoneWaiting
                                    "
                                    :show-upload-remote-message="
                                        showUploadRemoteMessage
                                    "
                                    :active-upload-progress="
                                        activeUpload?.progress
                                    "
                                    :active-upload-can-cancel="
                                        activeUpload
                                            ? activeUpload.progress < 100
                                            : false
                                    "
                                    :remote-ingest-progress="
                                        remoteIngestProgress
                                    "
                                    :remote-ingest-label="remoteIngestLabel"
                                    :ingest-eta-display="ingestEtaDisplay"
                                    :poller-ingest-total-bytes="
                                        poller.ingestTotalBytes.value
                                    "
                                    :probe-loading="probeLoading"
                                    :session-error="session?.error"
                                    :encoder-label="displayEncoderLabel"
                                    :display-segment-format="
                                        displaySegmentFormat
                                    "
                                    :encoding-type="encodingType"
                                    :eta-display="etaDisplay"
                                    :poller-status="poller.status.value"
                                    :poller-queue-position="
                                        poller.queuePosition.value
                                    "
                                    :pipeline-encoding="
                                        poller.pipelineProgress.value
                                            ?.encoding ?? poller.progress.value
                                    "
                                    :pipeline-encrypting="
                                        poller.pipelineProgress.value
                                            ?.encrypting
                                    "
                                    :pipeline-uploading="
                                        poller.pipelineProgress.value?.uploading
                                    "
                                    :poller-progress="poller.progress.value"
                                    :poller-error="poller.error.value"
                                    :is-encrypted="isEncrypted"
                                    :imported-session="!!session?.imported"
                                    @switch-tab="completedAsideTab = 'delivery'"
                                    @cancel-upload="cancelUpload"
                                    @cancel-encode="onCancelEncode"
                                />
                            </div>
                        </div>

                        <!-- Chapter-only toolbar when trim timeline is not mounted -->
                        <SessionTrimWorkspace
                            v-show="!showTrimSegmentEditor"
                            section="toolbar"
                            v-model:editor-segments="editorSegments"
                            :show-chapters-side-panel="showChaptersBesidePlayer"
                            :can-save-chapters="canSaveChapters"
                            :chapters-is-dirty="chapters.isDirty.value"
                            :chapters-is-saving="chapters.isSaving.value"
                            :chapters-save-error="chaptersSaveError"
                            :show-trim-segment-editor="showTrimSegmentEditor"
                            :thumbnail-vtt-url="thumbnailVttUrl"
                            :waveform-peaks="timelineWaveformPeaks"
                                @segment-removed="onTimelineSegmentRemoved"
                                    :is-completed="isCompleted"
                            :can-edit-trim-timeline="canEditTrimTimeline"
                            :can-edit-chapters-playback="
                                canEditChaptersPlayback
                            "
                            :probe-duration="trimEditorProbeDuration"
                            :get-current-time="
                                () => playerRef?.getCurrentTime() ?? 0
                            "
                            :on-seek="(t: number) => playerRef?.seek(t)"
                            :on-play-pause="() => playerRef?.togglePlay()"
                            :is-preview-playing="isPreviewPlaying"
                            :segment-editor-probe-fps="segmentEditorProbeFps"
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
                class="fixed top-4 right-4 z-60 flex max-w-md items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-lg shadow-red-900/10 sm:top-6 sm:right-6 dark:border-red-800/60 dark:bg-red-950/90 dark:text-red-100 dark:shadow-black/40"
            >
                <svg
                    class="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
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
    transition:
        opacity 0.18s ease,
        transform 0.18s ease;
}
.session-toast-enter-from,
.session-toast-leave-to {
    opacity: 0;
    transform: translate(6px, -6px);
}
</style>
