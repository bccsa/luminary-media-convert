import { describe, expect, it } from 'vitest';
import {
    findThumbnailCue,
    parseThumbnailVtt,
    parseThumbnailVttTime,
} from '../src/thumbnailVtt';

describe('parseThumbnailVttTime', () => {
    it('parses HH:MM:SS.mmm', () => {
        expect(parseThumbnailVttTime('00:00:00.000')).toBe(0);
        expect(parseThumbnailVttTime('00:00:05.000')).toBe(5);
        expect(parseThumbnailVttTime('00:01:01.500')).toBeCloseTo(61.5, 4);
        expect(parseThumbnailVttTime('01:00:00.000')).toBe(3600);
    });
});

describe('parseThumbnailVtt', () => {
    const sample = `WEBVTT

00:00:00.000 --> 00:00:05.000
sprite_000.webp#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite_000.webp#xywh=160,0,160,90

00:00:10.000 --> 00:00:12.500
https://cdn.example.com/sprite_001.jpg#xywh=0,0,160,90
`;

    it('parses cues and resolves relative sprite URLs against baseUrl', () => {
        const base = 'https://bucket.example/prefix/thumbnails';
        const cues = parseThumbnailVtt(sample, base);
        expect(cues).toHaveLength(3);
        expect(cues[0]).toMatchObject({
            startTime: 0,
            endTime: 5,
            spriteUrl: 'https://bucket.example/prefix/thumbnails/sprite_000.webp',
            x: 0,
            y: 0,
            w: 160,
            h: 90,
        });
        expect(cues[1]).toMatchObject({
            startTime: 5,
            endTime: 10,
            x: 160,
            y: 0,
            w: 160,
            h: 90,
        });
        expect(cues[2]!.spriteUrl).toBe('https://cdn.example.com/sprite_001.jpg');
    });
});

describe('findThumbnailCue', () => {
    const cues = parseThumbnailVtt(
        `WEBVTT

00:00:00.000 --> 00:00:05.000
a.webp#xywh=0,0,10,10

00:00:05.000 --> 00:00:10.000
b.webp#xywh=0,0,10,10
`,
        'https://x/y',
    );

    it('returns the cue covering timeSec', () => {
        expect(findThumbnailCue(cues, 0)).toBe(cues[0]);
        expect(findThumbnailCue(cues, 4.999)).toBe(cues[0]);
        expect(findThumbnailCue(cues, 5)).toBe(cues[1]);
        expect(findThumbnailCue(cues, 9.5)).toBe(cues[1]);
    });

    it('returns undefined outside range', () => {
        expect(findThumbnailCue(cues, 10)).toBeUndefined();
        expect(findThumbnailCue(cues, -0.1)).toBeUndefined();
    });
});
