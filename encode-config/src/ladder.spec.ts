import { describe, expect, it } from 'vitest';
import { fpsAdjustedBitrateKbps } from './ladder';

describe('fpsAdjustedBitrateKbps', () => {
    it('leaves 30 fps and below on the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, 30)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 25)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 23.976)).toBe(5000);
    });

    it('raises the budget for 50 fps material', () => {
        // The case from #93: 1080p50 at the 30 fps budget pinned the encoder to
        // its cap for 73% of the programme.
        const adjusted = fpsAdjustedBitrateKbps(5000, 50);
        expect(adjusted).toBeGreaterThan(7000);
        expect(adjusted).toBeLessThan(7700);
    });

    it('raises 60 fps further, sublinearly', () => {
        const at60 = fpsAdjustedBitrateKbps(5000, 60);
        expect(at60).toBeGreaterThan(fpsAdjustedBitrateKbps(5000, 50));
        expect(at60).toBeLessThan(10000);
    });

    it('caps runaway frame rates at double the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, 1000)).toBe(10000);
    });

    it('treats a missing frame rate as the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, NaN)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 0)).toBe(5000);
    });
});
