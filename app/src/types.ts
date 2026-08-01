// Re-export probe and encode config types from shared package
export type {
    FormatInfo,
    VideoTrackInfo,
    AudioTrackInfo,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
} from '@luminary-media-converter/encode-config';

// Import + re-export ProbeResult and TrimSegment (both used by SessionStatusResponse below)
import type {
    ProbeResult,
    TrimSegment,
} from '@luminary-media-converter/encode-config';
export type {
    ProbeResult,
    TrimSegment,
} from '@luminary-media-converter/encode-config';

// --- S3 & Webhook Config ---

export interface S3Config {
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    bucket: string;
    region?: string;
    accessKey: string;
    secretKey: string;
    pathPrefix?: string;
    publicUrl?: string;
}

export interface WebhookConfig {
    url: string;
    sessionToken: string;
}

export interface EncryptionConfig {
    enabled?: boolean;
    keyUrl?: string;
}

// --- Session Request/Response Types ---

export interface CreateSessionRequest {
    segmentDuration?: number;
    byteRange?: boolean;
    byteRangeMaxFileSizeMB?: number;
    thumbnails?: boolean;
    s3: S3Config;
    webhook?: WebhookConfig;
    encryption?: EncryptionConfig;
    s3ConfigId?: string;
}

export interface SaasSessionResponse {
    sessionId: string;
    encodingApiUrl: string;
    sessionToken: string;
    maxUploadSize: number;
}

export interface EncodeStartResponse {
    sessionId: string;
    status: string;
    queuePosition?: number;
}

export type SessionStatus =
    | 'created'
    | 'uploaded'
    | 'uploading'
    | 'queued'
    | 'encoding'
    | 'encrypting'
    | 'uploading_to_s3'
    | 'completed'
    | 'failed';

export type AccelMode = 'cpu' | 'nvidia' | 'apple';
export type SegmentFormat = 'fmp4' | 'mpegts';

export interface PipelineProgress {
    encoding: number;
    encrypting?: number;
    uploading?: number;
}

export interface SessionStatusResponse {
    sessionId: string;
    status: SessionStatus;
    progress?: number;
    pipelineProgress?: PipelineProgress;
    queuePosition?: number;
    canRetry?: boolean;
    probeResult?: ProbeResult;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: { name: string; key: string }[];
    thumbnailsVtt?: string;
    encryptionKeyHex?: string;
    error?: string;
    encoder?: AccelMode;
    segmentFormat?: SegmentFormat;
    ingestTotalBytes?: number;
    /** Trim ranges submitted with the encode config, in source-timeline seconds. */
    trimSegments?: TrimSegment[];
}

// --- SaaS API response shapes ---

export interface ApiKeyResponse {
    id: string;
    name: string;
    prefix: string;
    status: 'active' | 'revoked';
    lastUsedAt: string | null;
    createdAt: string;
}

export interface S3ConfigSummary {
    id: string;
    name: string;
    endPoint: string;
    port?: number;
    useSSL: boolean;
    bucket: string;
    region?: string;
    publicUrl?: string;
    createdAt: string;
}

export interface S3ConfigDetail extends S3ConfigSummary {
    accessKey: string;
    secretKey: string;
}

export interface ImportSessionResponse {
    id?: string;
    sessionId?: string;
    chaptersLanguages?: string[];
}

/**
 * Partial view of a stored session document. Only the fields read directly off
 * the API result are typed; the full CouchDB doc carries more (consumed loosely
 * through reactive `any` state in the views).
 */
export interface SessionDetailResponse {
    sessionId?: string;
    status: string;
    name?: string;
    encodingType?: 'video' | 'audio';
    byteRange?: boolean;
    encryptionKeyHex?: string;
    sessionToken?: string;
    encodingApiUrl?: string;
    [key: string]: unknown;
}

export interface SessionListResponse {
    sessions: SessionDetailResponse[];
    total: number;
}
