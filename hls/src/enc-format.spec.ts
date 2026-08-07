import { describe, it, expect } from 'vitest';
import {
    isEncryptedPayload,
    isPlaylistText,
    isVttText,
    splitEncryptedPayload,
    LMCENC_CIPHERTEXT_OFFSET,
    LMCENC_IV_LENGTH,
    LMCENC_MAGIC,
} from './enc-format';

const encoder = new TextEncoder();

function lmcenc(ciphertextLength: number): Uint8Array {
    const bytes = new Uint8Array(LMCENC_CIPHERTEXT_OFFSET + ciphertextLength);
    bytes.set(encoder.encode(LMCENC_MAGIC), 0);
    for (let i = 0; i < LMCENC_IV_LENGTH; i++) bytes[8 + i] = i;
    for (let i = 0; i < ciphertextLength; i++) {
        bytes[LMCENC_CIPHERTEXT_OFFSET + i] = 0xa0 + i;
    }
    return bytes;
}

function withBom(text: string): Uint8Array {
    const body = encoder.encode(text);
    const out = new Uint8Array(3 + body.length);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(body, 3);
    return out;
}

describe('isEncryptedPayload', () => {
    it('recognises the magic prefix', () => {
        expect(isEncryptedPayload(lmcenc(16))).toBe(true);
    });

    it('rejects a plaintext playlist', () => {
        expect(isEncryptedPayload(encoder.encode('#EXTM3U\n'))).toBe(false);
    });

    it('rejects a payload too short to hold a magic and an IV', () => {
        expect(isEncryptedPayload(lmcenc(16).subarray(0, 23))).toBe(false);
        expect(isEncryptedPayload(new Uint8Array(0))).toBe(false);
    });

    it('accepts a header with no ciphertext yet — length, not content, is the guard', () => {
        expect(isEncryptedPayload(lmcenc(0))).toBe(true);
    });

    it('rejects a near-miss magic', () => {
        const bytes = lmcenc(16);
        bytes[7] = '2'.charCodeAt(0); // LMCENC02
        expect(isEncryptedPayload(bytes)).toBe(false);
    });
});

describe('splitEncryptedPayload', () => {
    it('returns the IV and ciphertext at the documented offsets', () => {
        const bytes = lmcenc(32);
        const { iv, ciphertext } = splitEncryptedPayload(bytes);

        expect(iv).toHaveLength(16);
        expect([...iv]).toEqual([...Array(16).keys()]);
        expect(ciphertext).toHaveLength(32);
        expect(ciphertext[0]).toBe(0xa0);
    });

    it('returns views over the original buffer, not copies', () => {
        const bytes = lmcenc(16);
        const { ciphertext } = splitEncryptedPayload(bytes);

        bytes[LMCENC_CIPHERTEXT_OFFSET] = 0x11;
        expect(ciphertext[0]).toBe(0x11);
    });

    it('throws for anything that is not an LMCENC payload', () => {
        expect(() => splitEncryptedPayload(encoder.encode('#EXTM3U'))).toThrow(
            /Not an LMCENC payload/
        );
    });
});

describe('plaintext sniffing', () => {
    it('recognises a playlist', () => {
        expect(isPlaylistText(encoder.encode('#EXTM3U\n#EXT-X-VERSION:7'))).toBe(true);
        expect(isVttText(encoder.encode('#EXTM3U'))).toBe(false);
    });

    it('recognises WebVTT', () => {
        expect(isVttText(encoder.encode('WEBVTT\n\n00:00.000 --> 00:01.000'))).toBe(true);
        expect(isPlaylistText(encoder.encode('WEBVTT'))).toBe(false);
    });

    it('tolerates a UTF-8 BOM ahead of either magic', () => {
        expect(isPlaylistText(withBom('#EXTM3U\n'))).toBe(true);
        expect(isVttText(withBom('WEBVTT\n'))).toBe(true);
    });

    it('rejects a payload shorter than the magic it is looking for', () => {
        expect(isPlaylistText(encoder.encode('#EXT'))).toBe(false);
        expect(isVttText(withBom('WEB'))).toBe(false);
    });

    it('does not mistake an encrypted payload for text', () => {
        const bytes = lmcenc(16);
        expect(isPlaylistText(bytes)).toBe(false);
        expect(isVttText(bytes)).toBe(false);
    });
});
