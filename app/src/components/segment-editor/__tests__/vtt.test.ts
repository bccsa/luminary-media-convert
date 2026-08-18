import { describe, expect, it } from 'vitest';
import {
    exportChaptersVtt,
    exportSubtitlesVtt,
    formatVttTimestamp,
    parseVtt,
    parseVttTimestamp,
} from '../vtt';
import type { Segment } from '../types';

const mkSeg = (inSec: number, outSec: number, label?: string): Segment => ({
    id: `seg-${inSec}-${outSec}`,
    inSec,
    outSec,
    label,
});

describe('formatVttTimestamp', () => {
    it('formats as HH:MM:SS.mmm with zero-padding', () => {
        expect(formatVttTimestamp(0)).toBe('00:00:00.000');
        expect(formatVttTimestamp(3661.5)).toBe('01:01:01.500');
    });

    it('clamps NaN and negative values to zero', () => {
        expect(formatVttTimestamp(Number.NaN)).toBe('00:00:00.000');
        expect(formatVttTimestamp(-3)).toBe('00:00:00.000');
    });
});

describe('parseVttTimestamp', () => {
    it('parses HH:MM:SS.mmm and MM:SS.mmm', () => {
        expect(parseVttTimestamp('00:00:10.500')).toBeCloseTo(10.5, 4);
        expect(parseVttTimestamp('01:30.250')).toBeCloseTo(90.25, 4);
    });

    it('accepts comma as decimal separator (SRT-style)', () => {
        expect(parseVttTimestamp('00:01:00,000')).toBeCloseTo(60, 4);
    });

    it('zero-pads short millisecond segments', () => {
        expect(parseVttTimestamp('00:00:00.5')).toBeCloseTo(0.5, 4);
    });

    it('returns null for malformed input', () => {
        expect(parseVttTimestamp('not a timestamp')).toBe(null);
        expect(parseVttTimestamp('')).toBe(null);
    });
});

describe('exportSubtitlesVtt', () => {
    it('emits a WEBVTT header, sequential cue numbers, and cue text', () => {
        const segments = [
            mkSeg(1, 3, 'Hello'),
            mkSeg(4, 6, 'World'),
        ];
        const out = exportSubtitlesVtt(segments);
        expect(out.startsWith('WEBVTT\n')).toBe(true);
        expect(out).toContain('1\n00:00:01.000 --> 00:00:03.000\nHello');
        expect(out).toContain('2\n00:00:04.000 --> 00:00:06.000\nWorld');
    });

    it('sorts input segments before emitting', () => {
        const segments = [mkSeg(10, 12, 'later'), mkSeg(1, 3, 'earlier')];
        const out = exportSubtitlesVtt(segments);
        expect(out.indexOf('earlier')).toBeLessThan(out.indexOf('later'));
    });

    it('escapes special VTT characters', () => {
        const out = exportSubtitlesVtt([mkSeg(0, 1, '<b>A & B</b>')]);
        expect(out).toContain('&lt;b&gt;A &amp; B&lt;/b&gt;');
    });

    it('handles segments without a label', () => {
        const out = exportSubtitlesVtt([mkSeg(0, 1)]);
        expect(out).toMatch(/00:00:00\.000 --> 00:00:01\.000\n\n/);
    });
});

describe('exportChaptersVtt', () => {
    it('numbers chapters and falls back to a default title', () => {
        const out = exportChaptersVtt([mkSeg(0, 30), mkSeg(30, 60, 'Intro')]);
        expect(out).toContain('Chapter 1\n00:00:00.000 --> 00:00:30.000\nChapter 1');
        expect(out).toContain('Chapter 2\n00:00:30.000 --> 00:01:00.000\nIntro');
    });

    it('treats whitespace-only labels as empty', () => {
        const out = exportChaptersVtt([mkSeg(0, 1, '   ')]);
        expect(out).toContain('Chapter 1\n00:00:00.000 --> 00:00:01.000\nChapter 1');
    });
});

describe('parseVtt', () => {
    it('round-trips subtitle segments via export → parse', () => {
        const segments = [mkSeg(1, 3, 'Hello'), mkSeg(4, 6, 'World')];
        const parsed = parseVtt(exportSubtitlesVtt(segments));
        expect(parsed).toHaveLength(2);
        expect(parsed[0].inSec).toBeCloseTo(1, 4);
        expect(parsed[0].outSec).toBeCloseTo(3, 4);
        expect(parsed[0].label).toBe('Hello');
    });

    it('ignores NOTE, STYLE, and REGION blocks', () => {
        const doc = [
            'WEBVTT',
            '',
            'NOTE this is a comment',
            '',
            'STYLE',
            '::cue { color: red }',
            '',
            'REGION',
            'id:foo',
            '',
            '1',
            '00:00:01.000 --> 00:00:02.000',
            'First',
        ].join('\n');
        const parsed = parseVtt(doc);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].label).toBe('First');
    });

    it('accepts CRLF line endings', () => {
        const doc = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nA\r\n';
        expect(parseVtt(doc)).toHaveLength(1);
    });

    it('skips blocks without a timing line', () => {
        const doc = 'WEBVTT\n\njust an identifier with no timing\n';
        expect(parseVtt(doc)).toHaveLength(0);
    });

    it('skips zero-length or inverted cues', () => {
        const doc = [
            'WEBVTT',
            '',
            '00:00:01.000 --> 00:00:01.000',
            'zero length',
            '',
            '00:00:05.000 --> 00:00:03.000',
            'inverted',
        ].join('\n');
        expect(parseVtt(doc)).toHaveLength(0);
    });

    it('ignores cue settings after the end timestamp', () => {
        const doc = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start line:0%\nA\n';
        const parsed = parseVtt(doc);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].outSec).toBeCloseTo(2, 4);
    });

    it('returns segments with undefined label when the body is empty', () => {
        const doc = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n';
        const parsed = parseVtt(doc);
        expect(parsed[0].label).toBeUndefined();
    });

    it('skips unparseable timestamp values', () => {
        const doc = 'WEBVTT\n\ngarbage --> also-garbage\nA\n';
        expect(parseVtt(doc)).toHaveLength(0);
    });

    it('tolerates leading and trailing blank blocks', () => {
        const doc = '\n\n\nWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n\n\n';
        const parsed = parseVtt(doc);
        expect(parsed).toHaveLength(1);
    });
});
