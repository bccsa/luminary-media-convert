/**
 * LMCENC — Luminary Media Convert encrypted text-asset format.
 *
 * Wraps whole playlist (.m3u8) and WebVTT (.vtt) files in AES-128-CBC when a
 * session opts into playlist encryption. See docs/encrypted-sidecar-format.md
 * for the normative spec.
 *
 *   bytes 0..7   ASCII "LMCENC01"  (magic + version)
 *   bytes 8..23  16-byte random IV (fresh per file)
 *   bytes 24..   AES-128-CBC / PKCS#7 ciphertext of the UTF-8 plaintext
 *
 * This module is isomorphic (pure Uint8Array, no crypto): the encryptor lives
 * in the API (node crypto), the decryptor in player-core (WebCrypto).
 */

/** ASCII magic + version prefix of every LMCENC file. */
export const LMCENC_MAGIC = 'LMCENC01';

/** Byte length of the magic prefix. */
export const LMCENC_MAGIC_LENGTH = 8;

/** Byte offset of the IV within an LMCENC file. */
export const LMCENC_IV_OFFSET = LMCENC_MAGIC_LENGTH;

/** Byte length of the IV. */
export const LMCENC_IV_LENGTH = 16;

/** Byte offset of the ciphertext within an LMCENC file. */
export const LMCENC_CIPHERTEXT_OFFSET = LMCENC_IV_OFFSET + LMCENC_IV_LENGTH;

const MAGIC_BYTES = new Uint8Array([...LMCENC_MAGIC].map((c) => c.charCodeAt(0)));

/** UTF-8 byte-order mark, tolerated ahead of plaintext magic strings. */
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

/** True when `bytes` starts with the LMCENC magic. */
export function isEncryptedPayload(bytes: Uint8Array): boolean {
    if (bytes.length < LMCENC_CIPHERTEXT_OFFSET) return false;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
        if (bytes[i] !== MAGIC_BYTES[i]) return false;
    }
    return true;
}

/** Split an LMCENC payload into IV and ciphertext (views, not copies). */
export function splitEncryptedPayload(bytes: Uint8Array): {
    iv: Uint8Array;
    ciphertext: Uint8Array;
} {
    if (!isEncryptedPayload(bytes)) {
        throw new Error('Not an LMCENC payload');
    }
    return {
        iv: bytes.subarray(LMCENC_IV_OFFSET, LMCENC_CIPHERTEXT_OFFSET),
        ciphertext: bytes.subarray(LMCENC_CIPHERTEXT_OFFSET),
    };
}

function startsWithAscii(bytes: Uint8Array, text: string): boolean {
    let offset = 0;
    if (
        bytes.length >= UTF8_BOM.length &&
        bytes[0] === UTF8_BOM[0] &&
        bytes[1] === UTF8_BOM[1] &&
        bytes[2] === UTF8_BOM[2]
    ) {
        offset = UTF8_BOM.length;
    }
    if (bytes.length - offset < text.length) return false;
    for (let i = 0; i < text.length; i++) {
        if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/** True when `bytes` is a plaintext HLS playlist (BOM-tolerant `#EXTM3U`). */
export function isPlaylistText(bytes: Uint8Array): boolean {
    return startsWithAscii(bytes, '#EXTM3U');
}

/** True when `bytes` is a plaintext WebVTT file (BOM-tolerant `WEBVTT`). */
export function isVttText(bytes: Uint8Array): boolean {
    return startsWithAscii(bytes, 'WEBVTT');
}
