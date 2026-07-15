import * as tus from 'tus-js-client';
import type { HlsParsedMaster } from '@luminary-media-converter/hls';
import type {
    CreateSessionRequest,
    SaasSessionResponse,
    EncodeConfig,
    EncodeStartResponse,
    SessionStatusResponse,
    ApiKeyResponse,
    S3ConfigSummary,
    S3ConfigDetail,
    ImportSessionResponse,
    SessionDetailResponse,
    SessionListResponse,
} from './types';

// SaaS Service — session lifecycle (authenticated)
const SAAS_URL = import.meta.env.VITE_SAAS_SERVICE_URL;

// ---------------------------------------------------------------------------
// Fetch helpers
//
// Every endpoint shares the same shape: bearer auth, optional JSON body, and an
// error path that reads `{ message }` off the response (falling back to a
// "<prefix> (<status>)" string). These helpers collapse that boilerplate.
// ---------------------------------------------------------------------------

interface RequestSpec {
    /** HTTP method; omit for GET. */
    method?: string;
    /** Bearer token (Auth0 access token or session token). */
    token?: string;
    /** JSON request body; when set, serializes and adds the Content-Type header. */
    body?: unknown;
    /** Message prefix for thrown errors, e.g. `'Session creation failed'`. */
    errorPrefix: string;
}

function buildInit(spec: RequestSpec): RequestInit {
    const headers: Record<string, string> = {};
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.token) headers.Authorization = `Bearer ${spec.token}`;

    const init: RequestInit = { headers };
    if (spec.method) init.method = spec.method;
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
    return init;
}

async function fail(res: Response, errorPrefix: string): Promise<never> {
    const body = await res.json().catch(() => ({}) as { message?: string });
    throw new Error(body.message || `${errorPrefix} (${res.status})`);
}

/** Fetch + parse JSON, throwing a normalized Error on a non-ok response. */
async function requestJson<T>(url: string, spec: RequestSpec): Promise<T> {
    const res = await fetch(url, buildInit(spec));
    if (!res.ok) await fail(res, spec.errorPrefix);
    return res.json() as Promise<T>;
}

/** Fetch with no response body, throwing a normalized Error on a non-ok response. */
async function requestVoid(url: string, spec: RequestSpec): Promise<void> {
    const res = await fetch(url, buildInit(spec));
    if (!res.ok) await fail(res, spec.errorPrefix);
}

/** Like {@link requestJson} but returns null on a 404 instead of throwing. */
async function requestJsonOrNull<T>(
    url: string,
    spec: RequestSpec,
): Promise<T | null> {
    const res = await fetch(url, buildInit(spec));
    if (res.status === 404) return null;
    if (!res.ok) await fail(res, spec.errorPrefix);
    return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// SaaS Service calls (access token)
// ---------------------------------------------------------------------------

export async function checkIdentity(
    accessToken: string,
): Promise<{ id: string; email: string; name: string; status: string; encodingApiUrl?: string }> {
    return requestJson(`${SAAS_URL}/saas/me`, {
        token: accessToken,
        errorPrefix: 'Identity check failed',
    });
}

export async function createSession(
    config: CreateSessionRequest,
    accessToken: string,
): Promise<SaasSessionResponse> {
    return requestJson(`${SAAS_URL}/saas/sessions`, {
        method: 'POST',
        token: accessToken,
        body: config,
        errorPrefix: 'Session creation failed',
    });
}

export async function startUrlUpload(
    sessionId: string,
    url: string,
    accessToken: string,
    filename?: string,
): Promise<void> {
    return requestVoid(`${SAAS_URL}/saas/sessions/${sessionId}/url-upload`, {
        method: 'POST',
        token: accessToken,
        body: { url, filename },
        errorPrefix: 'URL ingestion failed',
    });
}

export async function deleteSession(
    sessionId: string,
    accessToken: string,
    deleteFiles = false,
): Promise<void> {
    const query = deleteFiles ? '?deleteFiles=true' : '';
    return requestVoid(`${SAAS_URL}/saas/sessions/${sessionId}${query}`, {
        method: 'DELETE',
        token: accessToken,
        errorPrefix: 'Session deletion failed',
    });
}

// ---------------------------------------------------------------------------
// Encoding API calls (session token — direct)
// ---------------------------------------------------------------------------

// Above this size, upload as a single stream instead of parallel parts.
// Parallel uploads end with a tus concatenation POST that makes the server
// copy all parts into one file — for multi-GB files that copy takes minutes,
// which exceeds the reverse proxy's request timeout. The proxy then returns
// 502, tus-js retries the whole finalize, and every retry leaves another
// full-size copy on the server's disk until it fills up. A single stream has
// no concatenation step: only short 50 MB PATCH requests, nothing to time out.
const PARALLEL_UPLOAD_MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

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
            parallelUploads:
                file.size >= PARALLEL_UPLOAD_MAX_FILE_BYTES ? 1 : 5,
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
    return requestJson(`${encodingApiUrl}/api/sessions/${sessionId}/encode`, {
        method: 'POST',
        token: sessionToken,
        body: encodeConfig,
        errorPrefix: 'Encode start failed',
    });
}

