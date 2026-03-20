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
    };
    encrypted?: boolean;
    encryptionKeyHex?: string;
    imported?: boolean;
    s3ConfigId?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}
