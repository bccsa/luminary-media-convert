import {
    formatVttTimestamp,
    parseThumbnailVtt,
} from '@luminary-media-converter/segment-editor';
import type { TrimSegment } from '../types';
import { sourceToOutput } from './trimTimeline';

/**
 * Re-time a source storyboard onto the trimmed timeline.
 *
 * The encoder samples its storyboard from the uploaded source, so every cue is
 * stamped in source time. Once ranges are trimmed the timeline shows the
 * programme instead — the retained ranges laid end to end — and the two stop
 * agreeing. Frames then sit under the wrong part of the ruler, and material the
 * user cut out still appears on the strip, which reads as though the trim were
 * being ignored by the encode.
 *
 * Sprite references are resolved to absolute URLs on the way through, because
 * the result is served to the editor as a blob and relative paths have nothing
 * left to resolve against.
 */
/**
 * The same storyboard, with its sprite references resolved against where the
 * VTT actually came from.
 *
 * Needed whenever the file is handed to the editor as a blob rather than at its
 * own address — after decryption, say — since a blob URL gives a relative
 * sprite path nothing to resolve against. Cue times are left exactly as they
 * are; this is not {@link retimeStoryboardVtt}.
 */
export function absolutizeStoryboardVtt(text: string, vttUrl: string): string {
    const baseUrl = vttUrl.substring(0, vttUrl.lastIndexOf('/'));
    const lines: string[] = ['WEBVTT', ''];
    for (const cue of parseThumbnailVtt(text, baseUrl)) {
        lines.push(
            `${formatVttTimestamp(cue.startTime)} --> ${formatVttTimestamp(cue.endTime)}`,
            `${cue.spriteUrl}#xywh=${cue.x},${cue.y},${cue.w},${cue.h}`,
            '',
        );
    }
    return lines.join('\n');
}

export function retimeStoryboardVtt(
    text: string,
    vttUrl: string,
    ranges: readonly TrimSegment[],
): string {
    const baseUrl = vttUrl.substring(0, vttUrl.lastIndexOf('/'));
    const cues = parseThumbnailVtt(text, baseUrl);

    const lines: string[] = ['WEBVTT', ''];
    for (const cue of cues) {
        for (const mapped of mapCue(cue.startTime, cue.endTime, ranges)) {
            lines.push(
                `${formatVttTimestamp(mapped.start)} --> ${formatVttTimestamp(mapped.end)}`,
                `${cue.spriteUrl}#xywh=${cue.x},${cue.y},${cue.w},${cue.h}`,
                '',
            );
        }
    }

    return lines.join('\n');
}

/**
 * Where a cue belongs on the output timeline — one entry per retained range it
 * overlaps, and none at all when the frame it shows was cut entirely.
 *
 * Overlap is the test, not where the cue starts. Cues are sampled from the
 * source at a fixed interval, so a trim almost never begins exactly on one: the
 * cue covering the first seconds of a retained range usually starts before that
 * range does. Keying on the start dropped that cue, which left the opening of
 * every such range with no thumbnail at all — and the coarser the sampling, or
 * the more ranges a trim creates, the more of the strip went blank.
 *
 * Each entry is clipped to the range it falls in, so a cue is never drawn
 * spilling across a cut into material it does not describe.
 */
function mapCue(
    startTime: number,
    endTime: number,
    ranges: readonly TrimSegment[],
): { start: number; end: number }[] {
    const mapped: { start: number; end: number }[] = [];

    for (const range of ranges) {
        const from = Math.max(startTime, range.inSec);
        const to = Math.min(endTime, range.outSec);
        if (to <= from) continue;

        // `from` sits inside this range by construction, so it always maps.
        const start = sourceToOutput(from, ranges);
        if (start === null) continue;

        mapped.push({ start, end: start + (to - from) });
    }

    return mapped.sort((a, b) => a.start - b.start);
}
