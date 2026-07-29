import { resampleEnvelope } from './waveform.service.js';

describe('resampleEnvelope', () => {
    it('keeps the loudest value in each span', () => {
        // Averaging here would flatten the transients the outline exists to show.
        const envelope = [0.1, 0.9, 0.2, 0.1, 0.8, 0.1];

        expect(resampleEnvelope(envelope, 3)).toEqual([0.9, 0.2, 0.8]);
    });

    it('returns exactly the number of peaks asked for', () => {
        const envelope = Array.from({ length: 36_000 }, (_, i) => (i % 100) / 100);

        expect(resampleEnvelope(envelope, 1000)).toHaveLength(1000);
    });

    it('leaves a short envelope alone rather than inventing detail', () => {
        // Stretching 3 samples across 1000 peaks would draw structure that was
        // never in the audio.
        expect(resampleEnvelope([0.2, 0.4, 0.6], 1000)).toEqual([0.2, 0.4, 0.6]);
    });

    it('covers the whole envelope, including the tail', () => {
        // A span calculation that rounds the last bucket short drops the end of
        // the waveform, which reads as silence that is not there.
        const envelope = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

        expect(resampleEnvelope(envelope, 5).at(-1)).toBe(1);
    });

    it('never returns an empty span', () => {
        // More peaks than entries: every peak still has to come from somewhere.
        const peaks = resampleEnvelope([0.5, 0.7], 2);

        expect(peaks).toEqual([0.5, 0.7]);
    });

    it('has nothing to draw for silence-free edge cases', () => {
        expect(resampleEnvelope([], 1000)).toEqual([]);
        expect(resampleEnvelope([0.5], 0)).toEqual([]);
    });
});
