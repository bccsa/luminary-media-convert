/**
 * LMCENC decryption (WebCrypto AES-128-CBC / PKCS#7).
 *
 * The format is specified in docs/encrypted-sidecar-format.md and its
 * constants/sniffers live in `@luminary-media-converter/hls-core` (`enc-format.ts`)
 * so the API encryptor (node crypto) and this decryptor cannot drift.
 */

import { splitEncryptedPayload } from '@luminary-media-converter/hls-core';

/** The `SubtleCrypto` surface this module needs; injectable for tests. */
export type SubtleLike = Pick<SubtleCrypto, 'importKey' | 'decrypt'>;

/** AES-128 key length in bytes. */
export const AES_KEY_BYTES = 16;

/** Parse a hex string (optionally `0x`-prefixed) into bytes. */
export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim().replace(/^0x/i, '');
    if (clean.length === 0 || clean.length % 2 !== 0) {
        throw new Error(`Invalid hex string of length ${clean.length}`);
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new Error('Invalid hex string: non-hex characters');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Render bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

/** The raw 16 key bytes for `keyHex`, validated. */
export function keyBytes(keyHex: string): Uint8Array {
    const bytes = hexToBytes(keyHex);
    if (bytes.length !== AES_KEY_BYTES) {
        throw new Error(
            `AES-128 key must be ${AES_KEY_BYTES} bytes, got ${bytes.length}`,
        );
    }
    return bytes;
}

function resolveSubtle(subtle?: SubtleLike): SubtleLike {
    const impl = subtle ?? globalThis.crypto?.subtle;
    if (!impl) {
        throw new Error('WebCrypto (crypto.subtle) is not available');
    }
    return impl;
}

/**
 * Decrypt an LMCENC payload. Throws when `bytes` is not LMCENC, when the key is
 * malformed, or when decryption fails (wrong key / corrupt file) — callers turn
 * those into typed {@link PlayerError}s.
 */
export async function decryptLmcenc(
    bytes: Uint8Array,
    keyHex: string,
    subtle?: SubtleLike,
): Promise<Uint8Array> {
    const { iv, ciphertext } = splitEncryptedPayload(bytes);
    const impl = resolveSubtle(subtle);

    const key = await impl.importKey(
        'raw',
        toArrayBuffer(keyBytes(keyHex)),
        { name: 'AES-CBC' },
        false,
        ['decrypt'],
    );
    const plain = await impl.decrypt(
        { name: 'AES-CBC', iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plain);
}

/**
 * Copy a (possibly offset) view into a standalone ArrayBuffer.
 * `subarray()` views share their parent buffer, which WebCrypto would read in
 * full.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(view.length);
    copy.set(view);
    return copy.buffer;
}
