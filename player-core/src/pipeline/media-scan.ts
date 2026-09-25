/**
 * One pass over a media playlist, for everything the player asks of one.
 *
 * The pipeline asks four things of every media playlist it reads: is it still
 * being written, does it declare an AES-128 key, what are its segments, and —
 * for chunk warming — which runs of them share a chunk object. It used to ask
 * each of those of `hls-core`'s lossless model, parsing the whole playlist
 * again for every question: three or four parses per playlist per attach, each
 * allocating a model object, a layout entry and a WeakMap record per segment,
 * for answers that need none of that. On a two-hour ladder that was tens of
 * milliseconds and tens of megabytes of garbage on every load, angle switch and
 * audio toggle — a long task a low-end phone feels as a frozen toggle.
 *
 * So this is string work, like the rewrite beside it and for the same reasons:
 * it reads a handful of tags and leaves everything else alone, and it sits on
 * live's per-request path, so it is part of what a Swift or Kotlin serving
 * layer ports. The lossless model stays where it earns its keep — the master
 * munge, and the API's own playlist building.
 *
 * What it reports follows `hls-core`'s `parseMediaPlaylist` exactly, so the
 * two can never disagree about a playlist:
 *
 * - Lines are split on `\n` and trimmed; blank lines and `#EXTM3U` are skipped.
 * - `#EXTINF:` opens a segment, dropping one still waiting for its URI. Its
 *   duration is `Number` of the text before the first comma.
 * - `#EXT-X-BYTERANGE:` attaches to the waiting segment when its value is
 *   `<length>[@<offset>]`; otherwise it drops the waiting segment.
 * - A line not starting with `#` is the waiting segment's URI; with nothing
 *   waiting it is not a segment at all.
 * - Any other tag drops a waiting segment.
 * - A key counts when its `METHOD` is present, non-empty and not `NONE`.
 * - `#EXT-X-TARGETDURATION` and `#EXT-X-MEDIA-SEQUENCE` count when finite; the
 *   last one wins. `#EXT-X-ENDLIST` counts only as the whole line.
 */

import { parseMediaPlaylist } from '@luminary-media-converter/hls-core';

/** Everything the pipeline needs to know about one media playlist. */
export interface MediaPlaylistScan {
    /**
     * No `#EXT-X-ENDLIST`: the playlist is still being written and has to be
     * re-read for as long as it plays. See `describeLiveness`.
     */
    isLive: boolean;
    /** `#EXT-X-TARGETDURATION`; 0 when the playlist declares none. */
    targetDurationSec: number;
    /** `#EXT-X-MEDIA-SEQUENCE`; 0 when the playlist declares none. */
    mediaSequence: number;
    /** Some `#EXT-X-KEY` declares a method other than `NONE`. */
    hasAes128Key: boolean;
    /** Some segment carries an `#EXT-X-BYTERANGE`. */
    hasByteRanges: boolean;
    /**
     * The segments, in order, as runs of consecutive segments that name the
     * same URI. Byte-range output packs a hundred segments into each chunk
     * object, so its runs number a dozen where its segments number a thousand;
     * any other playlist is one run per segment.
     */
    runs: SegmentRun[];
}

/** Consecutive segments naming one URI. */
export interface SegmentRun {
    /** The URI exactly as written in the playlist. */
    uri: string;
    /** How many segments in a row name it. */
    count: number;
    /** Media time the run starts at: the `#EXTINF` durations before it. */
    start: number;
    /** Media time the run ends at. */
    end: number;
}

const EXTINF = '#EXTINF:';
const BYTERANGE = '#EXT-X-BYTERANGE:';
const KEY = '#EXT-X-KEY:';
const TARGETDURATION = '#EXT-X-TARGETDURATION:';
const MEDIA_SEQUENCE = '#EXT-X-MEDIA-SEQUENCE:';

/**
 * The walk reads the text in place — each line is a pair of offsets, trimmed
 * the way `String.prototype.trim` would trim it — and copies out only what it
 * keeps: a run's URI once per run, an `#EXTINF` duration. Splitting into line
 * strings first cost a string per line and two arrays per playlist, three
 * thousand lines at a time, for text it mostly only needs to glance at.
 */
