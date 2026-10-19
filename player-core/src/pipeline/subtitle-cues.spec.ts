import { describe, expect, it } from 'vitest';
import {
    MULTI_ANGLE_MASTER,
    TEST_KEY_HEX,
    encryptLmcenc,
    makeFetch,
} from '../test-support/index.js';
import type { MasterInfo } from './pipeline.js';
import { readSubtitleCues } from './subtitle-cues.js';

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
