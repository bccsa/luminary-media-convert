import { ref, reactive } from 'vue';

export interface ActiveUpload {
    progress: number;
    abort: () => void;
    promise: Promise<void>;
    done: boolean;
    error?: string;
}

// Module-level singleton state — survives component unmount/remount
const uploadsRecord = ref<Record<string, ActiveUpload>>({});

export function useActiveUploads() {
    function register(
        sessionId: string,
        abort: () => void,
        promise: Promise<void>,
    ) {
        const upload: ActiveUpload = reactive({
            progress: 0,
            abort,
            promise,
            done: false,
        });

        uploadsRecord.value = { ...uploadsRecord.value, [sessionId]: upload };

        promise
            .then(() => {
                upload.done = true;
            })
            .catch((err) => {
                upload.done = true;
                upload.error = err instanceof Error ? err.message : String(err);
            });

        return upload;
    }

    function setProgress(sessionId: string, percent: number) {
        const upload = uploadsRecord.value[sessionId];
        if (upload) upload.progress = percent;
    }

    function getUpload(sessionId: string): ActiveUpload | undefined {
        return uploadsRecord.value[sessionId];
    }

    function remove(sessionId: string) {
        const { [sessionId]: _, ...rest } = uploadsRecord.value;
        uploadsRecord.value = rest;
    }

    return { uploads: uploadsRecord, register, setProgress, getUpload, remove };
}
