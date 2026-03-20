export interface SessionDocument {
    _id: string; // "session:<sessionId>"
    _rev?: string;
    docType: 'session';
    userId: string;
    sessionId: string;
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
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}
