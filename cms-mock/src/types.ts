/**
 * The slice of the CMS <-> encoding-API contract this mock exercises.
 * Mirrors what the real Luminary CMS sends and stores.
 */

export interface S3Form {
    endPoint: string;
    port: number | null;
    useSSL: boolean;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    pathPrefix: string;
}

export interface SessionForm {
    documentId: string;
    title: string;
    s3: S3Form;
    publicBaseUrl: string;
    requireEncryption: boolean;
    thumbnails: boolean;
    byteRange: boolean;
    byteRangeMaxFileSizeMB: number | null;
    segmentDuration: number | null;
}

export interface HealthResponse {
    status: string;
    apiVersion: string;
}

export interface CreateSessionResponse {
    sessionId: string;
    readToken: string;
    eventsUrl: string;
    apiVersion: string;
    reused: boolean;
}

/** Shape of the JSON payload pushed over the session SSE stream. */
export interface SessionEvent {
    sessionId?: string;
    status?: string;
    progress?: number;
    hlsUrl?: string;
    encryptionKeyHex?: string;
    queuePosition?: number;
    error?: string;
    probeResult?: unknown;
    [key: string]: unknown;
}

/** What the real CMS persists once the first `encoding` event lands. */
export interface MediaDto {
    hlsUrl: string;
    hlsKey: string | null;
}

export interface LoggedEvent {
    id: number;
    at: string;
    data: SessionEvent;
    raw: string;
    /** True for the first event that carried an `hlsUrl` — the save moment. */
    isSavePoint: boolean;
}
