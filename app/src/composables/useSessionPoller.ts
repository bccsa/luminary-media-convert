import { ref, readonly, onUnmounted } from 'vue';
import { getSessionStatus, subscribeSessionEvents } from '../api';
import type { AccelMode, SegmentFormat, SessionStatus, SessionStatusResponse } from '../types';

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
    const queuePosition = ref<number | undefined>();
    const files = ref<string[] | undefined>();
    const masterPlaylist = ref<string | undefined>();
    const anglePlaylists = ref<{ name: string; key: string }[] | undefined>();
    const error = ref<string | undefined>();
    const encoder = ref<AccelMode | undefined>();
    const segmentFormat = ref<SegmentFormat | undefined>();
    const thumbnailsVtt = ref<string | undefined>();
    const previewBaseUrl = ref<string | undefined>();
    const previewToken = ref<string | undefined>();
    const polling = ref(false);

    let eventSource: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    function applyUpdate(data: SessionStatusResponse, force = false) {
        // Reject stale status updates (e.g. late SSE event for uploading_to_s3 after completed)
        if (
            !force &&
            status.value &&
            (STATUS_ORDER[data.status] ?? 0) < (STATUS_ORDER[status.value] ?? 0)
        ) {
            return;
        }

        status.value = data.status;
        progress.value = data.progress;
        queuePosition.value = data.queuePosition;
        files.value = data.files;
        masterPlaylist.value = data.masterPlaylist;
        anglePlaylists.value = data.anglePlaylists;
        error.value = data.error;
        encoder.value = data.encoder;
        segmentFormat.value = data.segmentFormat;
        thumbnailsVtt.value = data.thumbnailsVtt;
        previewBaseUrl.value = data.previewBaseUrl;
        previewToken.value = data.sessionToken;
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

        // Reset all state from any previous session
        status.value = null;
        progress.value = undefined;
        queuePosition.value = undefined;
        files.value = undefined;
        masterPlaylist.value = undefined;
        anglePlaylists.value = undefined;
        error.value = undefined;
        encoder.value = undefined;
        segmentFormat.value = undefined;
        thumbnailsVtt.value = undefined;
        previewBaseUrl.value = undefined;
        previewToken.value = undefined;

        polling.value = true;

        // Initial poll for full state (encoder, previewBaseUrl, etc.)
        getSessionStatus(encodingApiUrl, sessionId, sessionToken)
            .then((data) => {
                applyUpdate(data);
                if (TERMINAL_STATUSES.includes(data.status)) {
                    stop();
                }
            })
            .catch((e) => {
                error.value = e instanceof Error ? e.message : String(e);
            });

        // SSE stream for real-time updates
        eventSource = subscribeSessionEvents(
            encodingApiUrl,
            sessionId,
            sessionToken,
            (event) => {
                applyUpdate(event);
                if (TERMINAL_STATUSES.includes(event.status)) {
                    // Do a final poll to get full completed state (previewBaseUrl, etc.)
                    getSessionStatus(encodingApiUrl, sessionId, sessionToken)
                        .then(applyUpdate)
                        .catch(() => {})
                        .finally(() => stop());
                }
            },
            () => {
                // SSE error — fall back to polling
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
                            error.value = e instanceof Error ? e.message : String(e);
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
        queuePosition: readonly(queuePosition),
        files: readonly(files),
        masterPlaylist: readonly(masterPlaylist),
        anglePlaylists: readonly(anglePlaylists),
        error: readonly(error),
        encoder: readonly(encoder),
        segmentFormat: readonly(segmentFormat),
        thumbnailsVtt: readonly(thumbnailsVtt),
        previewBaseUrl: readonly(previewBaseUrl),
        previewToken: readonly(previewToken),
        polling: readonly(polling),
        start,
        stop,
    };
}
