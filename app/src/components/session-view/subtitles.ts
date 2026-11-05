/**
 * Subtitles as the encoder app handles them: one language's cues as segments
 * (a cue's text in its `label`), read from and written to `.srt` and `.vtt`
 * files, and lined up against another language's for translating.
 */
import {
    createSegmentId,
    formatVttTimestamp,
    parseVtt,
    type Segment,
} from '../segment-editor';

/** The formatting a cue may carry that SRT and WebVTT share; everything else is text. */
const KEPT_TAGS = /<\/?(?:i|b|u)>/g;

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': ' ',
    '&lrm;': '‎',
    '&rlm;': '‏',
};

/**
 * A `.srt` or `.vtt` file's cues, in time order. The two differ only where the
 * reader does not look: SRT numbers its cues, writes a comma before the
 * milliseconds and has no header. Text comes back as typed, with WebVTT's
 * escapes undone.
 */
export function readSubtitleFile(text: string): Segment[] {
    const body = text.replace(/^﻿/, '');
    return parseVtt(body)
        .map((cue) => ({
            ...cue,
            label: cue.label?.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (e) => ENTITIES[e] ?? e),
        }))
        .sort((a, b) => a.inSec - b.inSec);
}

/** A cue's text for WebVTT: `&` and `<` escaped except in the tags both formats share. */
function escapeKeepingTags(text: string): string {
    const parts: string[] = [];
    let last = 0;
    for (const tag of text.matchAll(KEPT_TAGS)) {
        parts.push(escape(text.slice(last, tag.index)), tag[0]);
        last = tag.index! + tag[0].length;
    }
    parts.push(escape(text.slice(last)));
    return parts.join('');
}

const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** No cue without words: an empty one shows nothing and only takes room. */
const spoken = (segments: Segment[]) =>
    [...segments]
        .filter((cue) => cue.label?.trim())
        .sort((a, b) => a.inSec - b.inSec);

/** A WebVTT document of the cues that have words, in time order. */
export function subtitlesToVtt(segments: Segment[]): string {
    const lines = ['WEBVTT', ''];
    spoken(segments).forEach((cue, i) => {
        lines.push(
            String(i + 1),
            `${formatVttTimestamp(cue.inSec)} --> ${formatVttTimestamp(cue.outSec)}`,
            escapeKeepingTags(cue.label!.trim()),
            ''
        );
    });
    return lines.join('\n');
}

/** The same cues as a `.srt` file. */
export function subtitlesToSrt(segments: Segment[]): string {
    const time = (sec: number) => formatVttTimestamp(sec).replace('.', ',');
    return spoken(segments)
        .map((cue, i) => `${i + 1}\n${time(cue.inSec)} --> ${time(cue.outSec)}\n${cue.label!.trim()}\n`)
        .join('\n');
}

/** A new language's cues, timed as `original`'s, waiting for their words. */
export function copyTimings(original: Segment[]): Segment[] {
    return original.map((cue) => ({
        id: createSegmentId(),
        inSec: cue.inSec,
        outSec: cue.outSec,
        label: '',
    }));
}

/** One line of the comparison: an original's words beside a translation's cue. */
export interface CompareRow {
    /** Where the row sits, and where a click on it seeks to. */
    inSec: number;
    outSec: number;
    /** What the original says at that time. */
    original: string;
    /** The translation's cue; none where it does not say anything yet. */
    cue?: Segment;
}

const overlap = (a: { inSec: number; outSec: number }, b: { inSec: number; outSec: number }) =>
    Math.min(a.outSec, b.outSec) - Math.max(a.inSec, b.inSec);

/**
 * The translation's cues beside what the original says over each, in time
 * order, with a row of their own for the original's cues no translation cue
 * covers yet, so nothing the original says is left out of sight.
 */
export function compareRows(original: Segment[], translation: Segment[]): CompareRow[] {
    const cues = [...translation].sort((a, b) => a.inSec - b.inSec);
    const rows: CompareRow[] = cues.map((cue) => ({
        inSec: cue.inSec,
        outSec: cue.outSec,
        original: original
            .filter((o) => overlap(o, cue) > 0)
            .sort((a, b) => a.inSec - b.inSec)
            .map((o) => o.label ?? '')
            .join('\n'),
        cue,
    }));
    for (const o of original) {
        if (cues.some((cue) => overlap(o, cue) > 0)) continue;
        rows.push({ inSec: o.inSec, outSec: o.outSec, original: o.label ?? '' });
    }
    return rows.sort((a, b) => a.inSec - b.inSec || (a.cue ? -1 : 1));
}

/** The name a language goes by in itself, e.g. "Français" for `fr`; the code when there is none. */
export function languageName(code: string): string {
    try {
        const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
        return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code;
    } catch {
        return code;
    }
}

/**
 * Every line moved by `by` seconds, later when positive. A line pushed before
 * the start begins at 0:00; one that would end there is gone, since nothing
 * of it would show.
 */
export function shiftLines(segments: Segment[], by: number): Segment[] {
    return segments
        .filter((cue) => cue.outSec + by > 0)
        .map((cue) => ({ ...cue, inSec: Math.max(0, cue.inSec + by), outSec: cue.outSec + by }));
}

/** A time as a line's list shows it: `0:12.5`, `1:02:03.0`. */
export function shortTime(sec: number): string {
    const t = Math.max(0, Math.round(sec * 10) / 10);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
