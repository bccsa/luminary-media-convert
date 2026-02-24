import * as tus from 'tus-js-client';
import type {
    CreateSessionRequest,
    SessionResponse,
    EncodeConfig,
    EncodeStartResponse,
    SessionStatusResponse,
} from './types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

export async function createSession(
    config: CreateSessionRequest,
    accessToken: string,
): Promise<SessionResponse> {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(config),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Session creation failed (${res.status})`);
    }

    return res.json();
}

export function uploadFile(
    tusEndpoint: string,
    sessionId: string,
    uploadToken: string,
    file: File,
    onProgress?: (percent: number) => void,
): { promise: Promise<void>; abort: () => void } {
    let abortFn: () => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
            endpoint: tusEndpoint,
            retryDelays: [0, 1000, 3000, 5000],
            metadata: {
                sessionId,
                filename: file.name,
                filetype: file.type,
            },
            headers: {
                Authorization: `Bearer ${uploadToken}`,
            },
            chunkSize: 50 * 1024 * 1024,
            onProgress(bytesUploaded, bytesTotal) {
                onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
            },
            onSuccess() {
                resolve();
            },
            onError(error) {
                reject(error);
            },
        });

        abortFn = () => upload.abort(true);
        upload.start();
    });

    return { promise, abort: abortFn };
}

export async function startEncode(
    sessionId: string,
    encodeConfig: EncodeConfig,
    accessToken: string,
): Promise<EncodeStartResponse> {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/encode`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(encodeConfig),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Encode start failed (${res.status})`);
    }

    return res.json();
}

export async function deleteSession(
    sessionId: string,
    accessToken: string,
): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Session deletion failed (${res.status})`);
    }
}

export async function getSessionStatus(
    sessionId: string,
    accessToken: string,
): Promise<SessionStatusResponse> {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Status poll failed (${res.status})`);
    }

    return res.json();
}
