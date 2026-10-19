import { cuesToLyrics, type LyricCue } from '../lyrics.js';
import { parseVttCues } from '../vtt.js';
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

/**
 * Every line of a subtitle track the master declares, read in full: its media playlist, then each segment,
 * decrypted where it is LMCENC. An engine that draws subtitles itself hands none of their words back, so a
 * host that shows them elsewhere (as lyrics) reads them here. Cue times are taken as the stream's own: the
 * segments are expected to start their clock where the media does.
 *
 * Empty when the master declares no such track; rejects when the playlist or a segment cannot be read.
 */
export async function readSubtitleCues(
    info: MasterInfo,
    trackId: string,
    ctx: SubtitleReadContext,
): Promise<LyricCue[]> {
    const entry = parseMasterText(info.text).media.find(
        (media) =>
            media.type === 'SUBTITLES' &&
            media.uri &&
            masterTrackId('m', media.groupId, media.name, media.language) === trackId,
    );
    if (!entry?.uri) return [];

    const options = { fetchImpl: ctx.fetchImpl, keyHex: ctx.keyHex, subtle: ctx.subtle, signal: ctx.signal };
    const playlistUrl = absolutizeAgainst(info.url)(entry.uri);
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

    return cuesToLyrics(
        texts.flatMap((text) =>
            parseVttCues(text).map((cue) => ({ startTime: cue.startTime, endTime: cue.endTime, text: cue.title })),
        ),
    );
}
