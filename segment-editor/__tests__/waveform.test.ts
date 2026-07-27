import { describe, expect, it } from 'vitest';
import { peakBarHeight } from '../src/waveform';

describe('peakBarHeight', () => {
    it('maps a full-scale peak to the full height', () => {
        expect(peakBarHeight(1, 48)).toBe(48);
    });

    it('lifts quiet peaks well above their linear height', () => {
        // 10% of full scale would draw 4.8px linearly; the curve gives ~15px.
        const h = peakBarHeight(0.1, 48);
        expect(h).toBeGreaterThan(14);
        expect(h).toBeLessThan(16);
    });

    it('keeps loud peaks inside the track', () => {
        expect(peakBarHeight(0.99, 48)).toBeLessThanOrEqual(48);
        expect(peakBarHeight(5, 48)).toBe(48);
    });

    it('stays monotonic', () => {
        const heights = [0, 0.1, 0.25, 0.5, 0.75, 1].map((p) => peakBarHeight(p, 48));
        for (let i = 1; i < heights.length; i++) {
            expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
        }
    });

    it('draws a baseline for silence rather than nothing', () => {
        expect(peakBarHeight(0, 48)).toBe(1);
    });

    it('handles nonsense input without producing NaN', () => {
        expect(peakBarHeight(Number.NaN, 48)).toBe(0);
        expect(peakBarHeight(-1, 48)).toBe(1);
        expect(peakBarHeight(0.5, 0)).toBe(0);
    });
});
