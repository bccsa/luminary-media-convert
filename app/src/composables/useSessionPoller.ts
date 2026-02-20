import { ref, readonly, onUnmounted } from 'vue';
import { getSessionStatus } from '../api';
import type { Credentials, SessionStatus, SessionStatusResponse } from '../types';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES: SessionStatus[] = ['completed', 'failed'];

export function useSessionPoller() {
    const status = ref<SessionStatus | null>(null);
    const progress = ref<number | undefined>();
    const queuePosition = ref<number | undefined>();
    const files = ref<string[] | undefined>();
    const masterPlaylist = ref<string | undefined>();
    const error = ref<string | undefined>();
    const polling = ref(false);

    let timer: ReturnType<typeof setInterval> | null = null;

    function applyUpdate(data: SessionStatusResponse) {
        status.value = data.status;
        progress.value = data.progress;
        queuePosition.value = data.queuePosition;
        files.value = data.files;
        masterPlaylist.value = data.masterPlaylist;
        error.value = data.error;
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        polling.value = false;
    }

    async function poll(baseUrl: string, sessionId: string, credentials: Credentials) {
        try {
            const data = await getSessionStatus(baseUrl, sessionId, credentials);
            applyUpdate(data);

            if (TERMINAL_STATUSES.includes(data.status)) {
                stop();
            }
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            stop();
        }
    }

    function start(baseUrl: string, sessionId: string, credentials: Credentials) {
        stop();
        polling.value = true;
        poll(baseUrl, sessionId, credentials);
        timer = setInterval(() => poll(baseUrl, sessionId, credentials), POLL_INTERVAL_MS);
    }

    onUnmounted(stop);

    return {
        status: readonly(status),
        progress: readonly(progress),
        queuePosition: readonly(queuePosition),
        files: readonly(files),
        masterPlaylist: readonly(masterPlaylist),
        error: readonly(error),
        polling: readonly(polling),
        start,
        stop,
    };
}
