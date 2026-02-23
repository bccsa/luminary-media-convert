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

export function uploadFile(
    sessionId: string,
    uploadToken: string,
    file: File,
    onProgress?: (percent: number) => void,
): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_URL}/api/sessions/${sessionId}/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`);

        if (onProgress) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            };
        }

        xhr.onload = () => {
            let body: any;
            try {
                body = JSON.parse(xhr.responseText);
            } catch {
                body = {};
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(body as UploadResponse);
            } else {
                reject(new Error(body.message || `File upload failed (${xhr.status})`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error during file upload'));
        xhr.ontimeout = () => reject(new Error('File upload timed out'));

        const form = new FormData();
        form.append('file', file);
        xhr.send(form);
    });
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
