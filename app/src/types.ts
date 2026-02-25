// --- Probe Result Types ---

export interface VideoTrackInfo {
    index: number;
    codec: string;
    width: number;
    height: number;
    bitrateKbps: number;
    frameRate: number;
    profile?: string;
    language?: string;
    name?: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
    language?: string;
    name?: string;
}

export interface FormatInfo {
    duration: number;
    bitrateKbps: number;
    formatName: string;
}

export interface ProbeResult {
    format: FormatInfo;
    videoTracks: VideoTrackInfo[];
    audioTracks: AudioTrackInfo[];
}

// --- Encode Config Types ---

export interface VideoRendition {
    width: number;
    height: number;
    videoBitrateKbps: number;
    copyStream: boolean;
    sourceTrackIndex?: number;
    audioGroupId: string;
    label?: string;
    vbr?: boolean;
}

export interface AudioGroup {
    id: string;
    label?: string;
    audioBitrateKbps: number;
    channels: number;
    audioCodec: 'aac';
    sourceTrackIndex: number;
    language?: string;
    copyStream?: boolean;
    vbr?: boolean;
}

export interface EncodeConfig {
    type: 'video' | 'audio';
    segmentDuration?: number;
    videoRenditions?: VideoRendition[];
    audioGroups?: AudioGroup[];
    videoTrackNames?: { index: number; name: string }[];
    /** Audio track metadata (name, language) for restored configs — persisted in localStorage only */
    audioTrackMetadata?: { index: number; name?: string; language?: string }[];
}

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
}

export interface WebhookConfig {
    url: string;
    sessionToken: string;
}

// --- Session Request/Response Types ---

export interface CreateSessionRequest {
    segmentDuration?: number;
    s3: S3Config;
    webhook?: WebhookConfig;
}

export interface SessionResponse {
    sessionId: string;
    tusEndpoint: string;
    uploadToken: string;
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
    | 'uploading_to_s3'
    | 'completed'
    | 'failed';

export interface SessionStatusResponse {
    sessionId: string;
    status: SessionStatus;
    progress?: number;
    queuePosition?: number;
    probeResult?: ProbeResult;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: { name: string; key: string }[];
    error?: string;
}
