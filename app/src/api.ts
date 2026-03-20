import * as tus from 'tus-js-client';
import type {
    CreateSessionRequest,
    SaasSessionResponse,
    EncodeConfig,
    EncodeStartResponse,
    SessionStatusResponse,
} from './types';

// SaaS Service — session lifecycle (authenticated)
const SAAS_URL = import.meta.env.VITE_SAAS_SERVICE_URL;

// ---------------------------------------------------------------------------
// SaaS Service calls (access token)
// ---------------------------------------------------------------------------

export async function checkIdentity(
    accessToken: string,
): Promise<{ id: string; email: string; name: string; status: string }> {
    const res = await fetch(`${SAAS_URL}/saas/me`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Identity check failed (${res.status})`);
    }

    return res.json();
}

export async function createSession(
    config: CreateSessionRequest,
    accessToken: string,
): Promise<SaasSessionResponse> {
    const res = await fetch(`${SAAS_URL}/saas/sessions`, {
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

export async function deleteSession(
    sessionId: string,
    accessToken: string,
): Promise<void> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}`, {
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

// ---------------------------------------------------------------------------
// Encoding API calls (session token — direct)
// ---------------------------------------------------------------------------

export function uploadFile(
    tusEndpoint: string,
    sessionId: string,
    sessionToken: string,
    file: File,
    onProgress?: (percent: number) => void,
): { promise: Promise<void>; abort: () => void } {
    let abortFn: () => void = () => {};

    const promise = new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
            endpoint: tusEndpoint,
            retryDelays: [0, 1000, 3000, 5000],
            removeFingerprintOnSuccess: true,
            metadata: {
                sessionId,
                filename: file.name,
                filetype: file.type,
            },
            headers: {
                Authorization: `Bearer ${sessionToken}`,
            },
            chunkSize: 50 * 1024 * 1024,
            parallelUploads: 5,
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
    encodingApiUrl: string,
    sessionId: string,
    encodeConfig: EncodeConfig,
    sessionToken: string,
): Promise<EncodeStartResponse> {
    const res = await fetch(`${encodingApiUrl}/api/sessions/${sessionId}/encode`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(encodeConfig),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Encode start failed (${res.status})`);
    }

    return res.json();
}

export async function getSessionStatus(
    encodingApiUrl: string,
    sessionId: string,
    sessionToken: string,
): Promise<SessionStatusResponse> {
    const res = await fetch(`${encodingApiUrl}/api/sessions/${sessionId}`, {
        headers: {
            Authorization: `Bearer ${sessionToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Status poll failed (${res.status})`);
    }

    return res.json();
}

export function subscribeSessionEvents(
    encodingApiUrl: string,
    sessionId: string,
    sessionToken: string,
    onEvent: (event: SessionStatusResponse) => void,
    onError?: (error: Event) => void,
): EventSource {
    const url = `${encodingApiUrl}/api/sessions/${sessionId}/events?token=${encodeURIComponent(sessionToken)}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
        try {
            onEvent(JSON.parse(msg.data));
        } catch {
            // ignore parse errors
        }
    };
    if (onError) {
        es.onerror = onError;
    }
    return es;
}
