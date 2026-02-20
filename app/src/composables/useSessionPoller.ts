import { ref, readonly, onUnmounted } from 'vue';
import { getSessionStatus } from '../api';
import type { SessionStatus, SessionStatusResponse } from '../types';

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

    async function poll(sessionId: string, getToken: () => Promise<string>) {
        try {
            const token = await getToken();
            const data = await getSessionStatus(sessionId, token);
            applyUpdate(data);

            if (TERMINAL_STATUSES.includes(data.status)) {
                stop();
            }
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            stop();
        }
    }

    function start(sessionId: string, getToken: () => Promise<string>) {
        stop();
        polling.value = true;
        poll(sessionId, getToken);
        timer = setInterval(() => poll(sessionId, getToken), POLL_INTERVAL_MS);
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
