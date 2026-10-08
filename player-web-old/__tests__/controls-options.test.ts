import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLS, mergeControls } from '../src/controls';

describe('mergeControls', () => {
    it('defaults to what the library did before the option existed', () => {
        expect(mergeControls()).toEqual({
            audioMenu: true,
            skipBackSeconds: 15,
            skipForwardSeconds: 15,
        });
    });

    it('keeps every default a sparse override does not mention', () => {
        // The point of merging: adding an option here later must not change
        // what an existing caller already gets.
        expect(mergeControls({ audioMenu: false })).toEqual({
            ...DEFAULT_CONTROLS,
            audioMenu: false,
        });
    });

    it('accepts zero, which is how a button is removed', () => {
        expect(mergeControls({ skipBackSeconds: 0 }).skipBackSeconds).toBe(0);
    });

    it('ignores intervals that would strand or reverse the seek', () => {
        // NaN would propagate into seek() and leave the video nowhere; a
        // negative forward interval is not a configuration anyone means.
        expect(mergeControls({ skipForwardSeconds: Number.NaN }).skipForwardSeconds).toBe(15);
        expect(mergeControls({ skipBackSeconds: -30 }).skipBackSeconds).toBe(15);
        expect(mergeControls({ skipForwardSeconds: Infinity }).skipForwardSeconds).toBe(15);
    });

    it('does not mutate the shared defaults', () => {
        mergeControls({ audioMenu: false, skipBackSeconds: 99 });
        expect(DEFAULT_CONTROLS).toEqual({
            audioMenu: true,
            skipBackSeconds: 15,
            skipForwardSeconds: 15,
        });
    });
});
