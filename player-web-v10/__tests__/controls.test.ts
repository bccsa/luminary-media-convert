import { describe, it, expect } from 'vitest';
import { mergeControls, DEFAULT_CONTROLS } from '../src/controls';

describe('mergeControls', () => {
    it('is the library default when nothing is overridden', () => {
        expect(mergeControls()).toEqual(DEFAULT_CONTROLS);
        expect(mergeControls({})).toEqual(DEFAULT_CONTROLS);
    });

    it('takes a sparse override and inherits the rest', () => {
        // So adding an option later cannot change what an existing caller gets.
        expect(mergeControls({ audioMenu: false })).toEqual({
            ...DEFAULT_CONTROLS,
            audioMenu: false,
        });
    });

    it('honours 0 as "no button"', () => {
        expect(mergeControls({ skipForwardSeconds: 0 }).skipForwardSeconds).toBe(0);
    });

    it('ignores an interval that cannot be seeked to', () => {
        // NaN would travel into seek() and strand the video; a negative forward
        // skip is not a configuration anyone means.
        expect(mergeControls({ skipForwardSeconds: NaN }).skipForwardSeconds).toBe(10);
        expect(mergeControls({ skipBackSeconds: -5 }).skipBackSeconds).toBe(10);
        expect(
            mergeControls({ skipForwardSeconds: '30' as unknown as number }).skipForwardSeconds,
        ).toBe(10);
        expect(mergeControls({ audioMenu: 1 as unknown as boolean }).audioMenu).toBe(true);
    });
});
