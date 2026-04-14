// Re-export probe and encode config types from shared package
export type {
    FormatInfo,
    VideoTrackInfo,
    AudioTrackInfo,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
} from '@luminary-media-converter/encode-config';

// Import + re-export ProbeResult (also used by SessionStatusResponse below)
import type { ProbeResult } from '@luminary-media-converter/encode-config';
export type { ProbeResult } from '@luminary-media-converter/encode-config';

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
    probeResult?: ProbeResult;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: { name: string; key: string }[];
    thumbnailsVtt?: string;
    encryptionKeyHex?: string;
    error?: string;
    encoder?: AccelMode;
    segmentFormat?: SegmentFormat;
}