export function scanMediaPlaylist(text: string): MediaPlaylistScan {
    let isLive = true;
    let targetDurationSec = 0;
    let mediaSequence = 0;
    let hasAes128Key = false;
    let hasByteRanges = false;
    const runs: SegmentRun[] = [];

    let elapsed = 0;
    /** Duration of an `#EXTINF` still waiting for its URI. */
    let waiting: number | undefined;
    let waitingHasRange = false;
    // The last duration read, by its text: an encode writes the same one on
    // nearly every segment, and re-reading it costs a copy and a parse apiece.
    let durationText = '';
    let duration = 0;

    // Line by line as `split('\n')` would cut it, trimmed to [start, end).
    for (let next = 0; next <= text.length; ) {
        let end = text.indexOf('\n', next);
        if (end < 0) end = text.length;
        let start = next;
        next = end + 1;
        while (start < end && isTrimmed(text.charCodeAt(start))) start++;
        while (end > start && isTrimmed(text.charCodeAt(end - 1))) end--;

        if (start === end) continue;

        // A URI first: a third of the lines in a byte-range playlist, and
        // nothing that starts with `#` can be one.
        if (text.charCodeAt(start) !== HASH) {
            if (waiting === undefined) continue;
            const from = elapsed;
            elapsed += waiting;
            const last = runs[runs.length - 1];
            if (last && isLine(text, start, end, last.uri)) {
                last.count += 1;
                last.end = elapsed;
            } else {
                const uri = text.slice(start, end);
                runs.push({ uri, count: 1, start: from, end: elapsed });
            }
            if (waitingHasRange) hasByteRanges = true;
            waiting = undefined;
            continue;
        }

        if (hasTag(text, start, end, EXTINF)) {
            // `#EXTINF:<duration>,<title>`: the duration is `Number` of the
            // text before the first comma.
            const from = start + EXTINF.length;
            const comma = text.indexOf(',', from);
            const to = comma >= 0 && comma < end ? comma : end;
            if (!isLine(text, from, to, durationText)) {
                durationText = text.slice(from, to);
                duration = Number(durationText);
            }
            waiting = duration;
            waitingHasRange = false;
            continue;
        }

        if (hasTag(text, start, end, BYTERANGE)) {
            let value = start + BYTERANGE.length;
            while (value < end && isTrimmed(text.charCodeAt(value))) value++;
            if (waiting !== undefined && isByteRange(text, value, end)) {
                waitingHasRange = true;
            } else {
                waiting = undefined;
            }
            continue;
        }

        if (isLine(text, start, end, '#EXTM3U')) continue;

        // Every other tag ends a segment still waiting for its URI.
        waiting = undefined;

        if (hasTag(text, start, end, KEY)) {
            if (!hasAes128Key && keyApplies(text.slice(start, end))) {
                hasAes128Key = true;
            }
        } else if (hasTag(text, start, end, TARGETDURATION)) {
            const value = numberAt(text, start + TARGETDURATION.length, end);
            if (Number.isFinite(value)) targetDurationSec = value;
        } else if (hasTag(text, start, end, MEDIA_SEQUENCE)) {
            const value = numberAt(text, start + MEDIA_SEQUENCE.length, end);
            if (Number.isFinite(value)) mediaSequence = value;
        } else if (isLine(text, start, end, '#EXT-X-ENDLIST')) {
            isLive = false;
        }
    }

    return {
        isLive,
        targetDurationSec,
        mediaSequence,
        hasAes128Key,
        hasByteRanges,
        runs,
    };
}

const HASH = 0x23;
const AT = 0x40;

/**
 * What `String.prototype.trim` removes: ECMAScript WhiteSpace and
 * LineTerminator — tab through carriage return, space, no-break space, the
 * Unicode space separators, the line and paragraph separators, and the BOM.
 */
function isTrimmed(code: number): boolean {
    // Printable ASCII is nearly every character asked about, and none of it.
    if (code > 0x20 && code < 0x7f) return false;
    return (
        code === 0x20 ||
        (code >= 0x09 && code <= 0x0d) ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    );
}

/** The trimmed line [start, end) starts with `tag`. */
function hasTag(
    text: string,
    start: number,
    end: number,
    tag: string,
): boolean {
    return end - start >= tag.length && text.startsWith(tag, start);
}

/** The trimmed line [start, end) is exactly `line`. */
function isLine(
    text: string,
    start: number,
    end: number,
    line: string,
): boolean {
    return end - start === line.length && text.startsWith(line, start);
}

/**
 * `Number` of the text in [from, to). `Number` skips the same whitespace
 * `trim` does, so the slice needs no trimming of its own.
 */
function numberAt(text: string, from: number, to: number): number {
    return Number(text.slice(from, to));
}

/**
 * [from, to) is `<length>[@<offset>]` — ASCII digits only, as the `\d` in
 * `hls-core`'s `parseByteRange` reads them.
 */
function isByteRange(text: string, from: number, to: number): boolean {
    let at = digits(text, from, to);
    if (at === from) return false;
    if (at === to) return true;
    if (text.charCodeAt(at) !== AT) return false;
    const offset = at + 1;
    at = digits(text, offset, to);
    return at > offset && at === to;
}

/** The end of the run of ASCII digits starting at `from`. */
function digits(text: string, from: number, to: number): number {
    let at = from;
    while (at < to) {
        const code = text.charCodeAt(at);
        if (code < 0x30 || code > 0x39) break;
        at++;
    }
    return at;
}

/**
 * Whether one `#EXT-X-KEY` line declares a key.
 *
 * Through `hls-core`'s own attribute parser, on the line alone: a quoted
 * attribute may contain commas, and a second quote-aware splitter here would be
 * a second opinion on which `METHOD` a line carries. Key lines are rare — one
 * per playlist in the encoder's output — so the model's cost is paid once, not
 * per segment.
 */
function keyApplies(line: string): boolean {
    const key = parseMediaPlaylist(line).keys[0];
    return key !== undefined && key.method !== 'NONE';
}
