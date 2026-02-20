import type {
    Credentials,
    CreateSessionRequest,
    SessionResponse,
    UploadResponse,
    SessionStatusResponse,
} from './types';

function basicAuthHeader(creds: Credentials): string {
    return 'Basic ' + btoa(`${creds.username}:${creds.password}`);
}

export async function createSession(
    baseUrl: string,
    config: CreateSessionRequest,
    credentials: Credentials,
): Promise<SessionResponse> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: basicAuthHeader(credentials),
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
    baseUrl: string,
    sessionId: string,
    uploadToken: string,
    file: File,
): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/upload`, {
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

export async function getSessionStatus(
    baseUrl: string,
    sessionId: string,
    credentials: Credentials,
): Promise<SessionStatusResponse> {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        headers: {
            Authorization: basicAuthHeader(credentials),
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Status poll failed (${res.status})`);
    }

    return res.json();
}
