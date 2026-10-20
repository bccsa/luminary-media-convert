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
 * The last key imported, per WebCrypto implementation.
 *
 * A source decrypts every LMCENC playlist and sidecar it reads with one key —
 * and a live source re-reads its playlists every target duration — so
 * importing it again for each file is work thrown away. One entry, because one
 * key is in use at a time and a new source's key simply replaces it. The key is
 * imported non-extractable, so what is held here can decrypt and nothing else.
 * Keyed by implementation, so an injected fake never answers for the real one.
 */
const lastImported = new WeakMap<
    SubtleLike,
    { keyHex: string; key: Promise<CryptoKey> }
>();

function importDecryptKey(
    impl: SubtleLike,
    keyHex: string,
): Promise<CryptoKey> {
    const cached = lastImported.get(impl);
    if (cached?.keyHex === keyHex) return cached.key;

    const key = impl.importKey(
        'raw',
        keyBytes(keyHex),
        { name: 'AES-CBC' },
        false,
        ['decrypt'],
    );
    lastImported.set(impl, { keyHex, key });
    // A failed import is not remembered: the next file tries again.
    key.catch(() => {
        if (lastImported.get(impl)?.key === key) lastImported.delete(impl);
    });
    return key;
}

/**
 * Decrypt an LMCENC payload. Throws when `bytes` is not LMCENC, when the key is
 * malformed, or when decryption fails (wrong key / corrupt file) — callers turn
 * those into typed {@link PlayerError}s.
 *
 * The IV and ciphertext go to WebCrypto as the views they are. A `BufferSource`
 * is read over the view's own range, never its whole parent buffer, and
 * WebCrypto copies its input anyway — a copy made here would be a second one.
 */
export async function decryptLmcenc(
    bytes: Uint8Array,
    keyHex: string,
    subtle?: SubtleLike,
): Promise<Uint8Array> {
    const { iv, ciphertext } = splitEncryptedPayload(bytes);
    const impl = resolveSubtle(subtle);

    const key = await importDecryptKey(impl, keyHex);
    const plain = await impl.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
    return new Uint8Array(plain);
}
