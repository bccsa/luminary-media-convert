import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEST_KEY_HEX, fragment, initSection, makeFetch } from '../test-support/index.js';
import { firstDecodeTime, readMediaStart } from './media-start.js';

function aes(bytes: Uint8Array, iv: Uint8Array): Uint8Array {
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(TEST_KEY_HEX, 'hex'), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([cipher.update(bytes), cipher.final()]));
}

const BASE = 'https://cdn.example.com/out/session/audio';

describe('firstDecodeTime', () => {
    it('reads the fragment against its own track\'s timescale', () => {
        const init = initSection([1, 90_000], [2, 48_000]);
        expect(firstDecodeTime(init, fragment(2, 67_200))).toBe(1.4);
        expect(firstDecodeTime(init, fragment(1, 900_000))).toBe(10);
    });

    it('is null for a fragment of a track the init does not have', () => {
        expect(firstDecodeTime(initSection([1, 48_000]), fragment(3, 100))).toBeNull();
    });
});

describe('readMediaStart', () => {
    it('reads the init section and first segment by their byte ranges', async () => {
        const init = initSection([1, 48_000]);
        const first = fragment(1, 67_200);
        const chunk = new Uint8Array([...init, ...first]);
        const playlist = [
            '#EXTM3U',
            `#EXT-X-MAP:URI="../media/a_0.m4s",BYTERANGE="${init.length}@0"`,
            '#EXTINF:4.000000,',
            `#EXT-X-BYTERANGE:${first.length}@${init.length}`,
            '../media/a_0.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        // The fake answers every range with the whole object, as a server that ignores ranges does.
        const { fetchImpl } = makeFetch({
            [`${BASE}/playlist.m3u8`]: playlist,
            'https://cdn.example.com/out/session/media/a_0.m4s': chunk,
        });
        expect(await readMediaStart(`${BASE}/playlist.m3u8`, { fetchImpl })).toBe(1.4);
    });

    it('decrypts what the AES-128 key covers, with its IV', async () => {
        const iv = new Uint8Array(16).fill(1);
        const playlist = [
            '#EXTM3U',
            '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x01010101010101010101010101010101',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:4.000000,',
            'seg_0.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        const { fetchImpl } = makeFetch({
            [`${BASE}/playlist.m3u8`]: playlist,
            [`${BASE}/init.mp4`]: aes(initSection([1, 48_000]), iv),
            [`${BASE}/seg_0.m4s`]: aes(fragment(1, 96_000), iv),
        });
        expect(await readMediaStart(`${BASE}/playlist.m3u8`, { fetchImpl, keyHex: TEST_KEY_HEX })).toBe(2);
        expect(await readMediaStart(`${BASE}/playlist.m3u8`, { fetchImpl })).toBeNull();
    });

    it('is null for a stream that is not fMP4, or that cannot be read', async () => {
        const ts = ['#EXTM3U', '#EXTINF:4.000000,', 'seg_0.ts', '#EXT-X-ENDLIST'].join('\n');
        const { fetchImpl } = makeFetch({ [`${BASE}/playlist.m3u8`]: ts });
        expect(await readMediaStart(`${BASE}/playlist.m3u8`, { fetchImpl })).toBeNull();
        expect(await readMediaStart(`${BASE}/missing.m3u8`, { fetchImpl })).toBeNull();
    });
});
