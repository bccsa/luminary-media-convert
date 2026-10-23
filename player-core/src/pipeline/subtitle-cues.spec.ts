import { describe, expect, it } from 'vitest';
import {
    MULTI_ANGLE_MASTER,
    TEST_KEY_HEX,
    encryptLmcenc,
    makeFetch,
} from '../test-support/index.js';
import type { MasterInfo } from './pipeline.js';
import { cueShift, readSubtitleCues, timestampMap } from './subtitle-cues.js';

const BASE = 'https://cdn.example.com/out/session';
const TRACK = 'm:subs:English';

const master: MasterInfo = {
    url: `${BASE}/master.m3u8`,
    text: MULTI_ANGLE_MASTER,
    wasEncrypted: false,
    isMaster: true,
    angles: [],
    audioTracks: [],
    subtitleTracks: [],
    nativelyAudioOnly: false,
};

const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10.000000,',
    'en_0.vtt',
    '#EXTINF:10.000000,',
    'en_1.vtt',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

const FIRST = [
    'WEBVTT',
    '',
    '00:00:02.000 --> 00:00:06.000',
    '<v Choir>Out of the depths</v>',
    '',
    '00:00:08.000 --> 00:00:12.000',
    'of my heart, Lord,',
    '',
].join('\n');

// The cue that runs across the segment boundary is repeated, as a stream's segments carry it.
const SECOND = [
    'WEBVTT',
    '',
    '00:00:08.000 --> 00:00:12.000',
    'of my heart, Lord,',
    '',
    '00:00:13.000 --> 00:00:17.000',
    'I pray!',
    '',
].join('\n');

const LINES = [
    { start: 2, end: 6, text: 'Out of the depths' },
    { start: 8, end: 12, text: 'of my heart, Lord,' },
    { start: 13, end: 17, text: 'I pray!' },
];

describe('readSubtitleCues', () => {
    it('reads every segment of the track, in order, once each line', async () => {
        const { fetchImpl } = makeFetch({
            [`${BASE}/subs_en/playlist.m3u8`]: PLAYLIST,
            [`${BASE}/subs_en/en_0.vtt`]: FIRST,
            [`${BASE}/subs_en/en_1.vtt`]: SECOND,
        });
        expect(await readSubtitleCues(master, TRACK, { fetchImpl })).toEqual(LINES);
    });

    it('decrypts an encrypted playlist and segments with the session key', async () => {
        const { fetchImpl } = makeFetch({
            [`${BASE}/subs_en/playlist.m3u8`]: encryptLmcenc(PLAYLIST),
            [`${BASE}/subs_en/en_0.vtt`]: encryptLmcenc(FIRST),
            [`${BASE}/subs_en/en_1.vtt`]: encryptLmcenc(SECOND),
        });
        expect(await readSubtitleCues(master, TRACK, { fetchImpl, keyHex: TEST_KEY_HEX })).toEqual(LINES);
    });

    it('is empty for a track the master does not declare', async () => {
        const { fetchImpl, calls } = makeFetch({});
        expect(await readSubtitleCues(master, 'm:subs:French', { fetchImpl })).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('rejects when a segment cannot be read', async () => {
        const { fetchImpl } = makeFetch({
            [`${BASE}/subs_en/playlist.m3u8`]: PLAYLIST,
            [`${BASE}/subs_en/en_0.vtt`]: FIRST,
        });
        await expect(readSubtitleCues(master, TRACK, { fetchImpl })).rejects.toThrow();
    });
});

describe('cueShift', () => {
    const map = (text: string) => timestampMap(`WEBVTT\nX-TIMESTAMP-MAP=${text}\n\n00:00:01.000 --> 00:00:02.000\nWords\n`);

    it('reads a map against the first segment\'s, so the first stands as written', () => {
        expect(cueShift(map('MPEGTS:126000,LOCAL:00:00:00.000'), 126000)).toBe(0);
        // Ten seconds of MPEG-TS on from the first: ten seconds later.
        expect(cueShift(map('LOCAL:00:00:00.000,MPEGTS:1026000'), 126000)).toBeCloseTo(10);
        expect(cueShift(map('MPEGTS:126000,LOCAL:00:00:05.000'), 126000)).toBeCloseTo(-5);
    });

    it('leaves a segment without a map as written', () => {
        expect(timestampMap('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWords\n')).toBeNull();
        expect(cueShift(null, 126000)).toBe(0);
    });

    it('takes the short way round the 33-bit wrap', () => {
        const nearWrap = 2 ** 33 - 90_000; // one second before the clock wraps
        expect(cueShift(map('MPEGTS:90000,LOCAL:00:00:00.000'), nearWrap)).toBeCloseTo(2);
    });
});

describe('readSubtitleCues on the playlist\'s timeline', () => {
    const timed = (map: string, cues: [string, string, string][]) =>
        ['WEBVTT', ...(map ? [`X-TIMESTAMP-MAP=${map}`] : []), '', ...cues.flatMap(([from, to, text]) => [`${from} --> ${to}`, text, ''])].join('\n');

    it('places each segment by its map, from the playlists alone', async () => {
        const { fetchImpl, calls } = makeFetch({
            [`${BASE}/subs_en/playlist.m3u8`]: PLAYLIST,
            [`${BASE}/subs_en/en_0.vtt`]: timed('MPEGTS:900000,LOCAL:00:00:00.000', [['00:00:02.000', '00:00:06.000', 'Out of the depths']]),
            // Written from its own zero, its map ten seconds on from the first: at ten seconds and more.
            [`${BASE}/subs_en/en_1.vtt`]: timed('MPEGTS:1800000,LOCAL:00:00:00.000', [['00:00:03.000', '00:00:07.000', 'I pray!']]),
        });
        const lines = await readSubtitleCues(master, TRACK, { fetchImpl });
        expect(lines.map((line) => [line.start, line.text])).toEqual([
            [2, 'Out of the depths'],
            [13, 'I pray!'],
        ]);
        // Only the subtitle playlist and its segments are read, never the sound's.
        expect(calls.every((url) => url.includes('/subs_en/'))).toBe(true);
    });

    it('moves a segment written from its own start into its window in the playlist', async () => {
        const { fetchImpl } = makeFetch({
            [`${BASE}/subs_en/playlist.m3u8`]: PLAYLIST,
            [`${BASE}/subs_en/en_0.vtt`]: timed('', [['00:00:02.000', '00:00:06.000', 'Out of the depths']]),
            [`${BASE}/subs_en/en_1.vtt`]: timed('', [['00:00:01.000', '00:00:04.000', 'I pray!']]),
        });
        const lines = await readSubtitleCues(master, TRACK, { fetchImpl });
        expect(lines.map((line) => [line.start, line.text])).toEqual([
            [2, 'Out of the depths'],
            [11, 'I pray!'],
        ]);
    });
});
