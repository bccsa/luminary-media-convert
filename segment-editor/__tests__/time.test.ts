import { describe, expect, it } from 'vitest';
import { formatDuration, formatTime, parseTime } from '../src/time';

describe('formatTime', () => {
    it('formats seconds under one minute as M:SS.mmm', () => {
        expect(formatTime(0)).toBe('0:00.000');
        expect(formatTime(3.5)).toBe('0:03.500');
        expect(formatTime(59.123)).toBe('0:59.123');
    });

    it('formats minutes and seconds with three-digit ms', () => {
        expect(formatTime(90.25)).toBe('1:30.250');
        expect(formatTime(180)).toBe('3:00.000');
    });

    it('includes hours when at least one hour', () => {
        expect(formatTime(3600)).toBe('1:00:00.000');
        expect(formatTime(3661.5)).toBe('1:01:01.500');
    });

    it('clamps NaN and negative values to zero', () => {
        expect(formatTime(Number.NaN)).toBe('0:00.000');
        expect(formatTime(-5)).toBe('0:00.000');
    });
});

describe('formatDuration', () => {
    it('formats sub-minute durations with one decimal', () => {
        expect(formatDuration(0)).toBe('0.0s');
        expect(formatDuration(12.34)).toBe('12.3s');
    });

    it('formats minutes and seconds without hours', () => {
        expect(formatDuration(75)).toBe('1m 15s');
    });

    it('formats with hours when at least an hour', () => {
        expect(formatDuration(3665)).toBe('1h 1m 5s');
    });

    it('returns 0s for NaN and negative values', () => {
        expect(formatDuration(Number.NaN)).toBe('0s');
        expect(formatDuration(-1)).toBe('0s');
    });
});

describe('parseTime', () => {
    it('parses HH:MM:SS.mmm', () => {
        expect(parseTime('1:02:03.500')).toBeCloseTo(3723.5, 4);
    });

    it('parses MM:SS.mmm', () => {
        expect(parseTime('2:30.250')).toBeCloseTo(150.25, 4);
    });

    it('parses bare seconds', () => {
        expect(parseTime('42.5')).toBe(42.5);
    });

    it('returns null for empty or malformed input', () => {
        expect(parseTime('')).toBe(null);
        expect(parseTime('not a time')).toBe(null);
        expect(parseTime('1:2:3:4')).toBe(null);
    });
});
