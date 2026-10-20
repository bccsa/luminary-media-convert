import { cuesToLyrics, type LyricCue } from '../lyrics.js';
import { parseVttCues, parseVttTimestamp } from '../vtt.js';
import type { SubtleLike } from './decrypt.js';
import { fetchMaybeEncrypted } from './fetch.js';
import { readMediaStart } from './media-start.js';
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
 * Times are the player's: each segment's `X-TIMESTAMP-MAP` (MPEG-TS 0 at local 0 where it has none) is read
 * against where the stream's media clock starts, as a player places the cues it draws.
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
    // The sound's own rendition when there is one: lyrics are shown with the sound alone.
    const mainUri =
        master.media.find((media) => media.type === 'AUDIO' && media.uri)?.uri ?? master.variants[0]?.uri;
    const mediaStart = mainUri ? readMediaStart(fromMaster(mainUri), options) : Promise.resolve(null);

    const playlistUrl = fromMaster(entry.uri);
    const playlist = await fetchMaybeEncrypted(playlistUrl, { ...options, expect: 'playlist' });
    const resolve = absolutizeAgainst(playlistUrl);
    const urls = [...new Set(scanMediaPlaylist(playlist.text).runs.map((run) => resolve(run.uri)))];

    const texts: string[] = new Array(urls.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < urls.length) {
            const index = next++;
            texts[index] = (await fetchMaybeEncrypted(urls[index]!, { ...options, expect: 'vtt' })).text;
        }
    };
    await Promise.all(Array.from({ length: Math.min(READS_IN_FLIGHT, urls.length) }, worker));

    const start = await mediaStart;
    return cuesToLyrics(
        texts.flatMap((text) => {
            const shift = cueShift(text, start);
            return parseVttCues(text)
                .map((cue) => ({ startTime: cue.startTime + shift, endTime: cue.endTime + shift, text: cue.title }))
                .filter((cue) => cue.endTime > 0)
                .map((cue) => ({ ...cue, startTime: Math.max(0, cue.startTime) }));
        }),
    );
}

/**
 * Seconds to add to a segment's cue times to put them on the player's timeline:
 * `(MPEGTS − media start) / 90 kHz − LOCAL`, the MPEG difference taken the short way round its 33-bit wrap.
 * With the media start unknown, the map is taken to mark it.
 */
export function cueShift(vtt: string, mediaStart: number | null): number {
    const { mpegts, local } = timestampMap(vtt);
    if (mediaStart === null) return -local;
    let delta = (mpegts - Math.round(mediaStart * MPEG_HZ)) % MPEG_WRAP;
    if (delta > MPEG_WRAP / 2) delta -= MPEG_WRAP;
    if (delta < -MPEG_WRAP / 2) delta += MPEG_WRAP;
    return delta / MPEG_HZ - local;
}

/** A segment's `X-TIMESTAMP-MAP`, from its header; both 0 where it has none. */
function timestampMap(vtt: string): { mpegts: number; local: number } {
    const header = vtt.replace(/\r\n?/g, '\n').split('\n\n', 1)[0] ?? '';
    const line = header.split('\n').find((l) => l.trim().startsWith('X-TIMESTAMP-MAP='));
    if (!line) return { mpegts: 0, local: 0 };
    const mpegts = Number(line.match(/MPEGTS:(\d+)/)?.[1] ?? 0);
    const localText = line.match(/LOCAL:([0-9:.]+)/)?.[1];
    const local = localText ? parseVttTimestamp(localText) : 0;
    return { mpegts: Number.isFinite(mpegts) ? mpegts : 0, local: Number.isFinite(local) ? local : 0 };
}
