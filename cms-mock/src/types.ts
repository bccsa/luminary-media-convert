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
    audioByteRangeMaxFileSizeMB: number | null;
    /** Empty (null) leaves it out, which the encoder reads as arrival order. */
    byteRangeBlockSeconds: number | null;
    segmentDuration: number | null;
    /** 'encode' a new file for the post, or 'edit' the video it already has. */
    mode: 'encode' | 'edit';
    /** Sent as `existingMedia` in edit mode; `hlsKey` is dropped when empty. */
    existingMedia: { hlsUrl: string; hlsKey: string };
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
    /**
     * Edit mode only: the master revision the session actually opened. Newer
     * than `existingMedia.hlsUrl` when the folder holds a later revision
     * ("newest wins"), so it is stored at once.
     */
    hlsUrl?: string;
}

/** Shape of the JSON payload pushed over the session SSE stream. */
export interface SessionEvent {
    sessionId?: string;
    status?: string;
    progress?: number;
    /** Changes on every edit: each one is a new `master_rN.m3u8`. */
    hlsUrl?: string;
    masterPlaylist?: string;
    /** True while the encoder waits for this CMS to acknowledge `hlsUrl`. */
    cmsPending?: boolean;
    queuePosition?: number;
    error?: string;
    probeResult?: unknown;
    [key: string]: unknown;
}

/** What the real CMS persists on the document for its video. */
export interface MediaDto {
    hlsUrl: string;
    hlsKey: string | null;
}

/**
 * The session a document's page is following, kept across reloads the way
 * the real CMS remembers it, so a finished session is still followed.
 */
export interface FollowedSession {
    sessionId: string;
    readToken: string;
    eventsUrl: string;
    documentId: string;
}

/**
 * How an announced `hlsUrl` reached the document. The real CMS auto-saves a
 * revision in the same folder and leaves a new folder to the editor's Save.
 */
export type StoreKind = 'same-folder' | 'new-folder';

export interface LoggedEvent {
    id: number;
    at: string;
    data: SessionEvent;
    raw: string;
    /** Set on an event whose `hlsUrl` differed from the stored one and was stored. */
    stored: StoreKind | null;
}