export async function getSessionStatus(
    encodingApiUrl: string,
    sessionId: string,
    sessionToken: string,
): Promise<SessionStatusResponse> {
    return requestJson(`${encodingApiUrl}/api/sessions/${sessionId}`, {
        token: sessionToken,
        errorPrefix: 'Status poll failed',
    });
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

    const result = await requestJson<{ id: string }>(`${SAAS_URL}/saas/keys`, {
        method: 'POST',
        token: accessToken,
        body: { name, keyHash, prefix },
        errorPrefix: 'API key creation failed',
    });
    return { id: result.id, key: rawKey };
}

export async function listApiKeys(accessToken: string): Promise<ApiKeyResponse[]> {
    return requestJson(`${SAAS_URL}/saas/keys`, {
        token: accessToken,
        errorPrefix: 'Failed to list API keys',
    });
}

export async function revokeApiKey(
    accessToken: string,
    keyId: string,
): Promise<void> {
    return requestVoid(`${SAAS_URL}/saas/keys/${keyId}`, {
        method: 'DELETE',
        token: accessToken,
        errorPrefix: 'API key revocation failed',
    });
}

// ---------------------------------------------------------------------------
// SaaS Service — S3 Configurations
// ---------------------------------------------------------------------------

export async function listS3Configs(
    accessToken: string,
): Promise<{ configs: S3ConfigSummary[] }> {
    return requestJson(`${SAAS_URL}/saas/s3-configs`, {
        token: accessToken,
        errorPrefix: 'Failed to list S3 configs',
    });
}

export async function createS3Config(
    accessToken: string,
    data: Record<string, unknown>,
): Promise<{ id: string }> {
    return requestJson(`${SAAS_URL}/saas/s3-configs`, {
        method: 'POST',
        token: accessToken,
        body: data,
        errorPrefix: 'S3 config creation failed',
    });
}

export interface S3ConnectivityResult {
    ok: boolean;
    reachable: boolean;
    bucketExists?: boolean;
    message: string;
}

export async function testS3Config(
    accessToken: string,
    data: Record<string, unknown>,
): Promise<S3ConnectivityResult> {
    return requestJson(`${SAAS_URL}/saas/s3-configs/test`, {
        method: 'POST',
        token: accessToken,
        body: data,
        errorPrefix: 'Storage connectivity test failed',
    });
}

export async function getS3Config(
    accessToken: string,
    configId: string,
): Promise<S3ConfigDetail> {
    return requestJson(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        token: accessToken,
        errorPrefix: 'Failed to get S3 config',
    });
}

export async function updateS3Config(
    accessToken: string,
    configId: string,
    data: Record<string, unknown>,
): Promise<S3ConfigDetail> {
    return requestJson(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        method: 'PATCH',
        token: accessToken,
        body: data,
        errorPrefix: 'S3 config update failed',
    });
}

export async function deleteS3Config(
    accessToken: string,
    configId: string,
): Promise<void> {
    return requestVoid(`${SAAS_URL}/saas/s3-configs/${configId}`, {
        method: 'DELETE',
        token: accessToken,
        errorPrefix: 'S3 config deletion failed',
    });
}

// ---------------------------------------------------------------------------
// SaaS Service — Session History
// ---------------------------------------------------------------------------

