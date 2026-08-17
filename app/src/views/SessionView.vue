<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
    computeLayoutKey,
    saveConfig,
} from '@luminary-media-converter/encode-config';
import type {
    ProbeResult,
    EncodeConfig,
    TrimSegment,
    TrimCopyMode,
} from '@luminary-media-converter/encode-config';
import {
    SegmentEditor,
    formatTime,
} from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import {
    useChapters,
    clearChapterDraftForSession,
} from '../composables/useChapters';
import FileDropZone from '../components/FileDropZone.vue';
import ProgressBar from '../components/ProgressBar.vue';
import StatusBadge from '../components/StatusBadge.vue';
import AccountMenu from '../components/AccountMenu.vue';
import DeleteSessionModal from '../components/DeleteSessionModal.vue';
import SessionOutputPanel from '../components/session-view/SessionOutputPanel.vue';
import SessionPlayerStrip from '../components/session-view/SessionPlayerStrip.vue';
import SessionTopline from '../components/session-view/SessionTopline.vue';
import SessionTrimWorkspace from '../components/session-view/SessionTrimWorkspace.vue';
import SessionWorkflowPanel from '../components/session-view/SessionWorkflowPanel.vue';
import {
    API_BASE,
    getSession,
    getSessionKey,
    getSessionStatus,
    ingestLocalFile,
    listSessions,
    startEncode,
    deleteSession,
} from '../api';
import {
    forgetSessionToken,
    getSessionToken,
    setSessionToken,
} from '../session-tokens';
import { useSessionPoller } from '../composables/useSessionPoller';
import { useStoryboard } from '../composables/useStoryboard';
import { useStoryboardVttUrl } from '../composables/useStoryboardVttUrl';
import { useAppLayout } from '../composables/useAppLayout';
import { useEncodeEta } from '../composables/useEncodeEta';
import { useChapterTrimSync } from '../composables/useChapterTrimSync';
import { useTrimDeletions } from '../composables/useTrimDeletions';
import { useTrimPlayback } from '../composables/useTrimPlayback';
import {
    invertRanges,
    mapSegmentsFromTimeline,
    mapSegmentsToTimeline,
    outputToSource,
    slicePeaksToTrims,
    sourceToOutputClamped,
    toOutputSegments,
    trimmedDuration,
} from '../utils/trimTimeline';
import type {
    AccelMode,
    PipelinePhase,
    SegmentFormat,
    SessionStatusResponse,
    SessionSummary,
} from '../types';
import { formatBytes, formatRelative } from '../utils/format';
import { unmaskSessionKey } from '../utils/keyMask';
import { errorMessage } from '../utils/errors';
import { statusLabel } from '../utils/status';

const route = useRoute();
const router = useRouter();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const session = ref<SessionStatusResponse | null>(null);
/**
 * The session's row in `GET /api/sessions`. It is the only place the creation
 * time and the session token are published, so the detail view reads it even
 * though the status response covers everything else.
 */
const summary = ref<SessionSummary | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const notFound = ref(false);
const submissionError = ref<string | null>(null);

const sessionToken = ref<string | null>(null);

// Probe/encode state
const probeResult = ref<ProbeResult | null>(null);
const probeLoading = ref(false);
const encodingType = ref<'video' | 'audio'>('video');
/**
 * Whether the output uses byte-range HLS. Reported by the encoder, because the
 * CMS fixes it at session creation and nothing here can change it. It used to
 * be pinned to the API default, which was a guess that happened to be right.
 */
const byteRangeEnabled = computed(
    () => session.value?.byteRange ?? true,
);
const submitting = ref(false);
const waveformPeaks = ref<number[] | null>(null);
const editorSegments = ref<Segment[]>([]);
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

/**
 * How a trim would be cut with the ladder as it currently stands, derived by
 * the form from its copy checkboxes. Only meaningful once something has been
 * cut, which is the same condition the API infers the mode under.
 */
const trimCopyMode = ref<TrimCopyMode>('precise');

// Chapter editor — sidecar VTT in S3, autosaves to localStorage, explicit save to S3.
const chapters = useChapters({
    getSessionToken: () => sessionToken.value ?? '',
});
const chapterSegments = chapters.segments;
const chaptersSaveError = ref<string | null>(null);
const cancelError = ref<string | null>(null);

// Playback duration as reported by the player — the only correct source for
// the chapter timeline since it reflects trim cuts on encoded output.
const playerDuration = ref<number | null>(null);

