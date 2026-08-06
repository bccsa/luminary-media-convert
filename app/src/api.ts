import { getApiToken } from './auth-token';
import type {
    EncodeConfig,
    EncodeStartResponse,
    SessionStatusResponse,
    SessionSummary,
} from './types';

/**
 * Base URL of the local Encoding API.
 *
 * The packaged app serves the renderer from the API's own origin, so the empty
 * default produces same-origin requests. `VITE_API_URL` covers browser dev,
 * where the UI is on Vite's port and the API on its own.
 */
export const API_BASE = import.meta.env.VITE_API_URL ?? '';

// ---------------------------------------------------------------------------
// Fetch helpers
//
// Every endpoint shares the same shape: a credential, an optional JSON body,
// and an error path that reads `{ message }` off the response (falling back to
// a "<prefix> (<status>)" string). These helpers collapse that boilerplate.
// ---------------------------------------------------------------------------

interface RequestSpec {
    /** HTTP method; omit for GET. */
    method?: string;
    /** Session token, sent as `Authorization: Bearer <token>`. */
    token?: string;
    /**
     * Authenticate with the UI token instead (the `X-API-Key` header). Used
     * for the instance-wide routes, and for session routes reached before a
     * session token is in hand.
     */
    apiKey?: boolean;
    /** JSON request body; when set, serializes and adds the Content-Type header. */
    body?: unknown;
    /** Message prefix for thrown errors, e.g. `'Encode start failed'`. */
    errorPrefix: string;
}

async function buildInit(spec: RequestSpec): Promise<RequestInit> {
    const headers: Record<string, string> = {};
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.token) headers.Authorization = `Bearer ${spec.token}`;
    if (spec.apiKey) headers['X-API-Key'] = await getApiToken();

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
    const res = await fetch(url, await buildInit(spec));
    if (!res.ok) await fail(res, spec.errorPrefix);
    return res.json() as Promise<T>;
}

/** Fetch with no response body, throwing a normalized Error on a non-ok response. */
async function requestVoid(url: string, spec: RequestSpec): Promise<void> {
    const res = await fetch(url, await buildInit(spec));
    if (!res.ok) await fail(res, spec.errorPrefix);
}

/** Like {@link requestJson} but returns null on a 404 instead of throwing. */
async function requestJsonOrNull<T>(
    url: string,
    spec: RequestSpec
): Promise<T | null> {
    const res = await fetch(url, await buildInit(spec));
    if (res.status === 404) return null;
    if (!res.ok) await fail(res, spec.errorPrefix);
    return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Every session on this instance, newest first. Master-key only, and the one
 * place session tokens are handed out.
 */
export async function listSessions(): Promise<SessionSummary[]> {
    return requestJson(`${API_BASE}/api/sessions`, {
        apiKey: true,
        errorPrefix: 'Failed to list sessions',
    });
}

/** Full status for one session, authenticated with the UI token. */
export async function getSession(
    sessionId: string
): Promise<SessionStatusResponse> {
    return requestJson(`${API_BASE}/api/sessions/${sessionId}`, {
        apiKey: true,
        errorPrefix: 'Failed to load session',
    });
}

/** Poll status with the session's own token (used by the poller's SSE fallback). */
export async function getSessionStatus(
    sessionId: string,
    sessionToken: string
): Promise<SessionStatusResponse> {
    return requestJson(`${API_BASE}/api/sessions/${sessionId}`, {
        token: sessionToken,
        errorPrefix: 'Status poll failed',
    });
}

/**
 * Attach a file already on this machine to the session. The encoder reads it
 * where it lies — nothing is copied — so this returns as soon as the source
 * has been probed.
 */
export async function ingestLocalFile(
    sessionId: string,
    path: string,
    sessionToken: string
): Promise<SessionStatusResponse> {
    return requestJson(`${API_BASE}/api/sessions/${sessionId}/local-file`, {
        method: 'POST',
        token: sessionToken,
        body: { path },
        errorPrefix: 'Could not open that file',
    });
}

export async function startEncode(
    sessionId: string,
    encodeConfig: EncodeConfig,
    sessionToken: string
): Promise<EncodeStartResponse> {
    return requestJson(`${API_BASE}/api/sessions/${sessionId}/encode`, {
        method: 'POST',
        token: sessionToken,
        body: encodeConfig,
        errorPrefix: 'Encode start failed',
    });
}

/**
 * Cancel a running session, or dismiss a finished one. Either way the work
 * directory goes with it, which is the only way its disk is reclaimed.
 */
export async function deleteSession(
    sessionId: string,
    sessionToken?: string
): Promise<void> {
    return requestVoid(`${API_BASE}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        ...(sessionToken ? { token: sessionToken } : { apiKey: true }),
        errorPrefix: 'Session deletion failed',
    });
}

export function subscribeSessionEvents(
    sessionId: string,
    sessionToken: string,
    onEvent: (event: SessionStatusResponse) => void,
    onError?: (error: Event) => void
): EventSource {
    const url = `${API_BASE}/api/sessions/${sessionId}/events?token=${encodeURIComponent(sessionToken)}`;
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
// Trusted origins
// ---------------------------------------------------------------------------

export interface OriginDecisions {
    allowed: string[];
    denied: string[];
}

/** Every site this encoder has been told to trust, or to refuse. */
export async function listOrigins(): Promise<OriginDecisions> {
    return requestJson(`${API_BASE}/api/origins`, {
        apiKey: true,
        errorPrefix: 'Failed to load trusted sites',
    });
}

/**
 * Forget a decision. Revoking an allow shuts the site out; revoking a block
 * lets it ask again the next time it calls.
 */
export async function revokeOrigin(origin: string): Promise<void> {
    return requestVoid(
        `${API_BASE}/api/origins?origin=${encodeURIComponent(origin)}`,
        { method: 'DELETE', apiKey: true, errorPrefix: 'Failed to update trusted sites' },
    );
}

// ---------------------------------------------------------------------------
// Chapter sidecar
// ---------------------------------------------------------------------------

/**
 * Fetch the chapter VTT for a session. Returns null when no file exists — the
 * common case, since a session has no chapters until someone writes some.
 */
export async function getChapters(
    sessionId: string,
    lang: string,
    sessionToken: string
): Promise<{ vtt: string } | null> {
    return requestJsonOrNull(
        `${API_BASE}/api/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        { token: sessionToken, errorPrefix: 'Get chapters failed' }
    );
}

/**
 * Persist the chapter VTT to the session's own bucket and prefix. The server
 * validates the BCP-47 language and the WEBVTT body.
 */
export async function putChapters(
    sessionId: string,
    lang: string,
    vtt: string,
    sessionToken: string
): Promise<void> {
    return requestVoid(
        `${API_BASE}/api/sessions/${sessionId}/chapters?lang=${encodeURIComponent(lang)}`,
        {
            method: 'PUT',
            token: sessionToken,
            body: { vtt },
            errorPrefix: 'Save chapters failed',
        }
    );
}
