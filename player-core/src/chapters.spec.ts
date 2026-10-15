import { describe, expect, it } from 'vitest';
import { chapterIndexAt, chapterSegments } from './chapters.js';
import type { Chapter } from './types.js';

const chapter = (startTime: number, endTime: number, title = `at ${startTime}`): Chapter => ({ startTime, endTime, title });
const three = [chapter(0, 10), chapter(10, 40), chapter(40, 100)];

describe('chapterIndexAt', () => {
    it('is the last chapter that has started', () => {
        expect(chapterIndexAt(three, 0)).toBe(0);
        expect(chapterIndexAt(three, 9.99)).toBe(0);
        expect(chapterIndexAt(three, 10)).toBe(1);
        expect(chapterIndexAt(three, 99)).toBe(2);
        expect(chapterIndexAt(three, 5000)).toBe(2);
    });

    it('is -1 with no chapters or before the first', () => {
        expect(chapterIndexAt([], 5)).toBe(-1);
        expect(chapterIndexAt([chapter(12, 30)], 5)).toBe(-1);
    });

    it('keeps a chapter running through a gap in the file', () => {
        // The first says it ends at 10, the next starts at 20: 15 still belongs to the first.
        expect(chapterIndexAt([chapter(0, 10), chapter(20, 30)], 15)).toBe(0);
    });

    it('does not depend on the order of the list', () => {
        expect(chapterIndexAt([chapter(40, 100), chapter(0, 10), chapter(10, 40)], 12)).toBe(2);
    });
});

describe('chapterSegments', () => {
    it('tiles the whole bar, each segment ending where the next begins', () => {
        const segments = chapterSegments(three, 100);
        expect(segments.map((s) => [s.index, s.startTime, s.endTime])).toEqual([
            [0, 0, 10],
            [1, 10, 40],
            [2, 40, 100],
        ]);
        expect(segments[0]!.start).toBe(0);
        expect(segments[2]!.end).toBe(1);
        for (let i = 1; i < segments.length; i++) expect(segments[i]!.start).toBe(segments[i - 1]!.end);
        expect(segments[1]!.start).toBeCloseTo(0.1);
        expect(segments[1]!.end).toBeCloseTo(0.4);
    });

    it("runs the last chapter to the video's end, whatever its own end says", () => {
        expect(chapterSegments([chapter(0, 10), chapter(10, 20)], 100)[1]!.endTime).toBe(100);
    });

    it('gives a first chapter that starts late a leading stretch of its own', () => {
        const segments = chapterSegments([chapter(12, 50, 'Intro'), chapter(50, 100, 'Body')], 100);
        expect(segments[0]).toMatchObject({ index: -1, startTime: 0, endTime: 12, title: '' });
        expect(segments[1]).toMatchObject({ index: 0, title: 'Intro' });
    });

    it('leaves out chapters at or past the end, and repeated starts', () => {
        const segments = chapterSegments([chapter(0, 10), chapter(10, 20), chapter(10, 30, 'dup'), chapter(100, 120), chapter(150, 160)], 100);
        expect(segments.map((s) => s.index)).toEqual([0, 1]);
    });

    it('keeps the index into the list it was given, whatever the order', () => {
        const segments = chapterSegments([chapter(50, 100, 'late'), chapter(0, 50, 'early')], 100);
        expect(segments.map((s) => [s.index, s.title])).toEqual([
            [1, 'early'],
            [0, 'late'],
        ]);
    });

    it('stays empty when the bar should be one plain bar', () => {
        expect(chapterSegments([], 100)).toEqual([]);
        expect(chapterSegments([chapter(0, 100)], 100)).toEqual([]);
        expect(chapterSegments(three, 0)).toEqual([]);
        expect(chapterSegments(three, NaN)).toEqual([]);
        expect(chapterSegments(three, Infinity)).toEqual([]);
    });

    it('treats a negative start as zero', () => {
        expect(chapterSegments([chapter(-5, 10), chapter(10, 20)], 20)[0]).toMatchObject({ startTime: 0, endTime: 10 });
    });
});
