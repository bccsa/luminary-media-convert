import { describe, it, expect } from 'vitest';
import { mergeControls, DEFAULT_CONTROLS } from '../src/controls';

describe('mergeControls', () => {
    it('is the library default when nothing is overridden', () => {
        expect(mergeControls()).toEqual(DEFAULT_CONTROLS);
        expect(mergeControls({})).toEqual(DEFAULT_CONTROLS);
    });

    it('takes a sparse override and inherits the rest', () => {
        // So adding an option later cannot change what an existing caller gets.
        expect(mergeControls({ windowedControls: false })).toEqual({
            ...DEFAULT_CONTROLS,
            windowedControls: false,
        });
    });

    it('ignores a value that is not a boolean', () => {
        expect(mergeControls({ audioMenu: 1 as unknown as boolean }).audioMenu).toBe(true);
    });
});
