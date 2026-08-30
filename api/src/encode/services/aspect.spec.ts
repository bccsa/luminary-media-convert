import { displayDimensionsOf, isAnamorphic } from './aspect.js';

/**
 * The two questions everything downstream asks about a track's shape. Both
 * answer from the probed fields alone, so a probe that predates them — a
 * session restored across an upgrade — falls back to the coded size rather
 * than to a third case every caller would have to handle.
 */
describe('displayDimensionsOf', () => {
    it('returns the display size when the track carries one', () => {
        expect(
            displayDimensionsOf({
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
            })
        ).toEqual({ width: 1024, height: 576 });
    });

    it('falls back to the coded size on a probe that has no display fields', () => {
        expect(displayDimensionsOf({ width: 1920, height: 1080 })).toEqual({
            width: 1920,
            height: 1080,
        });
    });

    it('falls back per axis, so a half-populated track cannot report zero', () => {
        expect(
            displayDimensionsOf({
                width: 720,
                height: 480,
                displayWidth: 0,
                displayHeight: 540,
            })
        ).toEqual({ width: 720, height: 540 });
    });

    it('answers zero for a track that is not there at all', () => {
        expect(displayDimensionsOf(undefined)).toEqual({
            width: 0,
            height: 0,
        });
    });
});

describe('isAnamorphic', () => {
    it('is true for PAL SD carrying 16:9', () => {
        expect(
            isAnamorphic({
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
            })
        ).toBe(true);
    });

    it('is true for NTSC DV, which corrects on the other axis', () => {
        expect(
            isAnamorphic({
                width: 720,
                height: 480,
                displayWidth: 720,
                displayHeight: 540,
            })
        ).toBe(true);
    });

    it('is false when the display size equals the coded size', () => {
        expect(
            isAnamorphic({
                width: 1920,
                height: 1080,
                displayWidth: 1920,
                displayHeight: 1080,
            })
        ).toBe(false);
    });

    it('is false for a probe from before the fields existed', () => {
        // The fallback makes the two sizes equal by construction. A source
        // whose shape was never measured is treated as square, which is what
        // every consumer did before this existed.
        expect(isAnamorphic({ width: 1920, height: 1080 })).toBe(false);
    });

    it('is false for a track with no dimensions to compare', () => {
        expect(isAnamorphic({ width: 0, height: 0 })).toBe(false);
        expect(isAnamorphic(undefined)).toBe(false);
    });
});
