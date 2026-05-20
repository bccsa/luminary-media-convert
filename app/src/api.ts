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
): Promise<{ id: string; email: string; name: string; status: string; encodingApiUrl?: string }> {
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

export async function startUrlUpload(
    sessionId: string,
    url: string,
    accessToken: string,
    filename?: string,
): Promise<void> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/url-upload`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ url, filename }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `URL ingestion failed (${res.status})`);
    }
}

export async function deleteSession(
    sessionId: string,
    accessToken: string,
    deleteFiles = false,
): Promise<void> {
    const query = deleteFiles ? '?deleteFiles=true' : '';
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}${query}`, {
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

// ---------------------------------------------------------------------------
// SaaS Service — API Keys
// ---------------------------------------------------------------------------

export async function createApiKey(
    accessToken: string,
    name: string,
): Promise<{ id: string; key: string }> {
    // Generate key client-side — the raw key never leaves the browser
    const rawBytes = crypto.getRandomValues(new Uint8Array(32));
    const rawKey = 'lmc_' + btoa(String.fromCharCode(...rawBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const prefix = rawKey.substring(0, 12);

    // SHA-256 hash — only this is sent to the server
    const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(rawKey),
    );
    const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const res = await fetch(`${SAAS_URL}/saas/keys`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name, keyHash, prefix }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `API key creation failed (${res.status})`);
    }

    const result = await res.json();
    return { id: result.id, key: rawKey };
}

export async function listApiKeys(
    accessToken: string,
): Promise<any[]> {
    const res = await fetch(`${SAAS_URL}/saas/keys`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to list API keys (${res.status})`);
    }

    return res.json();
}

export async function revokeApiKey(
    accessToken: string,
    keyId: string,
): Promise<void> {
    const res = await fetch(`${SAAS_URL}/saas/keys/${keyId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `API key revocation failed (${res.status})`);
    }
}

// ---------------------------------------------------------------------------
// SaaS Service — S3 Configurations
// ---------------------------------------------------------------------------

export async function listS3Configs(
    accessToken: string,
): Promise<{ configs: any[] }> {
    const res = await fetch(`${SAAS_URL}/saas/s3-configs`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to list S3 configs (${res.status})`);
    }

    return res.json();
}

export async function createS3Config(
    accessToken: string,
    data: Record<string, any>,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/s3-configs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `S3 config creation failed (${res.status})`);
    }

    return res.json();
}

export async function getS3Config(
    accessToken: string,
    configId: string,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to get S3 config (${res.status})`);
    }

    return res.json();
}

export async function updateS3Config(
    accessToken: string,
    configId: string,
    data: Record<string, any>,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `S3 config update failed (${res.status})`);
    }

    return res.json();
}

export async function deleteS3Config(
    accessToken: string,
    configId: string,
): Promise<void> {
    const res = await fetch(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `S3 config deletion failed (${res.status})`);
    }
}

// ---------------------------------------------------------------------------
// SaaS Service — Session History
// ---------------------------------------------------------------------------

export async function listSessions(
    accessToken: string,
    opts?: { limit?: number; skip?: number; status?: string; name?: string },
): Promise<{ sessions: any[]; total: number }> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.skip != null) params.set('skip', String(opts.skip));
    if (opts?.status) params.set('status', opts.status);
    if (opts?.name) params.set('name', opts.name);

    const qs = params.toString();
    const url = `${SAAS_URL}/saas/sessions${qs ? `?${qs}` : ''}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to list sessions (${res.status})`);
    }

    return res.json();
}

