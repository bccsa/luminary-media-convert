import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import type { ProbeResult } from './probe.service.js';

/**
 * How far apart two streams may start before the encode has to pull them
 * together, in seconds.
 *
 * Under a frame at any frame rate anyone ships, so a source inside this is
 * aligned as far as a player is concerned. The old gate was 50 ms, chosen when
 * the answer to a misaligned source was to escape into MPEG-TS and let the
 * player's transmuxer sort it out; now that the answer is an input seek, which
 * costs a fraction of a second off the head and nothing else, there is no
 * reason to be that generous.
 */
export const ALIGNMENT_TOLERANCE_SECONDS = 0.02;

/**
 * Why the submitted config's copy-mode renditions cannot be copied, or null
 * when every one of them can.
 *
 * Copying a video stream is the cheapest thing this encoder does and the most
 * conditional: it hands the source's own bytes to the HLS muxer, which means
 * the source, not the config, decides where segments may be cut and where the
 * stream may be seeked to. Two conditions follow from that, and both are
 * enforced here rather than left to produce output nobody watches to the end:
 *
 *  1. **The stream must not need trimming.** When the source's streams start at
 *     different times the encode seeks past the head to align them, and a seek
 *     over a copied stream lands on the nearest keyframe rather than the frame
 *     asked for. Everything re-encoded starts where it was told to; the copied
 *     stream starts wherever its last keyframe was, and stays that far out of
 *     sync for the whole programme. The latest-starting stream is the one being
 *     aligned *to* and is seeked exactly, so it is allowed.
 *  2. **The keyframes must fit the segments.** FFmpeg cuts a copied stream at
 *     source keyframes, so a segment can only be as long as a whole number of
 *     the source's GOPs. A 2 s GOP divides 6 s segments; a 2.5 s one does not,
 *     and the output gets segments of 5 s and 7.5 s that no `#EXT-X-TARGETDURATION`
 *     describes honestly. Compared in frames, because a 29.97 fps source has no
 *     exact seconds to compare.
 *
 * Strict about what it does not know. A source whose keyframe cadence could not
 * be sampled, or which has no cadence to speak of, is refused rather than
 * copied hopefully — the failure mode is a finished encode with drifting
 * segments, discovered by a viewer.
 *
 * The message names the track and says what to do instead, because the person
 * reading it is looking at a form with a Copy tick box on that row.
 */
export function copyModeRejection(
    probeResult: ProbeResult | undefined,
    encodeConfig: EncodeConfigDto
): string | null {
    if (encodeConfig.type !== 'video') return null;

    const renditions = encodeConfig.videoRenditions ?? [];
    const copyRenditions = renditions.filter((r) => r.copyStream);
    if (copyRenditions.length === 0) return null;

    const videoTracks = probeResult?.videoTracks ?? [];
    const audioTracks = probeResult?.audioTracks ?? [];
    const segmentDuration = encodeConfig.segmentDuration ?? 6;

    // Only the streams this encode actually uses. A source may carry a track
    // starting a second late that nothing in the config maps, and refusing a
    // copy over it would be refusing over something the encode never opens.
    const usedStartTimes: number[] = [];
    for (const r of renditions) {
        const track = videoTracks[r.sourceTrackIndex ?? 0];
        if (track?.startTime != null) usedStartTimes.push(track.startTime);
    }
    for (const g of encodeConfig.audioGroups ?? []) {
        const track = audioTracks[g.sourceTrackIndex];
        if (track?.startTime != null) usedStartTimes.push(track.startTime);
    }

    const latestStart = latestStartRequiringAlignment(usedStartTimes);

    for (const r of copyRenditions) {
        const index = r.sourceTrackIndex ?? 0;
        const track = videoTracks[index];
        const reason = copyModeTrackRejection(
            index,
            track,
            latestStart,
            segmentDuration
        );
        if (reason) return reason;
    }

    return null;
}

/**
 * The start time every stream will be seeked to, or 0 when they already agree
 * closely enough to be left alone.
 *
 * Shared with the form so both sides answer "is this source being aligned"
 * identically; the encoder itself asks ffprobe again at encode time rather than
 * trusting a probe result that may be hours old.
 */
export function latestStartRequiringAlignment(startTimes: number[]): number {
    if (startTimes.length < 2) return 0;
    const max = Math.max(...startTimes);
    const min = Math.min(...startTimes);
    return max - min < ALIGNMENT_TOLERANCE_SECONDS ? 0 : max;
}

/** One track's verdict — see {@link copyModeRejection} for why each rule exists. */
function copyModeTrackRejection(
    index: number,
    track: ProbeResult['videoTracks'][number] | undefined,
    latestStart: number,
    segmentDuration: number
): string | null {
    if (latestStart > 0 && track?.startTime != null) {
        const behind = latestStart - track.startTime;
        if (behind >= ALIGNMENT_TOLERANCE_SECONDS) {
            return (
                `Video track ${index} starts ${Math.round(behind * 1000)} ms before ` +
                `the latest stream; copy mode would leave it out of sync — ` +
                `re-encode this rendition instead.`
            );
        }
    }

    const fps = track?.frameRate ?? 0;
    const gopFrames = track?.gopFrames ?? 0;
    if (track?.gopRegular !== true || gopFrames <= 0 || fps <= 0) {
        return (
            `Video track ${index}'s keyframe structure could not be determined — ` +
            `re-encode this rendition instead.`
        );
    }

    // In frames, not seconds: 6 s of 29.97 fps is 179.82 frames, and no
    // arithmetic on that number divides cleanly by anything. A frame either
    // side of the boundary is the rounding, not a mismatch.
    const segmentFrames = Math.round(segmentDuration * fps);
    const remainder = segmentFrames % gopFrames;
    if (remainder > 1 && remainder < gopFrames - 1) {
        const gopSeconds = track.gopSeconds ?? gopFrames / fps;
        return (
            `Video track ${index}'s keyframe interval (${gopSeconds}s) does not fit ` +
            `${segmentDuration}s segments — re-encode this rendition instead.`
        );
    }

    return null;
}
