import { describe, expect, it } from 'vitest';
import { displayDimensionsOf, isAnamorphic } from './aspect';

/**
 * The form's half of the square-pixel question, and a deliberate twin of
 * `api/src/encode/services/aspect.ts`. These cases mirror that file's spec on
 * purpose: the two implementations have to agree track for track, and the only
 * thing keeping them in step is that both are small and both are tested the
 * same way.
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

    it('falls back to the coded size on a probe with no display fields', () => {
        expect(displayDimensionsOf({ width: 1920, height: 1080 })).toEqual({
            width: 1920,
            height: 1080,
        });
    });

    it('falls back per axis, so a half-populated track cannot report zero', () => {
        // Each axis answers for itself. A single guard over both would let a
        // zero on one side drag the other down with it.
        expect(
            displayDimensionsOf({
                width: 720,
                height: 480,
                displayWidth: 0,
                displayHeight: 540,
            })
        ).toEqual({ width: 720, height: 540 });
        expect(
            displayDimensionsOf({
                width: 720,
                height: 480,
                displayWidth: 960,
                displayHeight: 0,
            })
        ).toEqual({ width: 960, height: 480 });
    });

    it('treats a negative display size as absent', () => {
        expect(
            displayDimensionsOf({
                width: 640,
                height: 360,
                displayWidth: -1,
                displayHeight: -1,
            })
        ).toEqual({ width: 640, height: 360 });
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
        // The fallback makes the two sizes equal by construction, so a source
        // whose shape was never measured is treated as square — which is what
        // every consumer did before this existed.
        expect(isAnamorphic({ width: 1920, height: 1080 })).toBe(false);
    });

    it('is false for a track with no dimensions to compare', () => {
        expect(isAnamorphic({ width: 0, height: 0 })).toBe(false);
        expect(isAnamorphic({ width: 1920, height: 0 })).toBe(false);
        expect(isAnamorphic({ width: 0, height: 1080 })).toBe(false);
        expect(isAnamorphic(undefined)).toBe(false);
    });
});
