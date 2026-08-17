import { createHash } from 'crypto';

/**
 * Obscurity, not security — and deliberately documented as such.
 *
 * The session key is masked with a value anyone holding the session id can
 * compute, so unmasking it is a documented operation, not a secret. What the
 * mask buys is that the raw key stops appearing in status responses, SSE
 * frames, proxy logs and screenshots of any of them: the bar moves from "copy
 * the hex out of a JSON response" to "read the client and reimplement it".
 *
 * Anyone who can play the media can recover the key regardless — the browser
 * needs it in the clear to decrypt segments. Real protection would be an
 * EME/DRM path, not this.
 *
 *   mask = SHA-256(sessionId)[0..15]
 *   masked = key XOR mask
 *
 * XOR is its own inverse, so this single function both masks and unmasks.
 */
export function maskKeyHex(sessionId: string, keyHex: string): string {
    const key = Buffer.from(keyHex, 'hex');
    const mask = createHash('sha256')
        .update(sessionId, 'utf-8')
        .digest()
        .subarray(0, 16);
    const out = Buffer.alloc(key.length);
    for (let i = 0; i < key.length; i++) {
        out[i] = key[i] ^ mask[i % mask.length];
    }
    return out.toString('hex');
}
