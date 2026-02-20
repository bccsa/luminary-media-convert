import type {
    CreateSessionRequest,
    SessionResponse,
    UploadResponse,
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

export async function uploadFile(
    sessionId: string,
    uploadToken: string,
    file: File,
): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/upload`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${uploadToken}`,
        },
        body: form,
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `File upload failed (${res.status})`);
    }

    return res.json();
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
