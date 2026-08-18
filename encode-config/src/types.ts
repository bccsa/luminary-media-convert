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
    /**
     * Frames the decoder must hold to reorder this stream (ffprobe's
     * `has_b_frames`) — a reorder depth, not a flag.
     */
    hasBFrames?: number;
    /** Chroma format and bit depth, e.g. `yuv420p`. */
    pixFmt?: string;
    /**
     * Codec level in the codec's own numbering (H.264 4.0 is 40). Negative or
     * absent when the container does not say.
     */
    level?: number;
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

/**
 * How a trim would be cut, derived from the copy checkboxes rather than chosen.
 *
 * `quick` — every stream copied: whole GOPs are remuxed and only the partial
 * GOP at each cut point is re-encoded. `precise` — nothing copied: every stream
 * is re-encoded and cut at the exact frame. `mixed` — some of each, which the
 * API refuses, because every playlist of one output has to splice at the same
 * instants and a copied stream splices on its own keyframe grid.
 */
export type TrimCopyMode = 'mixed' | 'precise' | 'quick';

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
