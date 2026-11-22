// --- Probe Result Types ---

export interface VideoTrackInfo {
    index: number;
    codec: string;
    width: number;
    height: number;
    /**
     * The dimensions this picture is meant to be shown at, in square pixels.
     *
     * A 720x576 PAL broadcast carrying 16:9 stores non-square samples and its
     * coded size says nothing about its shape; it is shown 1024x576. Equal to
     * {@link width} / {@link height} for the overwhelmingly common square-pixel
     * source, which is what makes the inequality the whole of the question "is
     * this track anamorphic" — see `isAnamorphic` in `aspect.ts`.
     *
     * Absent on a probe from before the API reported it. Read it through
     * `displayDimensionsOf` rather than directly, so the fallback to the coded
     * size happens in one place.
     */
    displayWidth?: number;
    /** See {@link displayWidth}. */
    displayHeight?: number;
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
    /**
     * Clockwise quarter turns the picture is shown at, in degrees (90, 180 or
     * 270), from the stream's display matrix. A phone stores a portrait video
     * landscape and says to turn it. Absent when the picture is shown as
     * stored. The display size already counts the turn.
     */
    rotation?: number;
    /**
     * The camera angle this track is one quality of, when the source carries
     * the same picture more than once: the lowest track index in that angle.
     * An identifier, not a ranking. Absent on a track that is its own angle,
     * and on every track when {@link ProbeResult.anglesDetected} is not set.
     */
    pictureGroup?: number;
    /**
     * The fewest sampled moments at which this track was seen to show the same
     * picture as another member of its `pictureGroup`. Absent without a group.
     */
    pictureMatches?: number;
    /**
     * The comparison behind `pictureGroup` ran to the end. False when the time
     * allowed cut it short: the tracks agreed everywhere they were compared,
     * but at fewer moments than a grouping is normally trusted on. Absent
     * without a group, and on sessions probed before it was recorded.
     */
    pictureVerified?: boolean;
    /**
     * Tracks this one may show the same picture as, but was kept apart from:
     * they agreed at enough moments, and a disagreement was still waiting to be
     * re-checked when the time allowed ran out. Absent when there are none.
     */
    pictureUndecided?: number[];
    /**
     * The keyframe grid this track is cut on: the lowest index among the video
     * tracks that cut keyframes at the same instants, sampled through the whole
     * file, and run as long as it does. Tracks with the same id can be copied as
     * rungs of one ladder; a track alone on its grid carries its own index.
     * Absent when the tracks' keyframes were not compared.
     */
    keyframeGrid?: number;
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
    /**
     * The video tracks were compared for which show the same picture. Without
     * it, a track with no `pictureGroup` was never compared — a session from
     * before detection, or one where it failed — rather than found to be an
     * angle of its own, and the form keeps treating every track as an angle.
     */
    anglesDetected?: boolean;
}

// --- Encode Config Types ---

export interface VideoRendition {
    width: number;
    height: number;
    videoBitrateKbps: number;
    copyStream: boolean;
    sourceTrackIndex?: number;
    /**
     * The camera angle this rendition belongs to, by angle id — the id its
     * `videoTrackNames` entry is filed under. Several source tracks can be one
     * angle (a copied ladder), so it is not always the source track. Defaults
     * to `sourceTrackIndex` on the API.
     */
    angle?: number;
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

/**
 * The hearing-impaired kinds of view a camera angle can be. The keys of
 * `ANGLE_ACCESSIBILITY` in `@luminary-media-converter/hls-core`, which is the
 * one source of what each is written as in the master; spelled out here only
 * because this package does not depend on hls-core. The API checks a submitted
 * value against that map.
 */
export type AngleAccessibility = 'captions' | 'sign-language' | 'lip-reading';

/**
 * A video track's name. The entry filed under an angle's id names the angle,
 * and can say which audio it belongs with and what kind of view it is, for a
 * player that switches the picture with the audio language.
 */
export interface VideoTrackName {
    index: number;
    name: string;
    /**
     * The audio language the angle's picture belongs to (burnt-in titles, lip
     * sync), as an audio track's language is written. Absent for none — never
     * taken from the probe, whose video tracks carry whatever the muxer
     * stamped (`und`, `eng`) on every one of them.
     */
    language?: string;
    /** The hearing-impaired kind of view the angle is. Absent for none. */
    accessibility?: AngleAccessibility;
}

export interface EncodeConfig {
    type: 'video' | 'audio';
    segmentDuration?: number;
    videoRenditions?: VideoRendition[];
    audioGroups?: AudioGroup[];
    videoTrackNames?: VideoTrackName[];
    /**
     * The angle each kept track of a multi-track source belongs to, by angle
     * id. The encode does not use it: rows name their own angle. It is what a
     * restore needs for a track no row is made from — one more quality of a
     * re-encoded angle — which would otherwise go back to detection's angle.
     */
    videoTrackAngles?: { index: number; angle: number }[];
    /** Audio track metadata (name, language) for restored configs — persisted in localStorage only */
    audioTrackMetadata?: { index: number; name?: string; language?: string }[];
    /** Trim segments — when set, only these time ranges are encoded and concatenated */
    trimSegments?: TrimSegment[];
}
