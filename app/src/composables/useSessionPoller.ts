import { ref, readonly, onUnmounted } from 'vue';
import { getSessionStatus, subscribeSessionEvents } from '../api';
import type { AccelMode, PipelineProgress, SegmentFormat, SessionStatus, SessionStatusResponse } from '../types';
import { errorMessage } from '../utils/errors';

const TERMINAL_STATUSES: SessionStatus[] = ['completed', 'failed'];
const FALLBACK_POLL_INTERVAL_MS = 5000;

// Status ordering for conflict resolution — higher index = later in pipeline
const STATUS_ORDER: Record<string, number> = {
    created: 0,
    uploading: 1,
    uploaded: 2,
    queued: 3,
    encoding: 4,
    encrypting: 5,
    uploading_to_s3: 6,
    completed: 7,
    failed: 7,
};

export function useSessionPoller() {
    const status = ref<SessionStatus | null>(null);
    const progress = ref<number | undefined>();
    const pipelineProgress = ref<PipelineProgress | undefined>();
    const queuePosition = ref<number | undefined>();
    const files = ref<string[] | undefined>();
    const masterPlaylist = ref<string | undefined>();
    const anglePlaylists = ref<{ name: string; key: string }[] | undefined>();
    const error = ref<string | undefined>();
    const encoder = ref<AccelMode | undefined>();
    const segmentFormat = ref<SegmentFormat | undefined>();
    const thumbnailsVtt = ref<string | undefined>();
    const encryptionKeyHex = ref<string | undefined>();
    const ingestTotalBytes = ref<number | undefined>();
    const polling = ref(false);

    let eventSource: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    function applyUpdate(data: SessionStatusResponse, force = false) {
        if (
            !force &&
            status.value &&
            (STATUS_ORDER[data.status] ?? 0) < (STATUS_ORDER[status.value] ?? 0)
        ) {
            return;
        }

        status.value = data.status;
        progress.value = data.progress;
        pipelineProgress.value = data.pipelineProgress;
        queuePosition.value = data.queuePosition;
        files.value = data.files;
        masterPlaylist.value = data.masterPlaylist;
        anglePlaylists.value = data.anglePlaylists;
        error.value = data.error;
        encoder.value = data.encoder;
        segmentFormat.value = data.segmentFormat;
        thumbnailsVtt.value = data.thumbnailsVtt;
        encryptionKeyHex.value = data.encryptionKeyHex;
        // Carry through the ingest total — once the URL probe reports it,
        // it remains valid for the duration of the upload phase, so don't
        // clear it on subsequent events that omit the field.
        if (data.ingestTotalBytes != null) {
            ingestTotalBytes.value = data.ingestTotalBytes;
        }
    }

    function stop() {
        eventSource?.close();
        eventSource = null;
        if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
        }
        polling.value = false;
    }

    function start(
        sessionId: string,
        encodingApiUrl: string,
        sessionToken: string,
    ) {
        stop();

        status.value = null;
        progress.value = undefined;
        pipelineProgress.value = undefined;
        queuePosition.value = undefined;
        files.value = undefined;
        masterPlaylist.value = undefined;
        anglePlaylists.value = undefined;
        error.value = undefined;
        encoder.value = undefined;
        segmentFormat.value = undefined;
        thumbnailsVtt.value = undefined;
        encryptionKeyHex.value = undefined;
        ingestTotalBytes.value = undefined;

        polling.value = true;

        getSessionStatus(encodingApiUrl, sessionId, sessionToken)
            .then((data) => {
                applyUpdate(data);
                if (TERMINAL_STATUSES.includes(data.status)) {
                    stop();
                }
            })
            .catch((e) => {
                error.value = errorMessage(e);
            });

        eventSource = subscribeSessionEvents(
            encodingApiUrl,
            sessionId,
            sessionToken,
            (event) => {
                applyUpdate(event);
                if (TERMINAL_STATUSES.includes(event.status)) {
                    getSessionStatus(encodingApiUrl, sessionId, sessionToken)
                        .then(applyUpdate)
                        .catch(() => {})
                        .finally(() => stop());
                }
            },
            () => {
                if (!polling.value) return;
                eventSource?.close();
                eventSource = null;

                if (!fallbackTimer) {
                    fallbackTimer = setInterval(async () => {
                        try {
                            const data = await getSessionStatus(
                                encodingApiUrl,
                                sessionId,
                                sessionToken,
                            );
                            applyUpdate(data);
                            if (TERMINAL_STATUSES.includes(data.status)) {
                                stop();
                            }
                        } catch (e) {
                            error.value = errorMessage(e);
                            stop();
                        }
                    }, FALLBACK_POLL_INTERVAL_MS);
                }
            },
        );
    }

    onUnmounted(stop);

    return {
        status: readonly(status),
        progress: readonly(progress),
        pipelineProgress: readonly(pipelineProgress),
        queuePosition: readonly(queuePosition),
        files: readonly(files),
        masterPlaylist: readonly(masterPlaylist),
        anglePlaylists: readonly(anglePlaylists),
        error: readonly(error),
        encoder: readonly(encoder),
        segmentFormat: readonly(segmentFormat),
        thumbnailsVtt: readonly(thumbnailsVtt),
        encryptionKeyHex: readonly(encryptionKeyHex),
        ingestTotalBytes: readonly(ingestTotalBytes),
        polling: readonly(polling),
        start,
        stop,
    };
}