export async function getSessionDetail(
    accessToken: string,
    sessionId: string,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to get session detail (${res.status})`);
    }

    return res.json();
}

export async function updateSessionName(
    accessToken: string,
    sessionId: string,
    name: string,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/name`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to update session name (${res.status})`);
    }

    return res.json();
}

export async function checkPrefix(
    accessToken: string,
    s3ConfigId: string,
    prefix: string,
): Promise<{ exists: boolean; count: number }> {
    const params = new URLSearchParams({ s3ConfigId, prefix });
    const res = await fetch(`${SAAS_URL}/saas/sessions/check-prefix?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Check prefix failed (${res.status})`);
    }

    return res.json();
}

export async function moveSessionFiles(
    accessToken: string,
    sessionId: string,
    targetS3ConfigId: string,
    newPathPrefix: string,
): Promise<any> {
    const body = { targetS3ConfigId, newPathPrefix };

    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/move`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Move failed (${res.status})`);
    }

    return res.json();
}

export async function renameSessionPrefix(
    accessToken: string,
    sessionId: string,
    newPathPrefix: string,
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/rename-prefix`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ newPathPrefix }),
    });

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Rename prefix failed (${res.status})`);
    }

    return res.json();
}

export async function importSession(
    accessToken: string,
    data: {
        s3ConfigId: string;
        masterPlaylistKey?: string;
        folderPrefix?: string;
        encryptionKey?: string;
    },
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/import`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Session import failed (${res.status})`);
    }

    return res.json();
}

// --- HLS sidecar edit bindings -----------------------------------------

import type { HlsParsedMaster } from '@luminary-media-converter/hls';

export interface HlsReadResult {
    master: HlsParsedMaster;
    etag: string;
    folderPrefix: string;
    masterPlaylistKey: string;
}

export interface HlsMutateOperation {
    type: 'upsertSubtitle' | 'removeSubtitle' | 'upsertChapters' | 'removeChapters';
    language?: string;
    name?: string;
    vttBase64?: string;
    default?: boolean;
    forced?: boolean;
}

/**
 * Signalled by the SaaS wrapper (pass-through from /api/hls/mutate) when
 * master.m3u8 was modified between the caller's /read and /mutate. The
 * current ETag is included in `currentEtag` so the caller can refetch
 * and retry.
 */
export class HlsConflictError extends Error {
    readonly status = 409;
    constructor(
        message: string,
        public readonly currentEtag: string | undefined,
    ) {
        super(message);
        this.name = 'HlsConflictError';
    }
}

export async function hlsRead(
    accessToken: string,
    sessionId: string,
): Promise<HlsReadResult> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/hls/read`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HLS read failed (${res.status})`);
    }

    return res.json();
}

export async function hlsMutate(
    accessToken: string,
    sessionId: string,
    ifMatch: string,
    operations: HlsMutateOperation[],
): Promise<any> {
    const res = await fetch(`${SAAS_URL}/saas/sessions/${sessionId}/hls/mutate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ ifMatch, operations }),
    });

    if (res.status === 409) {
        const body = await res.json().catch(() => ({} as { currentEtag?: string; message?: string }));
        throw new HlsConflictError(
            body.message || 'Master playlist was modified since last read',
            body.currentEtag,
        );
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HLS mutate failed (${res.status})`);
    }

    return res.json();
}

// --- Chapter sidecar bindings ------------------------------------------

/**
 * Fetch the chapter VTT for a session. Returns null when no file exists.
 */
export async function getSessionChapters(
    accessToken: string,
    sessionId: string,
    lang: string = 'en',
): Promise<{ vtt: string } | null> {
    const res = await fetch(
        `${SAAS_URL}/saas/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Get chapters failed (${res.status})`);
    }
    return res.json();
}

/**
 * Fetch the waveform sidecar (waveform.json) for a completed session.
 * Returns null when no sidecar exists — e.g. imported sessions or sessions
 * encoded before the sidecar was wired in.
 */
export async function getSessionWaveform(
    accessToken: string,
    sessionId: string,
): Promise<{
    version: number;
    sampleRate: number;
    numPeaks: number;
    peaks: number[];
} | null> {
    const res = await fetch(
        `${SAAS_URL}/saas/sessions/${sessionId}/waveform`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Get waveform failed (${res.status})`);
    }
    return res.json();
}

/**
 * Persist the chapter VTT to S3. Server validates BCP-47 lang + WEBVTT body.
 */
export async function putSessionChapters(
    accessToken: string,
    sessionId: string,
    vtt: string,
    lang: string = 'en',
): Promise<void> {
    const res = await fetch(
        `${SAAS_URL}/saas/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ vtt }),
        },
    );
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Save chapters failed (${res.status})`);
    }
}

