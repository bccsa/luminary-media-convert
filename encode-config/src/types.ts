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
    /**
     * Where this stream's first frame sits on the container timeline, seconds.
     * Streams in one file routinely do not start together, and the encoder
     * seeks past the head to make them — which is what decides whether copy
     * mode is safe for this track. Absent on a probe from before the API
     * reported it.
     */
    startTime?: number;
    /** Frames between consecutive keyframes, sampled from the head. */
    gopFrames?: number;
    /** {@link gopFrames} in seconds, for saying out loud. */
    gopSeconds?: number;
    /**
     * Every sampled keyframe interval was the same length. False means the
     * source cuts keyframes where it likes, which no segment duration divides
     * into.
     */
    gopRegular?: boolean;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
    language?: string;
    name?: string;
    /** See {@link VideoTrackInfo.startTime}. */
    startTime?: number;
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

export interface TrimSegment {
    /** In-point in seconds */
    inSec: number;
    /** Out-point in seconds */
    outSec: number;
}

export interface EncodeConfig {
    type: 'video' | 'audio';
    segmentDuration?: number;
    videoRenditions?: VideoRendition[];
    audioGroups?: AudioGroup[];
    videoTrackNames?: { index: number; name: string }[];
    /** Audio track metadata (name, language) for restored configs — persisted in localStorage only */
    audioTrackMetadata?: { index: number; name?: string; language?: string }[];
    /** Trim segments — when set, only these time ranges are encoded and concatenated */
    trimSegments?: TrimSegment[];
}
