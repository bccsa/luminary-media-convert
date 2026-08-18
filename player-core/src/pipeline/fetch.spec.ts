import { describe, expect, it } from 'vitest';
import { isEncryptedPayload } from '@luminary-media-converter/hls-core';
import { PipelineError, fetchMaybeEncrypted, isMissing } from './fetch.js';
import { bytesToHex, decryptLmcenc, hexToBytes } from './decrypt.js';
import {
    CHAPTERS_VTT,
    PLAIN_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    encryptLmcenc,
    makeFetch,
} from '../test-support/index.js';

const URL_PLAYLIST = 'https://cdn.example.com/out/master.m3u8';
const URL_VTT = 'https://cdn.example.com/out/chapters/en.vtt';

describe('hexToBytes / bytesToHex', () => {
    it('round-trips the spec key vector', () => {
        const bytes = hexToBytes(TEST_KEY_HEX);
        expect([...bytes]).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        ]);
        expect(bytesToHex(bytes)).toBe(TEST_KEY_HEX);
    });

    it('rejects malformed hex', () => {
        expect(() => hexToBytes('abc')).toThrow();
        expect(() => hexToBytes('zzzz')).toThrow();
    });
});

describe('decryptLmcenc', () => {
    it('decrypts a vector produced by node crypto (the API encryptor path)', async () => {
        const payload = encryptLmcenc(PLAIN_MEDIA_PLAYLIST);
        expect(isEncryptedPayload(payload)).toBe(true);

        const plain = await decryptLmcenc(payload, TEST_KEY_HEX);
        expect(new TextDecoder().decode(plain)).toBe(PLAIN_MEDIA_PLAYLIST);
    });

    it('round-trips a fresh random IV', async () => {
        const iv = new Uint8Array(16);
        globalThis.crypto.getRandomValues(iv);
        const payload = encryptLmcenc(CHAPTERS_VTT, TEST_KEY_HEX, iv);
        const plain = await decryptLmcenc(payload, TEST_KEY_HEX);
        expect(new TextDecoder().decode(plain)).toBe(CHAPTERS_VTT);
    });

    it('rejects a key of the wrong length', async () => {
        const payload = encryptLmcenc(CHAPTERS_VTT);
        await expect(decryptLmcenc(payload, 'aabb')).rejects.toThrow();
    });
});

describe('fetchMaybeEncrypted', () => {
    it('passes plaintext through, BOM and all', async () => {
        const { fetchImpl } = makeFetch({
            [URL_PLAYLIST]: `﻿${PLAIN_MEDIA_PLAYLIST}`,
        });
        const asset = await fetchMaybeEncrypted(URL_PLAYLIST, {
            fetchImpl,
            expect: 'playlist',
        });
        expect(asset.wasEncrypted).toBe(false);
        expect(asset.text).toContain('#EXTM3U');
    });

    it('decrypts LMCENC payloads with the session key', async () => {
        const { fetchImpl } = makeFetch({
            [URL_PLAYLIST]: encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
        });
        const asset = await fetchMaybeEncrypted(URL_PLAYLIST, {
            fetchImpl,
            keyHex: TEST_KEY_HEX,
            expect: 'playlist',
        });
        expect(asset.wasEncrypted).toBe(true);
        expect(asset.text).toBe(PLAIN_MEDIA_PLAYLIST);
    });

    it('keeps working on plaintext even when a key IS configured', async () => {
        const { fetchImpl } = makeFetch({
            [URL_VTT]: CHAPTERS_VTT,
        });
        const asset = await fetchMaybeEncrypted(URL_VTT, {
            fetchImpl,
            keyHex: TEST_KEY_HEX,
            expect: 'vtt',
        });
        expect(asset.wasEncrypted).toBe(false);
        expect(asset.text).toBe(CHAPTERS_VTT);
    });

    it('fails with key-required when LMCENC arrives without a key', async () => {
        const { fetchImpl } = makeFetch({
            [URL_PLAYLIST]: encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
        });
        await expect(
            fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                expect: 'playlist',
            }),
        ).rejects.toMatchObject({ code: 'key-required', fatal: true });
    });

    it('fails with decrypt-failed on the wrong key', async () => {
        const { fetchImpl } = makeFetch({
            [URL_PLAYLIST]: encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
        });
        await expect(
            fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                keyHex: 'ffeeddccbbaa99887766554433221100',
                expect: 'playlist',
            }),
        ).rejects.toMatchObject({ code: 'decrypt-failed' });
    });

    it('fails with invalid-content on a CDN error body', async () => {
        const { fetchImpl } = makeFetch({
            [URL_PLAYLIST]: '<?xml version="1.0"?><Error>NoSuchKey</Error>',
        });
        await expect(
            fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                expect: 'playlist',
            }),
        ).rejects.toMatchObject({ code: 'invalid-content' });
    });

    it('marks 404 AND 403 as missing (S3 answers 403 without list permission)', async () => {
        for (const status of [404, 403]) {
            const { fetchImpl } = makeFetch({ [URL_PLAYLIST]: { status } });
            const error = await fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                expect: 'playlist',
            }).catch((e: unknown) => e);
            expect(isMissing(error)).toBe(true);
            expect((error as PipelineError).code).toBe('fetch-failed');
        }
    });

    it('does not mark other failures as missing', async () => {
        const { fetchImpl } = makeFetch({ [URL_PLAYLIST]: { status: 500 } });
        const error = await fetchMaybeEncrypted(URL_PLAYLIST, {
            fetchImpl,
            expect: 'playlist',
        }).catch((e: unknown) => e);
        expect(isMissing(error)).toBe(false);
    });

    it('reports transport failures as fetch-failed', async () => {
        const fetchImpl = (async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        await expect(
            fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                expect: 'playlist',
            }),
        ).rejects.toMatchObject({ code: 'fetch-failed' });
    });
});
