import type { ChapterSegment } from '@luminary-media-converter/player-core';

/** Half the gap between two chapters, in px at the player's normal scale; it follows `--lmpl-s` with everything else. */
const HALF_GAP_PX = 1.5;

/**
 * A mask that cuts the timeline into its chapters: opaque everywhere except a thin band at each chapter start.
 * Applied to the track it opens a gap through the track, its buffer and its fill alike, so the bar reads as
 * separate stretches wherever it is drawn, over any picture, without a gap colour to match.
 *
 * Empty when there is nothing to cut (fewer than two segments), so the bar stays one plain bar.
 */
export function chapterMask(segments: readonly ChapterSegment[]): string {
    if (segments.length < 2) return '';
    const half = `(var(--lmpl-s, 1) * ${HALF_GAP_PX}px)`;
    const stops = ['#000 0'];
    for (const segment of segments.slice(1)) {
        const at = `${(segment.start * 100).toFixed(3)}%`;
        stops.push(
            `#000 calc(${at} - ${half})`,
            `transparent calc(${at} - ${half})`,
            `transparent calc(${at} + ${half})`,
            `#000 calc(${at} + ${half})`
        );
    }
    stops.push('#000 100%');
    return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Fills `{index}` and `{count}` in the "Chapter 4 of 7" message; a translator may move either. */
export function formatChapterOf(template: string, index: number, count: number): string {
    return template.replace('{index}', String(index)).replace('{count}', String(count));
}
