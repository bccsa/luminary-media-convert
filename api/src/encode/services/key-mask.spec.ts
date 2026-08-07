import { createHash } from 'crypto';
import { maskKeyHex } from './key-mask.js';

describe('maskKeyHex', () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const keyHex = '000102030405060708090a0b0c0d0e0f';

    it('round-trips: masking the masked key returns the original', () => {
        // XOR is its own inverse, which is what lets the client unmask with
        // the same one-liner the API used.
        const masked = maskKeyHex(sessionId, keyHex);

        expect(maskKeyHex(sessionId, masked)).toBe(keyHex);
    });

    it('does not hand back the key it was given', () => {
        expect(maskKeyHex(sessionId, keyHex)).not.toBe(keyHex);
    });

    it('uses the first 16 bytes of SHA-256(sessionId) as the mask', () => {
        // The formula is published — this pins it so a change to the client
        // is never needed silently.
        const mask = createHash('sha256')
            .update(sessionId, 'utf-8')
            .digest()
            .subarray(0, 16);
        const key = Buffer.from(keyHex, 'hex');
        const expected = Buffer.from(key.map((b, i) => b ^ mask[i]));

        expect(maskKeyHex(sessionId, keyHex)).toBe(expected.toString('hex'));
    });

    it('produces a different masking per session', () => {
        expect(maskKeyHex('session-a', keyHex)).not.toBe(
            maskKeyHex('session-b', keyHex)
        );
    });

    it('returns a 32-character hex string', () => {
        expect(maskKeyHex(sessionId, keyHex)).toMatch(/^[0-9a-f]{32}$/);
    });
});
