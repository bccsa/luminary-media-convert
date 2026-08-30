import { displayDimensionsOf, isAnamorphic } from './aspect';
import type { ProbeResult, VideoTrackInfo } from './types';

/**
 * Whether a video track may be copied rather than re-encoded.
 *
 * A courtesy, not the rule. The rules are `copyModeRejection` and, once a trim
 * is in play, `quickTrimGateRejection` in
 * `api/src/encode/services/copy-mode-eligibility.ts`, which refuse the encode
 * outright and are the source of truth; this exists so the form can grey the
 * Copy tick box out with the same sentence rather than letting someone choose
 * something the API will then reject. The two are deliberately separate copies
 * — the API cannot import a Vue library — and deliberately tiny, so keeping
 * them in step is a matter of reading twenty lines.
 */

/** See the API's constant of the same name. */
export const ALIGNMENT_TOLERANCE_SECONDS = 0.02;

/**
 * Source codecs that may be decoded but never copied to the output.
 *
 * Mirrors `FORBIDDEN_COPY_CODECS` in the API's copy-mode-eligibility.ts —
 * the API is the one that enforces it; this is so the form says no before a
 * job is submitted rather than after.
 */
export const FORBIDDEN_COPY_CODECS = new Set(['hevc', 'h265', 'h.265', 'x265']);

/**
 * The start time every stream will be seeked to, or 0 when they already agree
 * closely enough to be left alone.
 *
 * Takes every probed stream rather than only the ones the current config maps.
 * The form's answer only has to be right about the source in front of the user,
 * and it changes as they edit; the API narrows it to the streams actually used
 * before refusing anything.
 */
export function latestStreamStart(probeResult: ProbeResult): number {
    const startTimes = [
        ...probeResult.videoTracks.map((t) => t.startTime),
        ...probeResult.audioTracks.map((t) => t.startTime),
    ].filter((t): t is number => t != null);

    if (startTimes.length < 2) return 0;
    const max = Math.max(...startTimes);
    const min = Math.min(...startTimes);
    return max - min < ALIGNMENT_TOLERANCE_SECONDS ? 0 : max;
}

/**
 * Why this track cannot be copied, or null when it can.
 *
 * Three reasons, all the source's doing: a copied stream is seeked at its own
 * keyframes, so aligning it to a later-starting stream leaves it permanently
 * out of sync; it is cut at its own keyframes, so a segment can only be a
 * whole number of the source's GOPs long; and its sample aspect ratio is in its
 * bitstream, so copying cannot make a square-pixel rendition out of an
 * anamorphic source. An unknown cadence counts against the track — a wrong
 * guess here is discovered by a viewer, not by us.
 */
export function copyModeBlockedReason(
    track: VideoTrackInfo,
    latestStart: number,
    segmentDuration: number
): string | null {
    const bytes =
        forbiddenCodecBlockedReason(track) ?? anamorphicBlockedReason(track);
    if (bytes) return bytes;

    if (latestStart > 0 && track.startTime != null) {
        const behind = latestStart - track.startTime;
        if (behind >= ALIGNMENT_TOLERANCE_SECONDS) {
            return (
                `This track starts ${Math.round(behind * 1000)} ms before the latest ` +
                `stream; copy mode would leave it out of sync — re-encode this ` +
                `rendition instead.`
            );
        }
    }

    return cadenceBlockedReason(track, segmentDuration);
}

/**
 * Why this track cannot be copied *for a quick cut*, or null when it can.
 *
 * Mirrors `quickTrimGateRejection` on the API side: the same cadence
 * guarantees, none of the alignment rule. A quick cut splices each stream on
 * its own keyframe grid at exact presentation times, so nothing is ever seeked
 * to a shared offset and mutually offset start times stay in sync by
 * construction — which is precisely the source `copyModeBlockedReason` has to
 * refuse and this one may allow.
 */
export function quickTrimBlockedReason(
    track: VideoTrackInfo,
    segmentDuration: number
): string | null {
    return (
        forbiddenCodecBlockedReason(track) ??
        anamorphicBlockedReason(track) ??
        cadenceBlockedReason(track, segmentDuration)
    );
}

/**
 * Why this track cannot be copied *whatever* is being asked of it.
 *
 * Its pixels are not square, and a copied stream's sample aspect ratio lives in
 * its bitstream, where nothing downstream of the decoder can reach it — the
 * muxer never sees a frame. HLS output here is always square-pixel, so an
 * anamorphic track has to be re-encoded to become one, and a quick cut is no
 * exception: it splices the same bitstream and inherits the same ratio.
 *
 * Kept out of {@link cadenceBlockedReason} deliberately — that one is the
 * keyframe half of the verdict, and it would stop being true. Mirrors the
 * shape rule in the API's `copyModeTrackRejection`, which checks it in the same
 * position — after the codec, before alignment and cadence.
 */
function anamorphicBlockedReason(track: VideoTrackInfo): string | null {
    if (!isAnamorphic(track)) return null;
    const display = displayDimensionsOf(track);
    return (
        `This track stores non-square pixels (${track.width}x${track.height} shown ` +
        `${display.width}x${display.height}); copy mode hands the source's own bytes ` +
        `to the muxer, which cannot square them — re-encode this rendition instead.`
    );
}

/**
 * Why this track cannot be copied whatever is being asked of it, part one: a
 * copy hands the source's own bytes through, so the output carries the source's
 * codec. This encoder writes H.264 only, and a copied H.265 stream would be the
 * one way past that. Decoding HEVC in order to transcode it is unaffected.
 *
 * A sibling of {@link anamorphicBlockedReason} rather than part of
 * {@link cadenceBlockedReason}, for the same reason: the cadence rule is the
 * keyframe half of the verdict and would stop being that if it also answered
 * questions about codecs. Mirrors the first rule in the API's
 * `copyModeTrackRejection`, in the same order.
 */
function forbiddenCodecBlockedReason(track: VideoTrackInfo): string | null {
    const codec = track.codec?.toLowerCase();
    if (!codec || !FORBIDDEN_COPY_CODECS.has(codec)) return null;
    return (
        `This track is ${codec.toUpperCase()}, which cannot be copied — ` +
        `re-encode this rendition instead.`
    );
}

/**
 * The keyframe half of the verdict, shared by both rules because both cut a
 * copied stream at source keyframes whatever else they do with the head.
 */
function cadenceBlockedReason(
    track: VideoTrackInfo,
    segmentDuration: number
): string | null {
    const fps = track.frameRate ?? 0;
    const gopFrames = track.gopFrames ?? 0;
    if (track.gopRegular !== true || gopFrames <= 0 || fps <= 0) {
        return (
            `This track's keyframe structure could not be determined — ` +
            `re-encode this rendition instead.`
        );
    }

    // In frames: 6 s of 29.97 fps is 179.82, and no arithmetic on that divides
    // cleanly by anything. A frame either side of the boundary is the rounding.
    const segmentFrames = Math.round(segmentDuration * fps);
    const remainder = segmentFrames % gopFrames;
    if (remainder > 1 && remainder < gopFrames - 1) {
        const gopSeconds = track.gopSeconds ?? gopFrames / fps;
        return (
            `This track's keyframe interval (${gopSeconds}s) does not fit ` +
            `${segmentDuration}s segments — re-encode this rendition instead.`
        );
    }

    return null;
}
