import { describe, expect, it, vi } from 'vitest';
import { Hls } from '@videojs/hlsjs-video';
import { BANDWIDTH_STORAGE_KEY, initialBandwidth, persistBandwidth } from '../src/adapter/hlsBandwidth';
import { fakeEngine } from './helpers';
import type { HlsEngine } from '../src/adapter/hlsTypes';

const storage = (value?: unknown) => ({
    getItem: () => (value === undefined ? null : JSON.stringify(value)),
});

describe('initialBandwidth', () => {
    it('prefers this device\'s own measurement over the host\'s', () => {
        expect(initialBandwidth(2_000_000, storage({ bandwidth: 9_000_000 }))).toBe(9_000_000);
    });

    it('takes the host\'s measurement on a first visit', () => {
        expect(initialBandwidth(2_000_000, storage())).toBe(2_000_000);
    });

    it.each([0, -1, NaN, Infinity, undefined])('ignores an unusable host estimate (%s)', (estimate) => {
        expect(initialBandwidth(estimate, storage())).toBeUndefined();
    });

    it('ignores a stored value that is not a usable number', () => {
        expect(initialBandwidth(3_000_000, storage({ bandwidth: 'fast' }))).toBe(3_000_000);
        expect(initialBandwidth(3_000_000, storage({ bandwidth: 0 }))).toBe(3_000_000);
    });

    it('survives storage that throws or holds garbage', () => {
        expect(initialBandwidth(3_000_000, { getItem: () => { throw new Error('blocked'); } })).toBe(3_000_000);
        expect(initialBandwidth(3_000_000, { getItem: () => '{not json' })).toBe(3_000_000);
    });
});

describe('persistBandwidth', () => {
    function setup(now: () => number) {
        const engine = fakeEngine();
        const setItem = vi.fn();
        const stop = persistBandwidth(engine as unknown as HlsEngine, { setItem }, now);
        return { engine, setItem, stop };
    }

    it('writes the running estimate when a fragment loads', () => {
        const { engine, setItem } = setup(() => 100_000);
        engine.bandwidthEstimate = 4_000_000;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        expect(setItem).toHaveBeenCalledWith(BANDWIDTH_STORAGE_KEY, JSON.stringify({ bandwidth: 4_000_000 }));
    });

    it('writes at most every few seconds, not on every fragment', () => {
        let t = 100_000;
        const { engine, setItem } = setup(() => t);
        engine.bandwidthEstimate = 4_000_000;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        t += 1_000;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        expect(setItem).toHaveBeenCalledTimes(1);
        t += 5_000;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        expect(setItem).toHaveBeenCalledTimes(2);
    });

    it('does not record an estimate hls.js has not formed yet', () => {
        const { engine, setItem } = setup(() => 100_000);
        engine.bandwidthEstimate = NaN;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        expect(setItem).not.toHaveBeenCalled();
    });

    it('stops when asked', () => {
        const { engine, setItem, stop } = setup(() => 100_000);
        stop();
        engine.bandwidthEstimate = 4_000_000;
        engine.emit(Hls.Events.FRAG_LOADED, {});
        expect(setItem).not.toHaveBeenCalled();
    });

    it('does not fail playback when storage refuses the write', () => {
        const engine = fakeEngine();
        persistBandwidth(engine as unknown as HlsEngine, { setItem: () => { throw new Error('quota'); } }, () => 100_000);
        engine.bandwidthEstimate = 4_000_000;
        expect(() => engine.emit(Hls.Events.FRAG_LOADED, {})).not.toThrow();
    });
});
