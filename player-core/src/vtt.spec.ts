import { describe, expect, it } from 'vitest';
import { parseVttCues, parseVttTimestamp } from './vtt.js';
import { CHAPTERS_VTT } from './test-support/index.js';

describe('parseVttTimestamp', () => {
    it('parses the three WebVTT shapes', () => {
        expect(parseVttTimestamp('00:00:00.000')).toBe(0);
        expect(parseVttTimestamp('00:01:30.500')).toBe(90.5);
        expect(parseVttTimestamp('01:00:00.000')).toBe(3600);
        expect(parseVttTimestamp('01:30.500')).toBe(90.5);
        expect(parseVttTimestamp('12.250')).toBe(12.25);
    });

    it('returns NaN for junk', () => {
        expect(parseVttTimestamp('later')).toBeNaN();
    });
});

describe('parseVttCues', () => {
    it('parses chapter cues with identifiers', () => {
        expect(parseVttCues(CHAPTERS_VTT)).toEqual([
            { startTime: 0, endTime: 90.5, title: 'Opening' },
            { startTime: 90.5, endTime: 240, title: 'The interview' },
        ]);
    });

    it('handles CRLF, a BOM and cue settings', () => {
        const text =
            '﻿WEBVTT\r\n\r\n00:00:00.000 --> 00:00:05.000 line:0 position:50%\r\nIntro\r\n';
        expect(parseVttCues(text)).toEqual([
            { startTime: 0, endTime: 5, title: 'Intro' },
        ]);
    });

    it('joins multi-line cue text and strips inline tags', () => {
        const text = 'WEBVTT\n\n00:00.000 --> 00:02.000\n<b>Part</b>\nOne\n';
        expect(parseVttCues(text)[0]?.title).toBe('Part One');
    });

    it('skips NOTE / STYLE blocks', () => {
        const text = [
            'WEBVTT',
            '',
            'NOTE this file was generated',
            '',
            'STYLE',
            '::cue { color: peachpuff; }',
            '',
            '00:00.000 --> 00:01.000',
            'Only cue',
            '',
        ].join('\n');
        expect(parseVttCues(text)).toEqual([
            { startTime: 0, endTime: 1, title: 'Only cue' },
        ]);
    });

    it('degrades to no chapters instead of throwing on non-VTT input', () => {
        expect(parseVttCues('#EXTM3U\n')).toEqual([]);
        expect(parseVttCues('')).toEqual([]);
    });
});
