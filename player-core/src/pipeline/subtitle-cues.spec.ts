import { describe, expect, it } from 'vitest';
import {
    MULTI_ANGLE_MASTER,
    TEST_KEY_HEX,
    encryptLmcenc,
    fragment,
    initSection,
    makeFetch,
} from '../test-support/index.js';
import type { MasterInfo } from './pipeline.js';
import { cueShift, readSubtitleCues } from './subtitle-cues.js';

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
    const mapped = (map: string) => `WEBVTT\nX-TIMESTAMP-MAP=${map}\n\n00:00:01.000 --> 00:00:02.000\nWords\n`;

    it('reads the map against where the media clock starts', () => {
        // The map marks the media's start: the cue times stand as they are.
        expect(cueShift(mapped('MPEGTS:126000,LOCAL:00:00:00.000'), 1.4)).toBeCloseTo(0);
        // The map is ten seconds ahead of the media.
        expect(cueShift(mapped('LOCAL:00:00:00.000,MPEGTS:1026000'), 1.4)).toBeCloseTo(10);
        expect(cueShift(mapped('MPEGTS:126000,LOCAL:00:00:05.000'), 1.4)).toBeCloseTo(-5);
    });

    it('takes a segment without a map as MPEG-TS 0 at local 0', () => {
        expect(cueShift('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWords\n', 1.4)).toBeCloseTo(-1.4);
        expect(cueShift('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWords\n', 0)).toBe(0);
    });

    it('takes the short way round the 33-bit wrap', () => {
        const nearWrap = 2 ** 33 - 90_000; // one second before the clock wraps
        expect(cueShift(mapped('MPEGTS:90000,LOCAL:00:00:00.000'), nearWrap / 90_000)).toBeCloseTo(2);
    });

    it('takes the map to mark the start when the start cannot be read', () => {
        expect(cueShift(mapped('MPEGTS:900000,LOCAL:00:00:03.000'), null)).toBe(-3);
    });
});

describe('readSubtitleCues on the player\'s timeline', () => {
    it('moves each segment by its map against the sound\'s first fragment', async () => {
        const audio = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4.000000,', 'a_0.m4s', '#EXT-X-ENDLIST'].join('\n');
        const { fetchImpl } = makeFetch({
            [`${BASE}/audio_128kbps/playlist.m3u8`]: audio,
            [`${BASE}/audio_128kbps/init.mp4`]: initSection([1, 48_000]),
            [`${BASE}/audio_128kbps/a_0.m4s`]: fragment(1, 48_000 * 10),
            [`${BASE}/subs_en/playlist.m3u8`]: PLAYLIST,
            // Mapped to the media's start: as written.
            [`${BASE}/subs_en/en_0.vtt`]: FIRST.replace('WEBVTT\n', 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n'),
            // No map: MPEG-TS 0, ten seconds before the media starts, so earlier on the timeline.
            [`${BASE}/subs_en/en_1.vtt`]: SECOND.replace('00:00:13.000 --> 00:00:17.000', '00:00:23.000 --> 00:00:27.000'),
        });
        const lines = await readSubtitleCues(master, TRACK, { fetchImpl });
        expect(lines.map((line) => [line.start, line.text])).toEqual([
            [0, 'of my heart, Lord,'],
            [2, 'Out of the depths'],
            [8, 'of my heart, Lord,'],
            [13, 'I pray!'],
        ]);
    });
});
