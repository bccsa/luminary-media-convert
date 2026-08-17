import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
    LMCENC_MAGIC,
    LMCENC_IV_LENGTH,
    isEncryptedPayload,
    splitEncryptedPayload,
} from '@luminary-media-converter/hls';

/**
 * LMCENC01 — the on-disk / in-bucket wrapper for encrypted text assets.
 *
 * See docs/encrypted-sidecar-format.md for the normative spec:
 *
 *   bytes 0..7   ASCII "LMCENC01"
 *   bytes 8..23  16-byte random IV, fresh for every write
 *   bytes 24..   AES-128-CBC / PKCS#7 ciphertext of the UTF-8 plaintext
 *
 * Node-side implementation. The constants and the detection helpers live in
 * `@luminary-media-converter/hls` so the player (WebCrypto) and the encoder
 * (node crypto) cannot drift apart on the format.
 */

const MAGIC = Buffer.from(LMCENC_MAGIC, 'ascii');

/**
 * Wrap `plaintext` in an LMCENC01 payload under `key`.
 *
 * The IV is generated here, per call: two encryptions of the same playlist
 * produce different bytes, and re-encrypting after an edit never reuses the
 * IV of the version it replaces.
 */
export function encryptTextAsset(
    plaintext: string | Buffer,
    key: Buffer
): Buffer {
    assertKey(key);
    const iv = randomBytes(LMCENC_IV_LENGTH);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const body = Buffer.isBuffer(plaintext)
        ? plaintext
        : Buffer.from(plaintext, 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([MAGIC, iv, ciphertext]);
}

/** Unwrap an LMCENC01 payload under `key`, returning the UTF-8 plaintext. */
export function decryptTextAsset(payload: Buffer, key: Buffer): string {
    assertKey(key);
    const { iv, ciphertext } = splitEncryptedPayload(payload);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext)),
        decipher.final(),
    ]).toString('utf-8');
}

/**
 * Read a text asset that may or may not be encrypted.
 *
 * Follows the spec's detection order: magic → encrypted (a key is required and
 * its absence is an error, never a guess); anything else is handed back as
 * UTF-8. Plaintext keeps working even when a key is in hand, which is what lets
 * sessions encrypted after the fact — or not at all — share one code path.
 */
export function readMaybeEncrypted(payload: Buffer, key?: Buffer): string {
    if (!isEncryptedPayload(payload)) return payload.toString('utf-8');
    if (!key) {
        throw new Error(
            'This file is LMCENC-encrypted and no session key was supplied'
        );
    }
    return decryptTextAsset(payload, key);
}

/** True when these bytes carry the LMCENC magic. */
export function isLmcencPayload(payload: Buffer): boolean {
    return isEncryptedPayload(payload);
}

/** A 32-character hex string as the 16 key bytes it denotes. */
export function keyFromHex(keyHex: string): Buffer {
    if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) {
        throw new Error('keyHex must be 32 hex characters (an AES-128 key)');
    }
    return Buffer.from(keyHex, 'hex');
}

function assertKey(key: Buffer): void {
    if (key.length !== 16) {
        throw new Error(
            `LMCENC requires a 16-byte AES-128 key, got ${key.length}`
        );
    }
}
