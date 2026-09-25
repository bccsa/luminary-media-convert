import { describe, it, expect } from 'vitest';
import { vhsHandler, vhsTech } from '../src/adapter/vhsXhrSeam';

describe('vhsTech', () => {
    it('reports no tech, not `false`, while video.js swaps one tech for the next', () => {
        // video.js reports `false` between unloading one tech and being handed
        // the next, which is when VHS announces its handler on the way back
        // from YouTube. `false?.on(...)` throws where `null?.on(...)` does not.
        const player = { tech: () => false } as any;

        expect(vhsTech(player)).toBeNull();
        expect(vhsHandler(player)).toBeNull();
    });
});
