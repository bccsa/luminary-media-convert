export interface Credentials {
    username: string;
    password: string;
}

export interface Rendition {
    width?: number;
    height?: number;
    videoBitrateKbps?: number;
    audioBitrateKbps: number;
    audioCodec?: 'aac' | 'mp3';
}

export interface S3Config {
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    bucket: string;
    region?: string;
    accessKey: string;
    secretKey: string;
    pathPrefix?: string;
}

export interface WebhookConfig {
    url: string;
    sessionToken: string;
}

export interface CreateSessionRequest {
    type: 'video' | 'audio';
    renditions: Rendition[];
    segmentDuration?: number;
    s3: S3Config;
    webhook?: WebhookConfig;
}

export interface SessionResponse {
    sessionId: string;
    uploadUrl: string;
    uploadToken: string;
}

export interface UploadResponse {
    sessionId: string;
    status: string;
    queuePosition?: number;
}

export type SessionStatus =
    | 'created'
    | 'uploading'
    | 'queued'
    | 'encoding'
    | 'uploading_to_s3'
    | 'completed'
    | 'failed';

export interface SessionStatusResponse {
    sessionId: string;
    status: SessionStatus;
    progress?: number;
    queuePosition?: number;
    files?: string[];
    masterPlaylist?: string;
    error?: string;
}
