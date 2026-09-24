import { describe, expect, it } from 'vitest';
import { isEncryptedPayload } from '@luminary-media-converter/hls-core';
import { PipelineError, fetchMaybeEncrypted, isMissing } from './fetch.js';
import {
    bytesToHex,
    decryptLmcenc,
    hexToBytes,
    type SubtleLike,
} from './decrypt.js';
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

    it('reads only the view it is handed, not the buffer behind it', async () => {
        // WebCrypto reads a view's own range, which is what lets the IV and the
        // ciphertext go to it as the views they are, uncopied.
        const payload = encryptLmcenc(PLAIN_MEDIA_PLAYLIST);
        const buffer = new Uint8Array(payload.length + 64).fill(0x5a);
        buffer.set(payload, 32);

        const plain = await decryptLmcenc(
            buffer.subarray(32, 32 + payload.length),
            TEST_KEY_HEX,
        );
        expect(new TextDecoder().decode(plain)).toBe(PLAIN_MEDIA_PLAYLIST);
    });
});

describe('decryptLmcenc — importing the key', () => {
    const OTHER_KEY_HEX = 'ffeeddccbbaa99887766554433221100';

    /** The real WebCrypto, counting imports, and able to refuse the next one. */
    function countingSubtle() {
        const real = globalThis.crypto.subtle;
        const state = { imports: 0, refuseNext: false };
        const subtle = {
            importKey: (...args: unknown[]) => {
                state.imports += 1;
                if (state.refuseNext) {
                    state.refuseNext = false;
                    return Promise.reject(new Error('refused'));
                }
                return Reflect.apply(real.importKey, real, args);
            },
            decrypt: (...args: unknown[]) =>
                Reflect.apply(real.decrypt, real, args),
        } as unknown as SubtleLike;
        return { subtle, state };
    }

    async function decryptText(
        text: string,
        keyHex: string,
        subtle: SubtleLike,
    ): Promise<string> {
        const plain = await decryptLmcenc(
            encryptLmcenc(text, keyHex),
            keyHex,
            subtle,
        );
        return new TextDecoder().decode(plain);
    }

    it('imports a key once for a run of files, and again for a new key', async () => {
        // A source decrypts every playlist and sidecar with one key, and a live
        // one does it again every target duration.
        const { subtle, state } = countingSubtle();
        for (const text of [PLAIN_MEDIA_PLAYLIST, CHAPTERS_VTT]) {
            expect(await decryptText(text, TEST_KEY_HEX, subtle)).toBe(text);
        }
        expect(state.imports).toBe(1);

        expect(await decryptText(CHAPTERS_VTT, OTHER_KEY_HEX, subtle)).toBe(
            CHAPTERS_VTT,
        );
        expect(state.imports).toBe(2);
    });

    it('does not remember a key it failed to import', async () => {
        const { subtle, state } = countingSubtle();
        state.refuseNext = true;
        await expect(
            decryptText(CHAPTERS_VTT, TEST_KEY_HEX, subtle),
        ).rejects.toThrow('refused');

        expect(await decryptText(CHAPTERS_VTT, TEST_KEY_HEX, subtle)).toBe(
            CHAPTERS_VTT,
        );
        expect(state.imports).toBe(2);
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

    it('carries the status the server answered with', async () => {
        // A serving layer answering an engine's request on the network's behalf
        // hands this back, so the engine reacts to a 404 as it would to one it
        // had met itself.
        for (const status of [403, 404, 500, 503]) {
            const { fetchImpl } = makeFetch({ [URL_PLAYLIST]: { status } });
            const error = await fetchMaybeEncrypted(URL_PLAYLIST, {
                fetchImpl,
                expect: 'playlist',
            }).catch((e: unknown) => e);
            expect((error as PipelineError).status).toBe(status);
        }
    });

    it('has no status when there was no response at all', async () => {
        const fetchImpl = (async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        const error = await fetchMaybeEncrypted(URL_PLAYLIST, {
            fetchImpl,
            expect: 'playlist',
        }).catch((e: unknown) => e);
        expect((error as PipelineError).status).toBeUndefined();
    });
});
