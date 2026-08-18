import { describe, expect, it, vi } from 'vitest';
import { createSegmentId } from '../types';

describe('createSegmentId', () => {
    it('uses crypto.randomUUID when available', () => {
        const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('deadbeef-1234-5678-9abc-def012345678');
        expect(createSegmentId()).toBe('deadbeef-1234-5678-9abc-def012345678');
        spy.mockRestore();
    });

    it('falls back to a prefixed random id when randomUUID is unavailable', () => {
        const original = crypto.randomUUID;
        // Simulate environments without randomUUID (e.g., older Safari).
        (crypto as unknown as { randomUUID?: unknown }).randomUUID = undefined;
        const id = createSegmentId();
        expect(id).toMatch(/^seg_[a-z0-9]+_[a-z0-9]+$/);
        (crypto as unknown as { randomUUID?: unknown }).randomUUID = original;
    });

    it('falls back when the crypto global itself is missing', () => {
        vi.stubGlobal('crypto', undefined);
        try {
            const id = createSegmentId();
            expect(id).toMatch(/^seg_/);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('produces distinct ids on successive calls', () => {
        const a = createSegmentId();
        const b = createSegmentId();
        expect(a).not.toBe(b);
    });
});
