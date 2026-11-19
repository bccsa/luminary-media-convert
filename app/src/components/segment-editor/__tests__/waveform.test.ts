import { describe, expect, it } from 'vitest';
import { MAX_WAVEFORM_GAIN, waveformGain } from '../waveform';

describe('waveformGain', () => {
    it('brings a quiet recording up so its loudest peak reaches the top', () => {
        // A recording that peaks at 12% of full scale.
        const peaks = [0.02, 0.12, 0.06];
        expect(Math.max(...peaks) * waveformGain(peaks)).toBeCloseTo(1);
    });

    it('leaves a recording that already reaches full scale as it is', () => {
        expect(waveformGain([0.3, 1, 0.5])).toBe(1);
    });

    it(`boosts background hiss no more than ${MAX_WAVEFORM_GAIN} times`, () => {
        const hiss = [0.002, 0.004, 0.003];
        expect(waveformGain(hiss)).toBe(MAX_WAVEFORM_GAIN);
        expect(0.004 * waveformGain(hiss)).toBeLessThan(0.1);
    });

    it('leaves a silent file flat', () => {
        expect(waveformGain([0, 0, 0])).toBe(1);
        expect(waveformGain([])).toBe(1);
        expect(waveformGain(null)).toBe(1);
    });
});
