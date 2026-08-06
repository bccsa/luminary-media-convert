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

// --- Session Request/Response Types ---

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

/**
 * One row of `GET /api/sessions`. Carries the session token, which the status
 * response never does — the list is the only place the UI can pick one up.
 */
export interface SessionSummary {
    sessionId: string;
    title?: string;
    status: SessionStatus;
    progress: number;
    /** Epoch milliseconds. */
    createdAt: number;
    sessionToken: string;
    hlsUrl?: string;
    error?: string;
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
    thumbnailsVtt?: string;
    encryptionKeyHex?: string;
    /** Public URL of the master playlist, known from the moment encoding starts. */
    hlsUrl?: string;
    /** Title supplied by the CMS that opened the session. */
    title?: string;
    /** The CMS document this session's output belongs to. */
    documentId?: string;
    error?: string;
    encoder?: AccelMode;
    segmentFormat?: SegmentFormat;
    ingestTotalBytes?: number;
    /** Trim ranges submitted with the encode config, in source-timeline seconds. */
    trimSegments?: TrimSegment[];
}