/** Duration for the beside-player chapters panel (player > probe). */
const chaptersSidePanelDuration = computed(() => {
    const pd = playerDuration.value;
    if (pd != null && pd > 0) return pd;
    const pr = probeResult.value?.format?.duration;
    if (typeof pr === 'number' && pr > 0) return pr;
    const sp = session.value?.probeResult?.format?.duration;
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

/**
 * Session title. It belongs to the CMS document the session was opened for, so
 * it is displayed and never edited here.
 */
const sessionName = computed(
    () => session.value?.title ?? summary.value?.title ?? ''
);

/**
 * The session's AES-128 key, once asked for.
 *
 * It no longer rides along on status reads or the event stream: it is served
 * masked from its own endpoint and unmasked here, in memory, on the way to the
 * player. `keyFetched` says the question has been put — a session with no
 * encryption answers 404, so "no key" is an answer rather than a gap.
 */
const encryptionKeyHex = ref<string | undefined>();
const keyFetched = ref(false);

const sessionId = computed(() => route.params.id as string);

const poller = useSessionPoller();
const { setHeaderLayout, headerLayout } = useAppLayout();

// ---------------------------------------------------------------------------
// Status badge config
// ---------------------------------------------------------------------------

// Status text/border colors for the badge under the player. Labels live in
// utils/status.ts (shared with the session list); colors stay local because the
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

// Poller status leads while it runs; the loaded status covers the rest.
const pollerStatus = computed(() => poller.status.value);
const sessionDocStatus = computed(() => session.value?.status ?? null);

const currentStatus = computed<string | null>(() => {
    return pollerStatus.value ?? sessionDocStatus.value;
});

/** Every session on this instance is live — a token is all that is needed to drive it. */
const isActiveSession = computed(() => !!sessionToken.value);

const isTerminal = computed(() => {
    const ps = pollerStatus.value;
    const ss = sessionDocStatus.value;
    return (
        ps === 'completed' ||
        ps === 'failed' ||
        ss === 'completed' ||
        ss === 'failed'
    );
});

const isCompleted = computed(() => {
    return pollerStatus.value === 'completed' || sessionDocStatus.value === 'completed';
});

const isEncrypted = computed(() => !!encryptionKeyHex.value);

// ---------------------------------------------------------------------------
// Source file selection — the encoder reads the file where it lies
// ---------------------------------------------------------------------------

/** The preload bridge, absent when the UI is open in a plain browser. */
const desktop = computed(() =>
    typeof window !== 'undefined' ? window.luminary : undefined
);
const isDev = import.meta.env.DEV;

const ingesting = ref(false);
const ingestError = ref<string | null>(null);
/** Dev-only escape hatch: type an absolute path when there is no native dialog. */
const manualPath = ref('');

const showFilePicker = computed(
    () =>
        currentStatus.value === 'created' &&
        isActiveSession.value &&
        !ingesting.value
);

async function attachPath(path: string) {
    if (!sessionToken.value || !path) return;
    ingesting.value = true;
    ingestError.value = null;
    try {
        const status = await ingestLocalFile(
            sessionId.value,
            path,
            sessionToken.value
        );
        session.value = status;
        if (status.probeResult) {
            probeResult.value = status.probeResult;
            encodingType.value = status.probeResult.videoTracks.length
                ? 'video'
                : 'audio';
        }
        poller.start(sessionId.value, sessionToken.value);
        fetchWaveform();
    } catch (e) {
        ingestError.value = errorMessage(e);
    } finally {
        ingesting.value = false;
    }
}

/**
 * A dropped File carries no path in a browser — only the desktop shell can say
 * where it came from, and without one there is nothing to hand the encoder.
 */
function onFileSelected(file: File | null) {
    if (!file) return;
    const bridge = desktop.value;
    if (!bridge) {
        ingestError.value =
            'Choosing a file needs the desktop app — the browser will not reveal where a dropped file lives.';
        return;
    }
    const path = bridge.getPathForFile(file);
    if (!path) {
        ingestError.value = 'Could not resolve that file on disk.';
        return;
    }
    void attachPath(path);
}

async function onBrowseForFile() {
    const bridge = desktop.value;
    if (!bridge) {
        ingestError.value =
            'Choosing a file needs the desktop app — the browser will not reveal where a dropped file lives.';
        return;
    }
    const path = await bridge.showOpenDialog();
    if (path) void attachPath(path);
}

function onManualPathSubmit() {
    const path = manualPath.value.trim();
    if (path) void attachPath(path);
}

// ---------------------------------------------------------------------------

/**
 * Source ingestion runs server-side and reports through the same event stream
 * as everything else, so there is no client-side upload to track.
 */
const showUploadRemoteMessage = computed(
    () => currentStatus.value === 'uploading' || ingesting.value
);

// progress=0 means the total length is unknown — fall back to indeterminate.
const remoteIngestProgress = computed<number | undefined>(() => {
    const p = poller.progress.value;
    if (typeof p !== 'number' || p <= 0) return undefined;
    return p;
});

const remoteIngestLabel = computed<string>(() => {
    const total = poller.ingestTotalBytes.value;
    return total != null ? `Reading source (${formatBytes(total)})` : 'Reading source';
});

const canRetryEncode = computed(
    () => currentStatus.value === 'failed' && poller.canRetry.value === true
);

const showProbeConfig = computed(() => {
    const s = currentStatus.value;
    return (
        (s === 'uploaded' || canRetryEncode.value) &&
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
        if (showFilePicker.value) return true;
        if (showUploadRemoteMessage.value) return true;
        if (cs === 'uploaded' && probeLoading.value) return true;
        return false;
    }
    if (submitting.value) return true;
    if (
        (showEncoding.value || isCompleted.value || cs === 'failed') &&
        !submitting.value
    )
        return true;
    return false;
});

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
const isPreviewPlaying = ref(false);

/**
 * Quality, camera angle and post-encode audio tracks are all read off the
 * master by the player wrapper and driven through its controller, so the strip
 * owns those selectors now. The preview's audio track is the one exception —
 * the encoder bakes a single audio rendition into the preview stream, so
 * choosing another is a source swap, which is why it still lives here.
 */
const previewAudioSelectOptions = computed(() =>
    previewAudioTracks.value.map((t) => ({
        value: t.index,
        label: audioTrackLabel(t),
    }))
);

async function fetchPreviewAudioTracks() {
    if (!sessionToken.value) return;
    try {
        const res = await fetch(
            `${API_BASE}/api/sessions/${sessionId.value}/preview/audio-tracks?token=${sessionToken.value}`
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
    if (!sessionToken.value) return null;
    const s = currentStatus.value;
    if (!s || s === 'created' || s === 'uploading') return null;
    // Absolute, always. Packaged, API_BASE is '' (same origin), which would make
    // this a bare path — and the player uses it as the base for resolving the
    // rendition references inside the master. A relative base resolves nothing,
    // so `r0/playlist.m3u8` fell through to the browser, which resolved it
    // against the *page* URL, and the SPA fallback answered with index.html.
    // Every packaged build failed the preview this way; browser dev never saw it
    // because API_BASE is absolute there.
    const origin = API_BASE || window.location.origin;
    let url = `${origin}/api/sessions/${sessionId.value}/preview/playlist.m3u8?token=${sessionToken.value}`;
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

/**
 * Whether the key question has been settled for this session.
 *
 * Without a session token there is nobody to ask, and nothing to ask for — the
 * delivered output is all there is, so treat that as settled rather than
 * withholding playback forever.
 */
const keySettled = computed(() => keyFetched.value || !sessionToken.value);

// Active playback URL — preview during encoding, the delivered HLS after completion.
// The swap waits on the key endpoint: until it has answered we cannot know
// whether the delivered playlist needs a key, and handing the player an
// encrypted stream without one fails the load rather than degrading.
//
// Once the session is finished there is deliberately no fall back to the
// preview. The preview is a different thing — renditions the encoder made up
// on the spot, transcoded on this machine for as long as someone watches — so
// serving it in place of the delivered output would misreport what is playing
// and hide the reason the output cannot be reached. A session with no
// deliverable address shows `deliveryProblem` instead of a player.
const activePlaybackUrl = computed(() => {
    if (isCompleted.value) {
        // Delivered output or nothing. While the key question is open we hold
        // rather than reach for the preview: it is the wrong renditions, it
        // transcodes on this machine for as long as anyone watches, and it
        // would stand in for the delivered output indefinitely if the key
        // question never closed.
        return keySettled.value ? playbackUrl.value : null;
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

/**
 * The panel beside the player is a clip list before the encode and a chapter list
 * after it, so it has to read whichever list is live for the phase.
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
    () =>
        (poller.trimSegments.value as TrimSegment[] | undefined) ??
        session.value?.trimSegments ??
        []
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
    const sp = session.value?.probeResult?.format?.duration;
    return typeof sp === 'number' && sp > 0 ? sp : 0;
});

const trimEditorProbeDuration = computed(() => {
    if (timelineIsShortened.value) return trimmedDuration(timelineRanges.value);
    if (showsOutputTimeline.value) {
        // Completed: the player holds the encoded file, whose reported duration
        // is the output's real length — and the storyboard beside it was sampled
        // from that same file, so the two agree.
        if (isCompleted.value) {
            const player = playerDuration.value;
            if (player != null && player > 0) return player;
        }
        // During the encode the player still holds the *preview*, which cuts on
        // its 4-second segment grid and so reports up to ~8s more than the trims
        // actually keep. Sizing the timeline from it left a strip of ruler past
        // the last thumbnail — the storyboard is re-timed from the exact trim
        // ranges, so the exact trimmed duration is what matches it.
        return trimmedDuration(submittedTrimSegments.value);
    }
    return chaptersSidePanelDuration.value;
});

/**
 * Waveform drawn under the timeline.
 *
 * The peaks always come from the source file — the encoder computes them from
 * the file the session was given, and that file stays where it is for the whole
 * life of the session. So once trimming is applied they have to be sliced down
 * to the retained ranges, completed sessions included: there is no separately
 * trimmed sidecar to fall back on any more.
 */
const timelineWaveformPeaks = computed(() => {
    if (timelineIsShortened.value) {
        return slicePeaksToTrims(
            waveformPeaks.value,
            sourceProbeDuration.value,
            timelineRanges.value
        );
    }
    if (!showsOutputTimeline.value) {
        return waveformPeaks.value;
    }
    return slicePeaksToTrims(
        waveformPeaks.value,
        sourceProbeDuration.value,
        submittedTrimSegments.value
    );
});

// Display metadata from the session status or poller
const displayEncoder = computed<AccelMode | string | undefined>(
    () => poller.encoder.value ?? session.value?.encoder
);

const displayEncoderLabel = computed(() => {
    const d = displayEncoder.value;
    return d && encoderConfig[d] ? encoderConfig[d].label : undefined;
});

const displayEncoderIcon = computed(() => {
    const d = displayEncoder.value;
    return d && encoderConfig[d] ? encoderConfig[d].icon : undefined;
});

const displaySegmentFormat = computed<SegmentFormat | string | undefined>(
    () => poller.segmentFormat.value ?? session.value?.segmentFormat
);

// ---------------------------------------------------------------------------
// ETA labels — encoding (pipeline) + source ingest. Each phase keeps its own
// sample buffer inside useEncodeEta, since their rates differ by orders of
// magnitude and would otherwise pollute each other.
// ---------------------------------------------------------------------------

const { etaDisplay } = useEncodeEta(
    () => poller.pipelineProgress.value?.encoding ?? poller.progress.value
);
const { etaDisplay: ingestEtaDisplay } = useEncodeEta(() =>
    currentStatus.value === 'uploading' ? poller.progress.value : null
);

// ---------------------------------------------------------------------------
// Player — playback source, copy, files
// ---------------------------------------------------------------------------

const sessionPlayerStripRef = ref<InstanceType<
    typeof SessionPlayerStrip
> | null>(null);
const chapterSegmentEditorRef = ref<{
    focus?: () => void;
    requestClearAll?: () => void;
} | null>(null);
/**
 * The playback surface the strip exposes over the player's controller. Angle,
 * quality and audio selection are the strip's own business; what the view still
 * drives is the playhead — seeking, play/pause and the current time the trim
 * timeline and the chapter list are drawn against.
 */
const playerRef = computed(() => sessionPlayerStripRef.value ?? null);

/**
 * Deleting a clip takes that material out of the video, so the timeline loses it:
 * the waveform closes up, the total shortens, and the clips after it move earlier.
 * Material that was merely never marked stays put — it is still there to mark, and
 * collapsing it would make marking one clip look like discarding everything else.
 */
/**
 * The ranges the encode will keep: the source minus what was deleted, and
 * nothing else. Only deletion is a statement about the output — a marked
 * selection is a marker, the thing you draw *before* deciding to cut it, and
 * treating it as "keep only this" meant selecting a passage to look at and
 * pressing Start Encoding silently threw the rest of the video away.
 */
const effectiveKeepRanges = computed<TrimSegment[]>(() => {
    if (deletedRanges.value.length === 0) return [];
    return invertRanges(deletedRanges.value, sourceProbeDuration.value);
});

const deletedRanges = computed<TrimSegment[]>(() =>
    trimDeletions.removed.value.map((s) => ({
        inSec: s.inSec,
        outSec: s.outSec,
    }))
);

/**
 * What starting the encode will do to the cuts, in one line beside the button.
 *
 * Only shown once something has been cut: with no trim, the copy checkboxes
 * mean what they have always meant and there is nothing to explain. There is no
 * control here — the mode is the ladder's copy ticks read back, so the way to
 * change it is to change them.
 */
const trimModeHint = computed<string | null>(() => {
    if (!showProbeConfig.value || effectiveKeepRanges.value.length === 0)
        return null;
    if (trimCopyMode.value === 'quick')
        return 'Quick cut — copies your streams, re-encodes only the cut points.';
    if (trimCopyMode.value === 'precise')
        return 'Re-encode — streams are re-encoded with sample-accurate cuts.';
    return 'Mix of copy and re-encode streams — trimming needs all or none in copy mode.';
});

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

const displayMasterPlaylist = computed(
    () => poller.masterPlaylist.value ?? session.value?.masterPlaylist
);
const displayThumbnailsVtt = computed(
    () => poller.thumbnailsVtt.value ?? session.value?.thumbnailsVtt
);

/*
 * Camera angles are no longer this view's business. The encoder writes one
 * multi-angle master; the player wrapper parses it, derives the angle list
 * (including the synthesized audio-only rendering) and switches between them
 * with the position and play state preserved. The strip drives that directly.
 */
/**
 * Whether the source file itself carries video, read from the probe rather than
 * from `encodingType` — the latter is a choice about the output and can be set
 * to audio for a video source, which says nothing about whether frames exist to
 * sample.
 */
const sourceHasVideoTrack = computed(() => {
    const tracks =
        probeResult.value?.videoTracks ??
        session.value?.probeResult?.videoTracks;
    return (tracks?.length ?? 0) > 0;
});

/**
 * Where the finished output is published. The caller that opened the session
 * supplied the public base URL, so the encoder — not this page — is the one
 * that knows the address, and it reports it as soon as encoding starts.
 */
const s3Url = computed<string | null>(
    () =>
        poller.hlsUrl.value ??
        session.value?.hlsUrl ??
        summary.value?.hlsUrl ??
        null
);

const playbackUrl = computed(() => s3Url.value);

/**
 * Why the finished output cannot be delivered to this page, if it cannot.
 *
 * `blocked` is a certainty (the browser refuses before the request leaves the
 * page); `missing` means the session was opened without a public base URL, so
 * the encode succeeded and the objects are in the bucket but nothing here can
 * name where they are — which otherwise presents as a player that spins for no
 * stated reason.
 */
const deliveryProblem = computed<
    'blocked' | 'missing' | 'unreachable' | null
>(() => {
    if (!isCompleted.value) return null;
    const url = s3Url.value;
    if (!url) return 'missing';
    const pageIsSecure =
        typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (pageIsSecure && url.startsWith('http://')) return 'blocked';
    // Completed means the upload finished, so a player still waiting on the
    // delivered master has an address problem (wrong public base URL, or a
    // bucket that refuses anonymous reads) — not a timing one. Without this
    // the page shows an indefinite "coming soon" for a finished encode.
    if (playerRef.value?.lifecycle === 'waiting-for-master') {
        return 'unreachable';
    }
    return null;
});

const deliveryProblemText = computed(() => {
    switch (deliveryProblem.value) {
        case 'blocked':
            return {
                title: 'This output cannot be played from a secure page',
                body: 'The output is served over http:// while this page is https://, so the browser blocks it. The encode is fine — the storage needs to be reachable over https://.',
            };
        case 'missing':
            return {
                title: 'This session has no public playback URL',
                body: 'The encode finished and the files are in the bucket, but the session was opened without a public base URL, so nothing here can say where they are. Set one on the CMS side.',
            };
        case 'unreachable':
            return {
                title: 'The delivered output is not reachable at its playback URL',
                body: `The encode finished, but ${s3Url.value ?? 'the playback URL'} does not answer with the master playlist (the player re-checks every 30 seconds). Check the S3 config's public base URL and that the bucket allows public reads.`,
            };
        default:
            return null;
    }
});

/**
 * The encoder's sampled storyboard is the only one that exists until the encode
 * writes its own to S3 — which happens at completion, not before.
 */
const sourceStoryboardActive = computed(
    () =>
        // A source with no video track has no frames to sample, and the API
        // answers 404 for it. Asking anyway left the timeline showing
        // "Generating thumbnails…" for the whole session on an audio file,
        // for frames that were never coming.
        sourceHasVideoTrack.value &&
        (showProbeConfig.value || showEncoding.value)
);

const sourceStoryboardUrl = computed(() => {
    if (!sourceStoryboardActive.value) return null;
    if (!sessionToken.value) return null;
    return (
        `${API_BASE}/api/sessions/${sessionId.value}` +
        `/thumbnails/thumbnails.vtt?token=${encodeURIComponent(sessionToken.value)}`
    );
});

// Sampling an hour of video takes minutes and the API serves whatever sprites
// exist so far, so the storyboard grows after the first request. Follow it.
//
// The refresh signal folds the completion flag into the count: the encoder's
// final report — made after the finished VTT is on disk — usually repeats the
// last count it already announced, and without the suffix that repeat would
// not read as a change, leaving completion to be discovered by the slow
// safety-net poll.
const storyboardRefreshSignal = computed(() => {
    const count = poller.storyboardThumbCount.value;
    if (count == null) return undefined;
    return poller.storyboardComplete.value ? `${count}-done` : `${count}`;
});
const storyboard = useStoryboard({
    url: sourceStoryboardUrl,
    active: sourceStoryboardActive,
    // The encoder pushes its thumbnail count over the session event stream, so
    // the filmstrip refetches when there is more to draw rather than on a timer.
    refresh: storyboardRefreshSignal,
});

/**
 * Where object *keys* resolve from — the bucket root, not the session's folder.
 *
 * Everything the API records is a full key including the session folder:
 * `masterPlaylist` is `<sessionId>/master.m3u8`, `thumbnailsVtt` is
 * `<sessionId>/thumbnails/thumbnails.vtt`, and `files[]` likewise. So this is
 * the delivered URL with the key stripped off the end, and a key appended to it
 * resolves correctly.
 *
 * It is **not** the folder the master sits in. Anything addressed relative to
 * the master — the sidecar conventions, which are all `<masterFolder>/…` — has
 * to use `masterFolderUrl` below instead. Appending `chapters/en.vtt` to this
 * dropped the session folder and asked the bucket root for it, which is a 404
 * on every session; the player treats a missing sidecar as nothing to report,
 * so saved chapters simply never appeared.
 */
const deliveryBaseUrl = computed<string | null>(() => {
    const master = displayMasterPlaylist.value;
    const url = s3Url.value;
    if (!master || !url) return null;
    if (!url.endsWith(master)) return null;
    return url.slice(0, url.length - master.length).replace(/\/+$/, '');
});

/**
 * The folder the master playlist sits in, which is what every sidecar is
 * addressed relative to — `<masterFolder>/chapters/<lang>.vtt`,
 * `<masterFolder>/subtitles/…`, `<masterFolder>/waveform.json`. The same
 * convention `sidecarPath()` in `@luminary-media-converter/hls` encodes.
 *
 * Derived from the delivered URL rather than from the base plus the session id,
 * because the URL is the one thing that is certainly right: the encoder built
 * it, and it is what the CMS was handed.
 */
const masterFolderUrl = computed<string | null>(() => {
    const url = s3Url.value;
    if (!url) return null;
    const lastSlash = url.lastIndexOf('/');
    if (lastSlash < 0) return null;
    return url.slice(0, lastSlash);
});

const rawThumbnailVttUrl = computed(() => {
    if (sourceStoryboardActive.value) return storyboard.versionedUrl.value;
    const base = deliveryBaseUrl.value;
    if (!displayThumbnailsVtt.value || !base) return null;
    return `${base}/${displayThumbnailsVtt.value}`;
});

/**
 * Ranges the filmstrip has to be re-timed through, and only where it needs it.
 *
 * The encoder's storyboard is sampled from the source, so its cues are in source
 * time while a trimmed timeline runs on the programme. The storyboard written at
 * completion is sampled from the encoded output instead, so it already matches
 * and must be left alone — re-timing it would shift frames that are correct.
 */
const storyboardTrimRanges = computed<TrimSegment[]>(() => {
    if (!sourceStoryboardActive.value) return [];
    if (timelineIsShortened.value) return timelineRanges.value;
    if (showsOutputTimeline.value) return submittedTrimSegments.value;
    return [];
});

const storyboardVtt = useStoryboardVttUrl({
    url: rawThumbnailVttUrl,
    ranges: storyboardTrimRanges,
    // The encoder's own storyboard is served in the clear from this machine;
    // only the one delivered beside the output can be encrypted.
    keyHex: computed(() =>
        sourceStoryboardActive.value ? undefined : encryptionKeyHex.value
    ),
});

const thumbnailVttUrl = computed(() => storyboardVtt.url.value);

/** Frames are still being made — the timeline is incomplete rather than broken. */
const storyboardPending = computed(
    () => storyboard.pending.value && !storyboard.complete.value
);

/**
 * What the encoder is doing after the segment pipeline has drained.
 *
 * The bar reaches 100% when the last segment is packed, but the status stays
 * `encoding` through playlist key tags, a fresh FFmpeg pass for thumbnail
 * sprites, the waveform sidecar and text-asset encryption. Naming the step is
 * the difference between a session that looks stalled and one that looks busy.
 *
 * `encoding` maps to nothing on purpose: while the pipeline is running the bar
 * already says so, and captioning it would be noise.
 */
// Keyed exhaustively on purpose: a phase added to the union without a label
// here is a compile error rather than a caption that silently stops appearing.
const PIPELINE_PHASE_LABELS: Record<PipelinePhase, string | null> = {
    encoding: null,
    draining: 'Packing segments…',
    'finalising-playlists': 'Finalising playlists…',
    thumbnails: 'Generating thumbnails…',
    waveform: 'Generating waveform…',
    'encrypting-playlists': 'Encrypting playlists…',
    // The one phase that outlives `encoding`: it captions the S3 bar as that
    // bar restarts from 0 for the playlists and sprites, which are a different
    // set of files from the segments it was counting until then.
    'uploading-playlists': 'Uploading playlists & thumbnails…',
};

const pipelinePhaseLabel = computed(() => {
    const phase = poller.pipelineProgress.value?.phase;
    return phase ? (PIPELINE_PHASE_LABELS[phase] ?? null) : null;
});

/**
 * Chapter cues for the player, once the output is published.
 *
 * The same `chapters/<lang>.vtt` the editor writes beside the master. A session
 * that has never had chapters saved simply has no such object, and a sidecar
 * that 404s costs the player nothing — it reports the miss and plays on.
 */
const playerChapterSidecars = computed(() => {
    if (!isCompleted.value) return undefined;
    // Relative to the master's folder, not the bucket root — see the two
    // computed URLs above.
    const folder = masterFolderUrl.value;
    if (!folder) return undefined;
    return [{ lang: 'en', label: 'Chapters', url: `${folder}/chapters/en.vtt` }];
});

/**
 * The scrub-preview sidecar, when the encode produced one.
 *
 * Taken from the key the API reports rather than assembled from a convention:
 * an audio-only encode and a session created with `thumbnails: false` have no
 * VTT at all, and this is how we know that without asking S3 for a 404.
 *
 * `thumbnailsVtt` is a full object key (`<sessionId>/thumbnails/thumbnails.vtt`),
 * so it resolves against the bucket root — not the master's folder. That is the
 * distinction item 12 turned on: appending a master-relative path to the bucket
 * root, or the reverse, 404s on every session, and a missing sidecar is silent
 * by design.
 */
const playerThumbnailSidecar = computed(() => {
    if (!isCompleted.value) return undefined;
    const key = displayThumbnailsVtt.value;
    const base = deliveryBaseUrl.value;
    if (!key || !base) return undefined;
    return { url: `${base}/${key}` };
});

/**
 * What the player is asked to present.
 *
 * A new object here is a reload, so this is deliberately thin: the URL, the
 * key once it is known, and the chapter sidecar. Everything else the player
 * needs — angles, the quality ladder, audio and subtitle tracks — it reads out
 * of the master itself. `preservePosition` covers the one swap that matters:
 * preview to delivered output, which should not send the viewer back to zero.
 */
const playerSource = computed<PlayerSource | null>(() => {
    const url = activePlaybackUrl.value;
    if (!url) return null;
    const chapters = playerChapterSidecars.value;
    const thumbnails = playerThumbnailSidecar.value;
    const sidecars = {
        ...(chapters ? { chapters } : {}),
        ...(thumbnails ? { thumbnails } : {}),
    };
    return {
        masterUrl: url,
        preservePosition: true,
        ...(encryptionKeyHex.value ? { keyHex: encryptionKeyHex.value } : {}),
        ...(Object.keys(sidecars).length > 0 ? { sidecars } : {}),
    };
});

// ---------------------------------------------------------------------------
// Delete session
// ---------------------------------------------------------------------------

const deleting = ref(false);
const deleteModalOpen = ref(false);

const deleteModalLabel = computed(() => {
    const n = sessionName.value?.trim();
    if (n) return n;
    const id = sessionId.value;
    if (!id) return '';
    return id.length > 16 ? `${id.slice(0, 12)}…` : id;
});

async function removeSession() {
    await deleteSession(sessionId.value, sessionToken.value ?? undefined);
    clearChapterDraftForSession(sessionId.value);
    forgetSessionToken(sessionId.value);
}

async function onConfirmDelete() {
    deleting.value = true;
    try {
        await removeSession();
        deleteModalOpen.value = false;
        router.push('/sessions');
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        deleting.value = false;
    }
}

// ---------------------------------------------------------------------------
// Load the session
// ---------------------------------------------------------------------------

/**
 * The session token comes down with the session list and nowhere else. The list
 * view seeds the shared map on every refresh, so navigating in is instant; a
 * deep link or a reload lands here cold and has to ask for the list itself.
 */
async function resolveSessionToken(): Promise<string | null> {
    try {
        const rows = await listSessions();
        for (const row of rows) setSessionToken(row.sessionId, row.sessionToken);
        summary.value =
            rows.find((row) => row.sessionId === sessionId.value) ?? null;
    } catch {
        // The map may still hold a token from the list view; fall through.
    }
    return (
        summary.value?.sessionToken ?? getSessionToken(sessionId.value) ?? null
    );
}

async function fetchSession() {
    loading.value = true;
    error.value = null;
    notFound.value = false;
    try {
        sessionToken.value = await resolveSessionToken();

        const detail = await getSession(sessionId.value);
        if (!detail) {
            notFound.value = true;
            return;
        }
        session.value = detail;
        if (detail.probeResult) {
            probeResult.value = detail.probeResult;
            encodingType.value = detail.probeResult.videoTracks.length
                ? 'video'
                : 'audio';
        }

        fetchWaveform();

        await handleStatusAfterLoad(detail.status);
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

// ---------------------------------------------------------------------------
// Status-based initialization after loading the session
// ---------------------------------------------------------------------------

async function handleStatusAfterLoad(status: string) {
    if (!isActiveSession.value) return;

    if (status === 'uploaded') {
        // No early return: the configure phase is live now. The storyboard
        // fills over pushed thumbnail counts on the event stream, so a page
        // (re)loaded at 'uploaded' without a running poller sat frameless
        // until the slow safety-net poll found everything at once.
        await fetchProbeResults();
    }

    if (status === 'failed') {
        // Only the encoder knows whether the source survived the failure, and
        // that decides whether this session can simply be run again. `failed` is
        // terminal, so the poller reads it once and stops — a single request,
        // not a loop.
        await fetchProbeResults();
    }

    // A completed session has nothing left to stream. Everything else does —
    // including `created`, because the file may be attached from another window
    // and this page should see that happen rather than sit on a stale picker.
    if (status !== 'completed') {
        poller.start(sessionId.value, sessionToken.value!);
    }
}

// ---------------------------------------------------------------------------
// Fetch probe results
// ---------------------------------------------------------------------------

async function fetchProbeResults() {
    if (!sessionToken.value) return;
    probeLoading.value = true;
    try {
        // Status is already 'uploaded' so probe results should be available — poll directly
        const probe = await pollForProbe(sessionId.value, sessionToken.value);
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
    sid: string,
    token: string
): Promise<ProbeResult | null> {
    for (let i = 0; i < 60; i++) {
        const data = await getSessionStatus(sid, token);
        // Keep the loaded status in step with the encoder so the UI reflects
        // the actual state (e.g. 'uploaded' once the probe completes).
        session.value = { ...(session.value ?? data), ...data };
        if (data.probeResult) return data.probeResult;
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

/**
 * Waveform peaks for the timeline.
 *
 * There is one endpoint and one source: the encoder computes the peaks from the
 * file the session was given. That file is referenced where it lies and is never
 * copied or removed, so this works for the whole life of the session — before
 * the encode and after it — and the peaks are always on the source timeline.
 */
async function fetchWaveform() {
    if (!sessionToken.value) return;
    try {
        const response = await fetch(
            `${API_BASE}/api/sessions/${sessionId.value}/waveform?token=${sessionToken.value}`
        );
        if (!response.ok) {
            scheduleWaveformRetry();
            return;
        }
        const data = await response.json();
        waveformPeaks.value = data.peaks ?? null;
        if (!waveformPeaks.value?.length) scheduleWaveformRetry();
    } catch {
        // Non-critical: waveform is a UX enhancement, don't error the whole view
        scheduleWaveformRetry();
    }
}

/** Backs off from ~2s to ~30s while the source is still being analysed. */
const WAVEFORM_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
let waveformRetries = 0;
let waveformRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The waveform is computed from the source on first request, which for a long
 * file takes a while. A single attempt on page load usually lands before it is
 * ready, and nothing asked again — so the timeline stayed flat until someone
 * happened to reload. Keep asking, slower each time.
 */
function scheduleWaveformRetry() {
    if (waveformRetryTimer) return;
    const delay =
        WAVEFORM_RETRY_MS[
            Math.min(waveformRetries, WAVEFORM_RETRY_MS.length - 1)
        ];
    waveformRetries++;
    waveformRetryTimer = setTimeout(() => {
        waveformRetryTimer = null;
        if (waveformPeaks.value?.length) return;
        // The timeline cannot use peaks yet — but "not yet" is not "never", and
        // dropping the chain here left the waveform flat until the page was
        // reloaded. Keep the backoff alive and look again on the next tick.
        if (!canEditTrimTimeline.value) {
            scheduleWaveformRetry();
            return;
        }
        void fetchWaveform();
    }, delay);
}

// ---------------------------------------------------------------------------
// Encode submission
// ---------------------------------------------------------------------------

async function onEncodeSubmit(config: EncodeConfig) {
    if (!sessionToken.value) return;

    submitting.value = true;
    submissionError.value = null;

    try {
        encodingType.value = config.type;

        // Wait for status to become 'uploaded' (probe may still be running)
        if (currentStatus.value !== 'uploaded' && !canRetryEncode.value) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Timed out waiting for the source to be read'
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
                            reject(new Error('Reading the source failed'));
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
        await startEncode(sessionId.value, submitConfig, sessionToken.value);

        // The timeline switches to the encoded programme here, so the ranges
        // have to move with it: they are in source time, and the ruler is not
        // any more.
        //
        // They are deliberately not dropped. Marking a range is a selection,
        // not a deletion — clearing it on submit read as the app throwing the
        // work away, and left nothing on screen describing what had just been
        // sent to encode.
        //
        // Mapped through the submitted ranges rather than laid end to end from
        // zero. Laying them out was right while a selection *was* the material
        // kept, because the output then simply was those ranges concatenated.
        // Only deletions restrict the encode now, so the output is the source
        // minus what was cut, and a selection's place in it is its source
        // position carried through the ranges that survived — end-to-end would
        // park the first selection at zero wherever it actually came from.
        if (submittedTrims.length > 0) {
            editorSegments.value = mapSegmentsToTimeline(
                editorSegments.value,
                submittedTrims,
            );
            // Deletions are the one thing that genuinely does not survive: they
            // described material the encode has already removed, so there is
            // nothing left for them to refer to.
            trimDeletions.clear();
        }

        // Save config for future reuse (strip trimSegments — session-specific)
        if (probeResult.value) {
            const layoutKey = computeLayoutKey(probeResult.value, config.type);
            saveConfig(layoutKey, config);
        }

        // The preview playlist is regenerated against the submitted trims, at
        // the same URL — so nothing about the source changes and the player has
        // to be told to read it again.
        if (submittedTrims.length > 0 && previewPlaybackUrl.value) {
            playerRef.value?.reload();
        }

        // Start polling for encoding progress
        poller.start(sessionId.value, sessionToken.value);
    } catch (e) {
        submissionError.value = errorMessage(e);
    } finally {
        submitting.value = false;
    }
}

function onEncodeCanSubmitChange(valid: boolean) {
    encodeConfigCanSubmit.value = valid;
}

function onTrimModeChange(mode: TrimCopyMode) {
    trimCopyMode.value = mode;
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

/**
 * Statuses in which this session can be discarded, matching what
 * `DELETE /api/sessions/:id` actually accepts.
 *
 * `encrypting` and `uploading_to_s3` are absent because the API refuses them —
 * the pipeline is mid-write. Offering the button there and swallowing the
 * refusal told the user their session was cancelled while it carried on
 * encrypting and uploading.
 */
const DISCARDABLE_STATUSES = [
    'created',
    'uploading',
    'uploaded',
    'queued',
    'encoding',
] as const;

const canDiscardSession = computed(() =>
    DISCARDABLE_STATUSES.includes(
        currentStatus.value as (typeof DISCARDABLE_STATUSES)[number]
    )
);

/**
 * A finished session can still be deleted from here — through the confirmation,
 * not the discard button.
 *
 * The Delivery tab used to carry this, and removing that tab would otherwise have
 * taken the capability with it: the sessions list can still delete, but a user
 * looking at a finished session would have had to leave the page to reclaim its
 * disk. The two paths differ on purpose. Discarding something mid-setup is a
 * shrug and happens immediately; deleting a finished encode asks first, because
 * the record, its chapter draft and its work directory go with it.
 */
const canDeleteFinishedSession = computed(() => isTerminal.value);
// `isTerminal`, not a fresh `status === 'completed' || 'failed'`: it reads the
// poller *and* the session document, so a stale poller cannot hide the button on
// a session that has plainly finished. `canDiscardSession` is checked first in
// the template, so anything still running keeps its cancel.

/**
 * "Cancel encoding" is only true once there is an encode to cancel. Before that
 * the same action discards a session the user has been setting up, and saying
 * so is the difference between a button they trust and one they avoid.
 */
const discardLabel = computed(() =>
    currentStatus.value === 'queued' || currentStatus.value === 'encoding'
        ? 'Cancel encoding'
        : 'Discard session'
);

/**
 * Stop, delete, leave — and say so when it does not work.
 *
 * The failure was previously swallowed as "best-effort cleanup" and the route
 * change happened regardless, so a refusal looked identical to a success. The
 * poller restarts if the delete fails, because the session is still running and
 * the view has to keep telling the truth about it.
 */
async function onCancelEncode() {
    cancelError.value = null;
    poller.stop();

    try {
        await removeSession();
    } catch (e) {
        cancelError.value = errorMessage(e);
        if (sessionId.value && sessionToken.value) {
            poller.start(sessionId.value, sessionToken.value);
        }
        return;
    }

    router.push('/sessions');
}

// ---------------------------------------------------------------------------
// Encryption key — asked for, never broadcast
// ---------------------------------------------------------------------------

/**
 * Ask the encoder for this session's key, once it can have one.
 *
 * The key is generated when encoding starts, so there is nothing to fetch
 * before then; a 404 means this session is not encrypted, which is an answer
 * and is recorded as one. Attempts repeat on each status change until the
 * question is answered, since a session reaching `encoding` and the key being
 * recorded are not quite the same instant.
 */
async function fetchEncryptionKey() {
    const token = sessionToken.value;
    if (!token || encryptionKeyHex.value) return;
    // A 404 only settles the question if the session was already finished when
    // the request went out; earlier than that it may just be ahead of the key
    // being recorded.
    const askedAfterCompletion = isCompleted.value;
    try {
        const masked = await getSessionKey(sessionId.value, token);
        if (masked?.maskedKeyHex) {
            encryptionKeyHex.value = await unmaskSessionKey(
                sessionId.value,
                masked.maskedKeyHex
            );
            keyFetched.value = true;
        } else if (askedAfterCompletion) {
            keyFetched.value = true;
        }
    } catch {
        // Unreachable or unreadable. Before completion, leave the question open
        // so the next status change asks again; after it, settle anyway — an
        // unanswerable key endpoint is no reason to hold the finished output
        // back behind the preview stream forever.
        if (askedAfterCompletion) keyFetched.value = true;
    }
}

const KEY_BEARING_STATUSES = [
    'encoding',
    'encrypting',
    'uploading_to_s3',
    'completed',
];

watch(
    [() => sessionToken.value, currentStatus],
    ([token, status]) => {
        if (!token || !status) return;
        if (!KEY_BEARING_STATUSES.includes(status)) return;
        if (encryptionKeyHex.value) return;
        void fetchEncryptionKey();
    },
    { immediate: true }
);

// Ingest runs server-side, so the flip to 'uploaded' arrives over the event
// stream rather than from a client-side upload finishing.
watch(
    () => poller.status.value,
    (status, prev) => {
        if (
            status === 'uploaded' &&
            prev !== 'uploaded' &&
            !probeResult.value
        ) {
            if (sessionToken.value) {
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
    [() => sessionId.value, activePlaybackUrl, () => sessionToken.value],
    async ([id, url, token]) => {
        if (!id || !url || !token) return;
        if (chapters.isLoaded.value && chapters.loadedSessionId.value === id)
            return;
        try {
            chaptersSaveError.value = null;
            await chapters.load(id);
        } catch (err) {
            chaptersSaveError.value = errorMessage(err);
        }
    },
    { immediate: true }
);

async function onSaveChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.saveRemote();
    } catch (err) {
        chaptersSaveError.value = errorMessage(err);
    }
}

async function onDiscardChapters() {
    chaptersSaveError.value = null;
    try {
        await chapters.discardLocal();
        syncChaptersFromTimeline();
    } catch (err) {
        chaptersSaveError.value = errorMessage(err);
    }
}

// Once the encode is submitted the bottom timeline becomes the chapter editor,
// and it stays in step with the chapter list beside the player in both
// directions. Trim markers never take part.
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

/** Detail card: only visible during the pre-encode file/probe flow (progress below the player). */
const showSessionDetailCard = computed(
    () =>
        showSessionWorkflowPanel.value &&
        !showProbeConfig.value &&
        !showEncoding.value &&
        !isCompleted.value
);

const sessionDetailCardSurfaceClass = computed(
    () =>
        'rounded-xl border border-slate-200/90 bg-white/90 p-3 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur sm:p-4 dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10'
);

/** Sub-tab within the aside panel after encoding completes. */

// Reset aside sub-tab back to encode settings when probe config becomes available again.
watch(showProbeConfig, (ready) => {
    if (ready) encodeSidePanelTab.value = 'encode';
});

function relativeCreatedLabel(createdAt: number | null | undefined): string {
    if (!createdAt) return '';
    return `Created ${formatRelative(new Date(createdAt).toISOString())}`;
}

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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(fetchSession);

onUnmounted(() => {
    if (waveformRetryTimer) clearTimeout(waveformRetryTimer);
    poller.stop();
    chapters.unload();
    document.documentElement.style.overflowY = '';
    setHeaderLayout('default');
});
</script>

<template>
    <div
        :data-retry-available="canRetryEncode || undefined"
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

            <!--
                The encoder holds every session it knows about, so a session it
                cannot find is one that was dismissed, cancelled, or lost to a
                restart — not one that merely expired somewhere else.
            -->
            <div
                v-else-if="notFound"
                class="flex min-h-[70dvh] w-full items-center justify-center px-4 py-10"
            >
                <div
                    class="w-full max-w-md rounded-2xl border border-slate-200/90 bg-white/90 p-8 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
                >
                    <div class="flex flex-col items-center gap-4 text-center">
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
                                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                                />
                            </svg>
                        </div>
                        <h2
                            class="text-base font-semibold text-slate-800 dark:text-slate-100"
                        >
                            Session not found
                        </h2>
                        <p class="text-xs text-slate-500 dark:text-slate-400">
                            This encoder has no session with that id. It may
                            have been dismissed, or lost when the app restarted.
                            Open it again from Luminary CMS.
                        </p>
                        <button
                            type="button"
                            class="mt-2 w-full cursor-pointer rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            @click="router.push('/sessions')"
                        >
                            Back to sessions
                        </button>
                    </div>
                </div>
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
                <!-- Main column -->
                <div
                    :class="[
                        'min-w-0 flex flex-col',
                        activeTab === 'trim' ? 'flex-1 min-h-0' : 'space-y-5',
                    ]"
                >
                    <!--
                        The topline used to be here — a full-width row above both
                        columns. It now renders inside the player's own column
                        (see the `#player-top` slot below), so the aside runs to
                        the top of the window instead of starting a row down with
                        a band of empty space over the chapters pane.

                        It still renders on its own for the stretch with no
                        player: `created` through `uploaded` has no video to sit
                        above, and that is exactly where the back arrow and the
                        discard button are the only way out of the session.
                    -->
                    <SessionTopline
                        v-if="showSessionDetailCard"
                        class="px-4 pt-3"
                        :session-name="sessionName"
                        :session-id="sessionId"
                        :status="currentStatus"
                        :created-at="summary?.createdAt"
                        :can-discard="canDiscardSession"
                        :discard-label="discardLabel"
                        :can-delete="canDeleteFinishedSession"
                        :cancel-error="cancelError"
                        @discard="onCancelEncode"
                        @delete="deleteModalOpen = true"
                    />

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
                        <!--
                            The encode succeeded and the objects are in the
                            bucket; only the address the browser was given
                            cannot work. Say so here, or this presents as a
                            player that loads forever for no stated reason.
                        -->
                        <div
                            v-if="deliveryProblem"
                            role="alert"
                            data-testid="delivery-problem"
                            class="mb-3 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/60 dark:text-amber-100"
                        >
                            <svg
                                class="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                stroke-width="2"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                                />
                            </svg>
                            <div v-if="deliveryProblemText">
                                <p class="font-medium">
                                    {{ deliveryProblemText.title }}
                                </p>
                                <p class="mt-1">
                                    {{ deliveryProblemText.body }}
                                </p>
                            </div>
                        </div>

                        <SessionPlayerStrip
                            ref="sessionPlayerStripRef"
                            class="flex-1 min-h-0"
                            :source="playerSource"
                            :show-aside="showAside"
                            :active-tab="activeTab"
                            :show-audio-select="
                                !isCompleted && previewAudioTracks.length > 1
                            "
                            :preview-audio-select-options="
                                previewAudioSelectOptions
                            "
                            v-model:selected-audio-track="selectedAudioTrack"
                            @playing-change="isPreviewPlaying = $event"
                            @duration-change="playerDuration = $event"
                        >
                            <template #player-top>
                                <SessionTopline
                                    :session-name="sessionName"
                                    :session-id="sessionId"
                                    :status="currentStatus"
                                    :created-at="summary?.createdAt"
                                    :can-discard="canDiscardSession"
                                    :discard-label="discardLabel"
                                    :can-delete="canDeleteFinishedSession"
                                    :cancel-error="cancelError"
                                    @discard="onCancelEncode"
                                    @delete="deleteModalOpen = true"
                                />
                            </template>

                            <!--
                                The encode action, under the player rather than at
                                the far end of a page-wide bar. It acts on the
                                settings in the aside beside it, and it was
                                previously as far from them as the layout allowed.
                                The title is the only thing that explains a
                                disabled state, so it travels with the button.
                            -->
                            <template v-if="showProbeConfig" #below-player>
                                <button
                                    type="button"
                                    data-testid="start-encoding"
                                    class="cursor-pointer rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600 sm:px-5 sm:py-2.5 sm:text-sm"
                                    :disabled="!encodeConfigCanSubmit || submitting"
                                    :title="
                                        !encodeConfigCanSubmit && !submitting
                                            ? 'Open Encode settings and complete the ladder (all required options) first.'
                                            : undefined
                                    "
                                    @click="onStartEncodingFromTrim"
                                >
                                    {{ submitting ? 'Starting…' : 'Start encoding' }}
                                </button>
                                <!--
                                    Which of the two cutting paths the button is
                                    about to take. Derived from the ladder's copy
                                    ticks, not chosen here — see trimModeHint.
                                -->
                                <p
                                    v-if="trimModeHint"
                                    data-testid="trim-mode-hint"
                                    class="mt-1 text-xs text-slate-500 dark:text-slate-400"
                                >
                                    {{ trimModeHint }}
                                </p>
                            </template>

                            <!--
                                Title, status and created label used to sit here,
                                under the player, leaving the row's left side to
                                them and pushing the playback selects to the right
                                edge. They now head the session on the topline
                                above the player, and the selects take the left
                                edge in their place.
                            -->
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
                                        Cuts
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
                                    <!--
                                        Status row: what is doing the work on the
                                        left, how long it has left on the right.
                                        Wraps rather than overflows when the panel
                                        is narrow.
                                    -->
                                    <div
                                        class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
                                    >
                                        <div
                                            class="flex flex-wrap items-center gap-2"
                                        >
                                            <!--
                                                Which encoder is doing the work.
                                                Only meaningful while it runs, and
                                                the panel that used to carry it is
                                                hidden for exactly that state.
                                            -->
                                            <span
                                                v-if="displayEncoderLabel"
                                                class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
                                                :title="`Encoding is running on ${displayEncoderLabel}`"
                                            >
                                                <svg
                                                    v-if="displayEncoderIcon"
                                                    class="h-3.5 w-3.5 text-slate-500 dark:text-slate-400"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    aria-hidden="true"
                                                >
                                                    <path
                                                        :d="displayEncoderIcon"
                                                    />
                                                </svg>
                                                {{ displayEncoderLabel }}
                                            </span>
                                            <span
                                                v-if="
                                                    poller.status.value ===
                                                        'queued' &&
                                                    poller.queuePosition
                                                        .value != null
                                                "
                                                class="inline-block rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-400"
                                            >
                                                Queue position #{{
                                                    poller.queuePosition.value
                                                }}
                                            </span>
                                        </div>
                                        <p
                                            v-if="etaDisplay"
                                            class="ml-auto text-xs text-slate-500"
                                        >
                                            {{ etaDisplay }}
                                        </p>
                                    </div>
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
                                        <!--
                                            Draining at 100% is not the encode finishing: segment
                                            packing, the sprite sheets, the waveform sidecar and
                                            text-asset encryption all still run before the status
                                            leaves `encoding`, and the playlists and sprites are
                                            uploaded after it. Unnamed, a full bar over unfinished
                                            work reads as stalled rather than busy.
                                        -->
                                        <p
                                            v-if="pipelinePhaseLabel"
                                            data-testid="pipeline-phase"
                                            class="-mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                                        >
                                            <span
                                                class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-500"
                                                aria-hidden="true"
                                            />
                                            {{ pipelinePhaseLabel }}
                                        </p>
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
                                </div>

                                <!--
                                    Encode config panel — hidden rather than
                                    unmounted when the aside shows another tab.
                                    Start Encoding reads the config straight off
                                    this form, so unmounting it made a perfectly
                                    valid config look invalid to anyone who
                                    started their encode from the Cuts tab.
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
                                        :trim-active="
                                            effectiveKeepRanges.length > 0
                                        "
                                        @submit="onEncodeSubmit"
                                        @can-submit-change="
                                            onEncodeCanSubmitChange
                                        "
                                        @trim-mode-change="onTrimModeChange"
                                    />
                                </div>

                                <!-- Chapter list panel -->
                                <div
                                    v-if="
                                        showChaptersBesidePlayer &&
                                        (!showProbeConfig ||
                                            encodeSidePanelTab ===
                                                'chapters') &&
                                        (!showEncoding ||
                                            encodingAsideTab === 'chapters')
                                    "
                                    class="min-h-0 flex-1 flex flex-col overflow-hidden"
                                >
                                    <!--
                                        Before the encode this panel is about what
                                        has been cut. Listing the kept ranges as
                                        well said the same thing twice — what
                                        remains is whatever was not cut — and the
                                        only action worth having here is undo.
                                    -->
                                    <div
                                        v-if="showProbeConfig"
                                        class="min-h-0 flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-800/50"
                                    >
                                        <div
                                            class="mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-700"
                                        >
                                            <h3
                                                class="text-sm font-semibold text-slate-800 dark:text-slate-100"
                                            >
                                                Cuts
                                            </h3>
                                            <button
                                                v-if="
                                                    removedTrimSegments.length >
                                                    1
                                                "
                                                type="button"
                                                class="chapter-toolbar-muted"
                                                @click="
                                                    trimDeletions.restoreAll
                                                "
                                            >
                                                Restore all
                                            </button>
                                            <span
                                                v-else
                                                class="text-xs text-slate-400 dark:text-slate-500"
                                            >
                                                {{
                                                    removedTrimSegments.length ||
                                                    'No'
                                                }}
                                                cut{{
                                                    removedTrimSegments.length ===
                                                    1
                                                        ? ''
                                                        : 's'
                                                }}
                                            </span>
                                        </div>

                                        <ul
                                            v-if="removedTrimSegments.length > 0"
                                            class="min-h-0 flex-1 space-y-1 overflow-y-auto"
                                        >
                                            <li
                                                v-for="seg in removedTrimSegments"
                                                :key="seg.id"
                                                class="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1 dark:bg-slate-900/40"
                                            >
                                                <span
                                                    class="font-mono text-xs text-slate-600 dark:text-slate-300"
                                                >
                                                    {{ formatTime(seg.inSec) }}
                                                    –
                                                    {{ formatTime(seg.outSec) }}
                                                </span>
                                                <button
                                                    type="button"
                                                    class="chapter-toolbar-muted"
                                                    @click="
                                                        trimDeletions.restore(
                                                            seg.id
                                                        )
                                                    "
                                                >
                                                    Undo
                                                </button>
                                            </li>
                                        </ul>

                                        <div
                                            v-else
                                            class="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center"
                                        >
                                            <div
                                                class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-700/50"
                                            >
                                                <svg
                                                    class="h-5 w-5 text-slate-400 dark:text-slate-500"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    aria-hidden="true"
                                                >
                                                    <circle cx="6" cy="6" r="3" />
                                                    <circle
                                                        cx="6"
                                                        cy="18"
                                                        r="3"
                                                    />
                                                    <line
                                                        x1="20"
                                                        y1="4"
                                                        x2="8.12"
                                                        y2="15.88"
                                                    />
                                                    <line
                                                        x1="14.47"
                                                        y1="14.48"
                                                        x2="20"
                                                        y2="20"
                                                    />
                                                    <line
                                                        x1="8.12"
                                                        y1="8.12"
                                                        x2="12"
                                                        y2="12"
                                                    />
                                                </svg>
                                            </div>
                                            <p
                                                class="text-sm font-medium text-slate-700 dark:text-slate-200"
                                            >
                                                No cuts yet
                                            </p>
                                            <p
                                                class="mt-1 text-xs text-slate-500 dark:text-slate-400"
                                            >
                                                Mark in/out on the timeline below
                                                and press Cut. The whole timeline
                                                is encoded if you cut nothing.
                                            </p>
                                        </div>
                                    </div>

                                    <SegmentEditor
                                        v-else
                                        ref="chapterSegmentEditorRef"
                                        v-model="asidePanelSegments"
                                        class="min-h-0 flex-1 overflow-hidden"
                                        mode="chapters"
                                        embedded
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
                                        title="Chapters"
                                        empty-title="No chapters yet"
                                        empty-hint="Use the trim timeline below to add in/out marks, or load chapters from a VTT sidecar."
                                        keyboard-scope="focus"
                                        :fps="segmentEditorProbeFps"
                                    >
                                        <!--
                                            Saving belongs with the list it
                                            saves, not in a toolbar further
                                            down the page.
                                        -->
                                        <template #list-actions>
                                            <!--
                                                Clear All lives here rather than
                                                in the timeline's controls,
                                                where it sat among playback,
                                                mark in/out, undo/redo and zoom
                                                — every one of them local to the
                                                timeline and reversible by
                                                habit. It deletes the list, so
                                                it belongs beside the list.

                                                The confirmation is still the
                                                editor's own: `requestClearAll`
                                                opens the sheet the component
                                                already has, rather than this
                                                view growing a second one that
                                                words it differently.
                                            -->
                                            <button
                                                v-if="asidePanelSegments.length > 0"
                                                type="button"
                                                class="chapter-toolbar-muted"
                                                title="Remove every chapter · undo with ⌘/Ctrl + Z"
                                                @click="chapterSegmentEditorRef?.requestClearAll?.()"
                                            >
                                                Clear all
                                            </button>
                                            <span
                                                v-if="canSaveChapters && chapters.isDirty.value"
                                                class="chapter-unsaved-pill"
                                                title="Unsaved changes are stored locally; click Save to commit to S3."
                                            >
                                                Unsaved
                                            </span>
                                            <button
                                                v-if="canSaveChapters && chapters.isDirty.value"
                                                type="button"
                                                class="chapter-toolbar-muted"
                                                :disabled="
                                                    chapters.isSaving.value
                                                "
                                                @click="onDiscardChapters"
                                            >
                                                Discard
                                            </button>
                                            <button
                                                v-if="canSaveChapters"
                                                type="button"
                                                class="chapter-save-btn"
                                                :disabled="
                                                    !chapters.isDirty.value ||
                                                    chapters.isSaving.value
                                                "
                                                @click="onSaveChapters"
                                            >
                                                {{
                                                    chapters.isSaving.value
                                                        ? 'Saving…'
                                                        : 'Save chapters'
                                                }}
                                            </button>
                                        </template>
                                    </SegmentEditor>
                                    <p
                                        v-if="chaptersSaveError"
                                        class="shrink-0 text-xs text-red-600 dark:text-red-400"
                                    >
                                        {{ chaptersSaveError }}
                                    </p>
                                </div>

                            </template>
                        </SessionPlayerStrip>

                    </div>

                    <SessionTrimWorkspace
                        ref="trimTimelineWorkspaceRef"
                        v-if="activeTab === 'trim' && showTrimSegmentEditor"
                        class="order-3 shrink-0"
                        section="timeline"
                        v-model:editor-segments="timelineSegments"
                        :show-chapters-side-panel="showChaptersBesidePlayer"
                        :can-save-chapters="canSaveChapters"
                        :chapters-save-error="chaptersSaveError"
                        :show-trim-segment-editor="showTrimSegmentEditor"
                        :thumbnail-vtt-url="thumbnailVttUrl"
                        :storyboard-pending="storyboardPending"
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
                    >
                        <template #timeline-end>
                            <!-- Opens upward: the controls bar is at the floor of the window. -->
                            <AccountMenu drop="up" variant="editor" />
                        </template>
                    </SessionTrimWorkspace>

                    <div
                        v-if="showSessionDetailCard"
                        class="order-1 flex w-full flex-1 flex-col"
                    >
                        <!-- Upload / probe progress (pre-encode only) — centered card in the viewport. -->
                        <div
                            class="flex w-full flex-1 items-center justify-center px-4 py-10 sm:px-6 min-h-[70dvh]"
                        >
                            <!--
                                The encoder reads the source where it lies, so
                                what it needs is a path, not a transfer. That is
                                why this is a picker and not an upload: a
                                multi-gigabyte pick costs no disk and no wait.
                            -->
                            <div
                                v-if="showFilePicker"
                                :class="[
                                    sessionDetailCardSurfaceClass,
                                    'w-full max-w-lg space-y-4',
                                ]"
                            >
                                <div class="space-y-1 text-center">
                                    <h2
                                        class="text-base font-semibold text-slate-900 dark:text-slate-100"
                                    >
                                        Choose the source file
                                    </h2>
                                    <p
                                        class="text-xs leading-relaxed text-slate-500 dark:text-slate-400"
                                    >
                                        The file stays where it is — nothing is
                                        copied, and nothing is written to it.
                                    </p>
                                </div>

                                <FileDropZone @update:file="onFileSelected" />

                                <div class="flex justify-center">
                                    <button
                                        type="button"
                                        class="cursor-pointer rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                        @click="onBrowseForFile"
                                    >
                                        Browse…
                                    </button>
                                </div>

                                <p
                                    v-if="!desktop"
                                    class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-100"
                                >
                                    Picking a file needs the desktop app — a
                                    browser will not say where a dropped file
                                    lives on disk.
                                </p>

                                <!--
                                    Dev-only: without the shell there is no way
                                    to name a file at all, and that would make
                                    the whole flow untestable in a browser.
                                -->
                                <div
                                    v-if="!desktop && isDev"
                                    class="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700"
                                >
                                    <label
                                        for="manual-source-path"
                                        class="block text-xs font-medium text-slate-500 dark:text-slate-400"
                                    >
                                        Absolute path (development only)
                                    </label>
                                    <div class="flex gap-2">
                                        <input
                                            id="manual-source-path"
                                            v-model="manualPath"
                                            type="text"
                                            placeholder="/Users/you/Movies/source.mp4"
                                            class="input min-w-0 flex-1"
                                            @keyup.enter="onManualPathSubmit"
                                        />
                                        <button
                                            type="button"
                                            class="shrink-0 cursor-pointer rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-700 dark:hover:bg-sky-600"
                                            :disabled="!manualPath.trim()"
                                            @click="onManualPathSubmit"
                                        >
                                            Use
                                        </button>
                                    </div>
                                </div>

                                <p
                                    v-if="ingestError"
                                    class="text-xs text-red-600 dark:text-red-400"
                                >
                                    {{ ingestError }}
                                </p>
                            </div>

                            <div
                                v-else
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
                                    :show-upload-remote-message="
                                        showUploadRemoteMessage
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
                                    :fallback-note="
                                        poller.fallbackNote.value ??
                                        session?.fallbackNote
                                    "
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
                                    :pipeline-phase="
                                        poller.pipelineProgress.value?.phase
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
                                />
                    </div>
                </div>
            </template>
        </div>

        <DeleteSessionModal
            v-model:open="deleteModalOpen"
            :session-label="deleteModalLabel"
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
