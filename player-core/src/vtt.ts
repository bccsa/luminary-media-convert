/**
 * Minimal WebVTT cue parser — enough for chapter tracks.
 *
 * Chapters are consumed as data by the implementing app's UI (a chapter list, a
 * timeline), never rendered as styled captions, so this deliberately handles
 * only the header, cue timings and cue text. STYLE / REGION / NOTE blocks and
 * cue settings are skipped, not modelled. Subtitle VTTs are handed to the
 * engine as-is and never come through here.
 */

import type { Chapter } from './types.js';

const TIMING = /^([\d:.]+)\s*-->\s*([\d:.]+)(?:\s+(.*))?$/;

/** `HH:MM:SS.mmm`, `MM:SS.mmm` or `SS.mmm` → seconds. NaN when unparseable. */
export function parseVttTimestamp(value: string): number {
    const parts = value.trim().split(':');
    if (parts.length === 0 || parts.length > 3) return Number.NaN;

    let seconds = 0;
    for (const part of parts) {
        const numeric = Number(part.replace(',', '.'));
        if (!Number.isFinite(numeric)) return Number.NaN;
        seconds = seconds * 60 + numeric;
    }
    return seconds;
}

/**
 * Parse WebVTT cues. Returns `[]` for anything that is not a WebVTT file, so a
 * bad sidecar degrades to "no chapters" rather than breaking a load.
 */
export function parseVttCues(text: string): Chapter[] {
    const normalized = stripBom(text).replace(/\r\n?/g, '\n');
    if (!normalized.startsWith('WEBVTT')) return [];

    const chapters: Chapter[] = [];
    const lines = normalized.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? '').trim();
        if (!line || !line.includes('-->')) continue;

        const match = line.match(TIMING);
        if (!match) continue;
        const startTime = parseVttTimestamp(match[1] ?? '');
        const endTime = parseVttTimestamp(match[2] ?? '');
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue;

        const title: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
            const body = (lines[j] ?? '').trim();
            if (!body) break;
            if (body.includes('-->')) break;
            title.push(body);
            i = j;
        }

        chapters.push({
            startTime,
            endTime,
            title: stripTags(title.join(' ')).trim(),
        });
    }

    return chapters;
}

/** Drop a leading UTF-8 BOM (U+FEFF), which survives a TextDecoder round-trip. */
function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripTags(text: string): string {
    return text.replace(/<\/?[^>]+>/g, '');
}