export async function listSessions(
    accessToken: string,
    opts?: { limit?: number; skip?: number; status?: string; name?: string },
): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.skip != null) params.set('skip', String(opts.skip));
    if (opts?.status) params.set('status', opts.status);
    if (opts?.name) params.set('name', opts.name);

    const qs = params.toString();
    return requestJson(`${SAAS_URL}/saas/sessions${qs ? `?${qs}` : ''}`, {
        token: accessToken,
        errorPrefix: 'Failed to list sessions',
    });
}

export async function getSessionDetail(
    accessToken: string,
    sessionId: string,
): Promise<SessionDetailResponse> {
    return requestJson(`${SAAS_URL}/saas/sessions/${sessionId}`, {
        token: accessToken,
        errorPrefix: 'Failed to get session detail',
    });
}

export async function updateSessionName(
    accessToken: string,
    sessionId: string,
    name: string,
): Promise<unknown> {
    return requestJson(`${SAAS_URL}/saas/sessions/${sessionId}/name`, {
        method: 'PATCH',
        token: accessToken,
        body: { name },
        errorPrefix: 'Failed to update session name',
    });
}

export async function checkPrefix(
    accessToken: string,
    s3ConfigId: string,
    prefix: string,
): Promise<{ exists: boolean; count: number }> {
    const params = new URLSearchParams({ s3ConfigId, prefix });
    return requestJson(`${SAAS_URL}/saas/sessions/check-prefix?${params}`, {
        token: accessToken,
        errorPrefix: 'Check prefix failed',
    });
}

export async function moveSessionFiles(
    accessToken: string,
    sessionId: string,
    targetS3ConfigId: string,
    newPathPrefix: string,
): Promise<unknown> {
    return requestJson(`${SAAS_URL}/saas/sessions/${sessionId}/move`, {
        method: 'POST',
        token: accessToken,
        body: { targetS3ConfigId, newPathPrefix },
        errorPrefix: 'Move failed',
    });
}

export async function renameSessionPrefix(
    accessToken: string,
    sessionId: string,
    newPathPrefix: string,
): Promise<unknown> {
    return requestJson(`${SAAS_URL}/saas/sessions/${sessionId}/rename-prefix`, {
        method: 'POST',
        token: accessToken,
        body: { newPathPrefix },
        errorPrefix: 'Rename prefix failed',
    });
}

export async function importSession(
    accessToken: string,
    data: {
        s3ConfigId: string;
        masterPlaylistKey?: string;
        folderPrefix?: string;
        encryptionKey?: string;
    },
): Promise<ImportSessionResponse> {
    return requestJson(`${SAAS_URL}/saas/sessions/import`, {
        method: 'POST',
        token: accessToken,
        body: data,
        errorPrefix: 'Session import failed',
    });
}

// --- HLS sidecar edit bindings -----------------------------------------

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
    return requestJson(`${SAAS_URL}/saas/sessions/${sessionId}/hls/read`, {
        method: 'POST',
        token: accessToken,
        errorPrefix: 'HLS read failed',
    });
}

export async function hlsMutate(
    accessToken: string,
    sessionId: string,
    ifMatch: string,
    operations: HlsMutateOperation[],
): Promise<unknown> {
    const res = await fetch(
        `${SAAS_URL}/saas/sessions/${sessionId}/hls/mutate`,
        buildInit({
            method: 'POST',
            token: accessToken,
            body: { ifMatch, operations },
            errorPrefix: 'HLS mutate failed',
        }),
    );

    if (res.status === 409) {
        const body = await res.json().catch(() => ({}) as { currentEtag?: string; message?: string });
        throw new HlsConflictError(
            body.message || 'Master playlist was modified since last read',
            body.currentEtag,
        );
    }

    if (!res.ok) await fail(res, 'HLS mutate failed');
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
    return requestJsonOrNull(
        `${SAAS_URL}/saas/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        { token: accessToken, errorPrefix: 'Get chapters failed' },
    );
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
    return requestJsonOrNull(`${SAAS_URL}/saas/sessions/${sessionId}/waveform`, {
        token: accessToken,
        errorPrefix: 'Get waveform failed',
    });
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
    return requestVoid(
        `${SAAS_URL}/saas/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        {
            method: 'PUT',
            token: accessToken,
            body: { vtt },
            errorPrefix: 'Save chapters failed',
        },
    );
}
