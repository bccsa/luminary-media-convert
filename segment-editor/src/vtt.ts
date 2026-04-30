import type { Segment } from './types';
import { createSegmentId } from './types';

function pad(n: number, width: number): string {
    return String(Math.floor(n)).padStart(width, '0');
}

/** Format seconds as `HH:MM:SS.mmm`, the WebVTT timestamp format. */
export function formatVttTimestamp(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const whole = Math.floor(s);
    const ms = Math.round((s - whole) * 1000);
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(whole, 2)}.${pad(ms, 3)}`;
}

/** Parse a WebVTT timestamp (`HH:MM:SS.mmm` or `MM:SS.mmm`) into seconds, or `null` if invalid. */
export function parseVttTimestamp(s: string): number | null {
    const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ms = parseInt(m[4].padEnd(3, '0'), 10);
    return h * 3600 + mm * 60 + ss + ms / 1000;
}

function escapeVttText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Export segments as a WebVTT subtitle file.
 * The segment `label` is used as the cue text; newlines are preserved.
 */
export function exportSubtitlesVtt(segments: Segment[]): string {
    const sorted = [...segments].sort((a, b) => a.inSec - b.inSec);
    const lines = ['WEBVTT', ''];
    sorted.forEach((seg, i) => {
        lines.push(String(i + 1));
        lines.push(`${formatVttTimestamp(seg.inSec)} --> ${formatVttTimestamp(seg.outSec)}`);
        lines.push(escapeVttText(seg.label ?? ''));
        lines.push('');
    });
    return lines.join('\n');
}

/**
 * Export segments as a WebVTT chapters file.
 * The segment `label` is used as the chapter title; defaults to "Chapter N" when unset.
 */
export function exportChaptersVtt(segments: Segment[]): string {
    const sorted = [...segments].sort((a, b) => a.inSec - b.inSec);
    const lines = ['WEBVTT', ''];
    sorted.forEach((seg, i) => {
        lines.push(`Chapter ${i + 1}`);
        lines.push(`${formatVttTimestamp(seg.inSec)} --> ${formatVttTimestamp(seg.outSec)}`);
        lines.push(escapeVttText(seg.label?.trim() || `Chapter ${i + 1}`));
        lines.push('');
    });
    return lines.join('\n');
}

/**
 * Parse a WebVTT document into segments. Works for subtitle and chapter VTTs.
 * Cue settings (position, align, etc.) are ignored.
 */
export function parseVtt(text: string): Segment[] {
    const normalized = text.replace(/\r\n?/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const segments: Segment[] = [];
    for (const raw of blocks) {
        const block = raw.trim();
        if (!block) continue;
        if (/^WEBVTT\b/i.test(block)) continue;
        if (/^(NOTE|STYLE|REGION)\b/i.test(block)) continue;
        const blockLines = block.split('\n');
        const timingIdx = blockLines.findIndex((line) => line.includes('-->'));
        if (timingIdx === -1) continue;
        const [startRaw, endRawWithSettings] = blockLines[timingIdx].split('-->').map((s) => s.trim());
        const endRaw = endRawWithSettings.split(/\s+/)[0];
        const inSec = parseVttTimestamp(startRaw);
        const outSec = parseVttTimestamp(endRaw);
        if (inSec === null || outSec === null || outSec <= inSec) continue;
        const label = blockLines.slice(timingIdx + 1).join('\n').trim();
        segments.push({ id: createSegmentId(), inSec, outSec, label: label || undefined });
    }
    return segments;
}
