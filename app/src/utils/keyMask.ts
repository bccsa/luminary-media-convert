/**
 * Unmasking of the session's AES-128 key.
 *
 * The encoder no longer publishes the key on status reads or SSE frames; it is
 * served, masked, from `GET /api/sessions/:sessionId/key`:
 *
 *     mask = SHA-256(sessionId)[0..15]
 *     masked = key XOR mask
 *
 * XOR is its own inverse, so the same operation masks and unmasks. This is
 * obscurity, not security, and deliberately documented as such on the API side:
 * it keeps raw keys out of payloads that get logged, proxied and screenshotted.
 * Anyone able to play the media can still recover the key — the player needs it
 * in the clear to decrypt segments.
 *
 * Mirrors `api/src/encode/services/key-mask.ts`, in WebCrypto rather than node.
 */

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recover the plain key hex from the masked hex the encoder serves. */
export async function unmaskSessionKey(
    sessionId: string,
    maskedKeyHex: string
): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(sessionId)
    );
    const mask = new Uint8Array(digest).subarray(0, 16);
    const masked = hexToBytes(maskedKeyHex);
    const out = new Uint8Array(masked.length);
    for (let i = 0; i < masked.length; i++) {
        out[i] = masked[i] ^ mask[i % mask.length];
    }
    return bytesToHex(out);
}
