import type { Chapter } from './types.js';

/** One stretch of the timeline between two chapter starts, as a fraction of the whole video. */
export interface ChapterSegment {
    /** Index into the chapter list the segment was cut from; -1 for the stretch before the first chapter. */
    index: number;
    /** Start and end in seconds. */
    startTime: number;
    endTime: number;
    /** Start and end as fractions of the duration, 0 to 1. Together the segments cover 0 to 1 with no gaps. */
    start: number;
    end: number;
    /** The chapter's title; empty for the stretch before the first chapter. */
    title: string;
}

/**
 * The chapter a moment belongs to: the last one that has started by then. A chapter runs until the next one
 * starts, whatever its own `endTime` says, so a gap in the file does not leave the label empty mid-video.
 * -1 when there are no chapters or the moment is before the first.
 */
export function chapterIndexAt(chapters: readonly Chapter[], time: number): number {
    let found = -1;
    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i]!;
        if (chapter.startTime <= time && (found < 0 || chapter.startTime >= chapters[found]!.startTime)) found = i;
    }
    return found;
}

/**
 * The timeline cut at each chapter start, for a bar drawn as separate stretches with a small gap between them.
 *
 * Chapters are cut points: each segment runs from its chapter's start to the next one's, and the last to the
 * end of the video, so the segments tile the bar exactly. A first chapter that starts after zero leaves a
 * leading segment of its own (`index` -1). A chapter at or past the end of the video, or starting at the same
 * moment as an earlier one, makes no segment.
 *
 * Empty when the bar should stay one plain bar: no usable duration, or fewer than two segments.
 */
export function chapterSegments(chapters: readonly Chapter[], duration: number): ChapterSegment[] {
    if (!Number.isFinite(duration) || !(duration > 0)) return [];
    const starts: { index: number; time: number }[] = [];
    chapters.forEach((chapter, index) => {
        if (Number.isFinite(chapter.startTime) && chapter.startTime < duration) {
            starts.push({ index, time: Math.max(0, chapter.startTime) });
        }
    });
    starts.sort((a, b) => a.time - b.time || a.index - b.index);
    const unique = starts.filter((entry, i) => i === 0 || entry.time > starts[i - 1]!.time);
    if (!unique.length) return [];
    if (unique[0]!.time > 0) unique.unshift({ index: -1, time: 0 });

    const segments = unique.map((entry, i): ChapterSegment => {
        const endTime = i + 1 < unique.length ? unique[i + 1]!.time : duration;
        return {
            index: entry.index,
            startTime: entry.time,
            endTime,
            start: entry.time / duration,
            end: endTime / duration,
            title: entry.index < 0 ? '' : (chapters[entry.index]!.title ?? ''),
        };
    });
    return segments.length < 2 ? [] : segments;
}
