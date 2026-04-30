export interface SessionDocument {
    _id: string; // "session:<sessionId>"
    _rev?: string;
    docType: 'session';
    userId: string;
    sessionId: string;
    name?: string;
    status: string;
    progress?: number;
    queuePosition?: number;
    probeResult?: unknown;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: Array<{ name: string; key: string }>;
    thumbnailsVtt?: string;
    error?: string;
    encoder?: string;
    segmentFormat?: string;
    s3Config?: {
        endPoint: string;
        bucket: string;
        pathPrefix?: string;
        port?: number;
        useSSL?: boolean;
        publicUrl?: string;
    };
    encrypted?: boolean;
    encryptionKeyHex?: string;
    imported?: boolean;
    s3ConfigId?: string;

    /**
     * Subtitle sidecar tracks attached to the master playlist.
     * Reconciled from MutateResponse.master after each edit; the master.m3u8
     * on S3 remains the source of truth.
     */
    subtitles?: Array<{
        language: string;
        name: string;
        key: string;
        default?: boolean;
        forced?: boolean;
        updatedAt: string;
    }>;

    /** Chapter-marker VTT attached to the master playlist. */
    chapters?: {
        key: string;
        updatedAt: string;
    };

    /** Monotonic counter incremented on every successful HLS edit. */
    editVersion?: number;

    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}
