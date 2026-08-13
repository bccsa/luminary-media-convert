import type { ProbeResult, VideoTrackInfo } from './types';

/**
 * Whether a video track may be copied rather than re-encoded.
 *
 * A courtesy, not the rule. The rule is `copyModeRejection` in
 * `api/src/encode/services/copy-mode-eligibility.ts`, which refuses the encode
 * outright and is the source of truth; this exists so the form can grey the
 * Copy tick box out with the same sentence rather than letting someone choose
 * something the API will then reject. The two are deliberately separate copies
 * — the API cannot import a Vue library — and deliberately tiny, so keeping
 * them in step is a matter of reading twenty lines.
 */

/** See the API's constant of the same name. */
export const ALIGNMENT_TOLERANCE_SECONDS = 0.02;

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
 * Two reasons, both the source's doing: a copied stream is seeked at its own
 * keyframes, so aligning it to a later-starting stream leaves it permanently
 * out of sync; and it is cut at its own keyframes, so a segment can only be a
 * whole number of the source's GOPs long. An unknown cadence counts against the
 * track — a wrong guess here is discovered by a viewer, not by us.
 */
export function copyModeBlockedReason(
    track: VideoTrackInfo,
    latestStart: number,
    segmentDuration: number
): string | null {
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
