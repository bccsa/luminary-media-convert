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
        const mapped = mapCue(cue.startTime, cue.endTime, ranges);
        if (!mapped) continue;
        lines.push(
            `${formatVttTimestamp(mapped.start)} --> ${formatVttTimestamp(mapped.end)}`,
            `${cue.spriteUrl}#xywh=${cue.x},${cue.y},${cue.w},${cue.h}`,
            '',
        );
    }

    return lines.join('\n');
}

/**
 * Where a cue belongs on the output timeline, or null when the frame it shows
 * was cut and so has no place there.
 *
 * A cue that starts inside a retained range but runs past its end is truncated
 * at the cut rather than allowed to spill across it — beyond that point the
 * frame no longer describes what is playing.
 */
function mapCue(
    startTime: number,
    endTime: number,
    ranges: readonly TrimSegment[],
): { start: number; end: number } | null {
    const start = sourceToOutput(startTime, ranges);
    if (start === null) return null;

    const containing = ranges.find(
        (r) => startTime >= r.inSec && startTime < r.outSec,
    );
    if (!containing) return null;

    const available = containing.outSec - startTime;
    const duration = Math.min(endTime - startTime, available);
    if (duration <= 0) return null;

    return { start, end: start + duration };
}
