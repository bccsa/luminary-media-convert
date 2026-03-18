import { ref, readonly, onUnmounted } from 'vue';
import { getSessionStatus } from '../api';
import type { AccelMode, SegmentFormat, SessionStatus, SessionStatusResponse } from '../types';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES: SessionStatus[] = ['completed', 'failed'];

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

    let timer: ReturnType<typeof setInterval> | null = null;

    function applyUpdate(data: SessionStatusResponse) {
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
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        polling.value = false;
    }

    async function poll(
        sessionId: string,
        encodingApiUrl: string,
        sessionToken: string,
    ) {
        try {
            const data = await getSessionStatus(encodingApiUrl, sessionId, sessionToken);
            applyUpdate(data);

            if (TERMINAL_STATUSES.includes(data.status)) {
                stop();
            }
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            stop();
        }
    }

    function start(
        sessionId: string,
        encodingApiUrl: string,
        sessionToken: string,
    ) {
        stop();
        polling.value = true;
        poll(sessionId, encodingApiUrl, sessionToken);
        timer = setInterval(
            () => poll(sessionId, encodingApiUrl, sessionToken),
            POLL_INTERVAL_MS,
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
