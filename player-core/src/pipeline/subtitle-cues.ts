import { cuesToLyrics, type LyricCue } from '../lyrics.js';
import { parseVttCues, parseVttTimestamp } from '../vtt.js';
import type { SubtleLike } from './decrypt.js';
import { fetchMaybeEncrypted } from './fetch.js';
import { scanMediaPlaylist } from './media-scan.js';
import { masterTrackId, type MasterInfo } from './pipeline.js';
import { absolutizeAgainst, parseMasterText } from './playlist-text.js';

export interface SubtitleReadContext {
    fetchImpl: typeof fetch;
    keyHex?: string;
    subtle?: SubtleLike;
    signal?: AbortSignal;
}

/** Segments read at once: enough to overlap the round trips, few enough to leave the engine its connections. */
const READS_IN_FLIGHT = 4;

/** The MPEG-2 clock: 90 kHz, wrapping at 33 bits. */
const MPEG_HZ = 90_000;
const MPEG_WRAP = 2 ** 33;

/**
 * Every line of a subtitle track the master declares, read in full: its media playlist, then each segment,
 * decrypted where it is LMCENC. An engine that draws subtitles itself hands none of their words back, so a
 * host that shows them elsewhere (as lyrics) reads them here.
 *
 * Times are the playlists' own, the clock the sound plays on, and nothing is read from the media. A segment's
 * `X-TIMESTAMP-MAP` places it against the first segment that has one; each segment's window in the subtitle
 * playlist (its `#EXTINF` start and length) settles where its cues belong.
 *
 * Empty when the master declares no such track; rejects when the playlist or a segment cannot be read.
 */
export async function readSubtitleCues(
    info: MasterInfo,
    trackId: string,
    ctx: SubtitleReadContext,
): Promise<LyricCue[]> {
    const master = parseMasterText(info.text);
    const entry = master.media.find(
        (media) =>
            media.type === 'SUBTITLES' &&
            media.uri &&
            masterTrackId('m', media.groupId, media.name, media.language) === trackId,
    );
    if (!entry?.uri) return [];

    const options = { fetchImpl: ctx.fetchImpl, keyHex: ctx.keyHex, subtle: ctx.subtle, signal: ctx.signal };
    const fromMaster = absolutizeAgainst(info.url);

    const playlistUrl = fromMaster(entry.uri);
    const playlist = await fetchMaybeEncrypted(playlistUrl, { ...options, expect: 'playlist' });
    const resolve = absolutizeAgainst(playlistUrl);
    // Each segment's window in the playlist, by its URL; a URL named again keeps its first window.
    const windows = new Map<string, { start: number; end: number }>();
    for (const run of scanMediaPlaylist(playlist.text).runs) {
        const url = resolve(run.uri);
        if (!windows.has(url)) windows.set(url, { start: run.start, end: run.end });
    }
    const urls = [...windows.keys()];

    const texts: string[] = new Array(urls.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < urls.length) {
            const index = next++;
            texts[index] = (await fetchMaybeEncrypted(urls[index]!, { ...options, expect: 'vtt' })).text;
        }
    };
    await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, urls.length) }, worker));

    let anchor: number | null = null;
    return cuesToLyrics(
        texts.flatMap((text, index) => {
            const map = timestampMap(text);
            if (map && anchor === null) anchor = map.mpegts;
            const mapped = cueShift(map, anchor);
            const shift = mapped + windowShift(text, mapped, windows.get(urls[index]!));
            return parseVttCues(text)
                .map((cue) => ({ startTime: cue.startTime + shift, endTime: cue.endTime + shift, text: cue.title }))
                .filter((cue) => cue.endTime > 0)
                .map((cue) => ({ ...cue, startTime: Math.max(0, cue.startTime) }));
        }),
    );
}

/** A window's leeway: a cue may start a little before its segment, or run on past it. */
const WINDOW_SLACK = 1;

/**
 * Seconds a segment's cues still need when they are written against the segment's own start rather than the
 * stream's: all of them end before its window opens, and moved by the window's start they fall inside it.
 */
function windowShift(vtt: string, shift: number, window: { start: number; end: number } | undefined): number {
    if (!window || window.start <= WINDOW_SLACK) return 0;
    const cues = parseVttCues(vtt).map((cue) => ({ start: cue.startTime + shift, end: cue.endTime + shift }));
    if (cues.length === 0) return 0;
    const before = cues.every((cue) => cue.end <= window.start - WINDOW_SLACK);
    const inside = cues.every((cue) => cue.start + window.start < window.end + WINDOW_SLACK);
    return before && inside ? window.start : 0;
}

/**
 * Seconds to add to a segment's cue times: `(MPEGTS − anchor) / 90 kHz − LOCAL`, against the first segment's
 * MPEG-TS, the difference taken the short way round its 33-bit wrap. None for a segment without a map.
 */
export function cueShift(map: TimestampMap | null, anchor: number | null): number {
    if (!map) return 0;
    let delta = (map.mpegts - (anchor ?? map.mpegts)) % MPEG_WRAP;
    if (delta > MPEG_WRAP / 2) delta -= MPEG_WRAP;
    if (delta < -MPEG_WRAP / 2) delta += MPEG_WRAP;
    return delta / MPEG_HZ - map.local;
}

export interface TimestampMap {
    mpegts: number;
    local: number;
}

/** A segment's `X-TIMESTAMP-MAP`, from its header; null where it has none. */
export function timestampMap(vtt: string): TimestampMap | null {
    const header = vtt.replace(/\r\n?/g, '\n').split('\n\n', 1)[0] ?? '';
    const line = header.split('\n').find((l) => l.trim().startsWith('X-TIMESTAMP-MAP='));
    if (!line) return null;
    const mpegts = Number(line.match(/MPEGTS:(\d+)/)?.[1] ?? 0);
    const localText = line.match(/LOCAL:([0-9:.]+)/)?.[1];
    const local = localText ? parseVttTimestamp(localText) : 0;
    return { mpegts: Number.isFinite(mpegts) ? mpegts : 0, local: Number.isFinite(local) ? local : 0 };
}
