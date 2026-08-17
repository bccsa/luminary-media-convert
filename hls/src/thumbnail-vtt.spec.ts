import { describe, expect, it } from 'vitest';
import {
    findThumbnailCue,
    parseThumbnailVtt,
    type ThumbnailSpriteCue,
} from './thumbnail-vtt.js';

/**
 * The parse itself is covered where it has always been covered, by
 * `segment-editor`'s suite, which now exercises this implementation through its
 * re-export. What is new here is the lookup: it became a binary search when the
 * player started calling it on every pointer move, and a binary search over
 * ranges is easy to get subtly wrong at the edges.
 */
function cues(count: number, span = 10): ThumbnailSpriteCue[] {
    return Array.from({ length: count }, (_, i) => ({
        startTime: i * span,
        endTime: (i + 1) * span,
        spriteUrl: `sprite_${Math.floor(i / 25)}.jpg`,
        x: (i % 5) * 160,
        y: Math.floor((i % 25) / 5) * 90,
        w: 160,
        h: 90,
    }));
}

describe('findThumbnailCue', () => {
    it('finds the cue covering a time, wherever it sits in the list', () => {
        const list = cues(200);
        for (const [at, expected] of [
            [0, 0],
            [9.999, 0],
            [10, 1],
            [1234.5, 123],
            [1999.99, 199],
        ] as const) {
            expect(findThumbnailCue(list, at)?.startTime, `at ${at}`).toBe(
                expected * 10,
            );
        }
    });

    it('is end-exclusive, so adjacent cues never both match', () => {
        // The player nudges away from the very end because of this; the rule is
        // here rather than there, so both sides agree on it.
        const list = cues(3);
        expect(findThumbnailCue(list, 10)).toBe(list[1]);
        expect(findThumbnailCue(list, 30)).toBeUndefined();
    });

    it('finds nothing outside the covered range', () => {
        const list = cues(3);
        expect(findThumbnailCue(list, -1)).toBeUndefined();
        expect(findThumbnailCue(list, 9999)).toBeUndefined();
    });

    it('finds nothing in an empty list', () => {
        expect(findThumbnailCue([], 5)).toBeUndefined();
    });

    it('does not match inside a gap between cues', () => {
        // A trimmed encode can leave holes; returning a neighbouring frame would
        // show a viewer a moment that is not in the video they are watching.
        const list: ThumbnailSpriteCue[] = [
            { ...cues(1)[0]!, startTime: 0, endTime: 10 },
            { ...cues(1)[0]!, startTime: 20, endTime: 30 },
        ];
        expect(findThumbnailCue(list, 15)).toBeUndefined();
        expect(findThumbnailCue(list, 25)?.startTime).toBe(20);
    });
});

describe('parseThumbnailVtt', () => {
    it('returns cues in start order, which the search depends on', () => {
        const vtt = [
            'WEBVTT',
            '',
            '00:00:00.000 --> 00:00:10.000',
            'sprite_0.jpg#xywh=0,0,160,90',
            '',
            '00:00:10.000 --> 00:00:20.000',
            'sprite_0.jpg#xywh=160,0,160,90',
            '',
        ].join('\n');

        const parsed = parseThumbnailVtt(vtt, 'https://cdn.example.com/out');

        expect(parsed.map((c) => c.startTime)).toEqual([0, 10]);
        expect(parsed[1]?.spriteUrl).toBe(
            'https://cdn.example.com/out/sprite_0.jpg',
        );
    });
});
