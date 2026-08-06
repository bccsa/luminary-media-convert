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
 * overlaps, empty when the frame it shows was cut entirely.
 *
 * A cue is clipped to each range rather than tested for membership. Cut points
 * rarely land on a sampling boundary, so the cue straddling the in-point holds
 * the only frame there is for the first seconds of the programme: dropping it
 * for starting too early left the head of the filmstrip blank — which read as
 * the *kept* material having been deleted. Clipping keeps the frame and lets it
 * describe just the part that survived; a cue spanning a cut can legitimately
 * appear twice, since the material either side of the cut is now adjacent and
 * both halves are still that frame.
 */
function mapCue(
    startTime: number,
    endTime: number,
    ranges: readonly TrimSegment[],
): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];

    for (const r of [...ranges].sort((a, b) => a.inSec - b.inSec)) {
        const from = Math.max(startTime, r.inSec);
        const to = Math.min(endTime, r.outSec);
        if (to <= from) continue;

        const start = sourceToOutput(from, ranges);
        if (start === null) continue;

        out.push({ start, end: start + (to - from) });
    }

    return out;
}
