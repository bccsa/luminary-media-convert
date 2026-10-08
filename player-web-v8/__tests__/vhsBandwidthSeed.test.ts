import { describe, expect, it } from 'vitest';
import { seedBandwidth } from '../src/adapter/vhsBandwidthSeed';

const storing = (value: string | null) => ({ getItem: () => value });
const handler = () => ({
    xhr: (() => undefined) as never,
    bandwidth: 4_194_304,
});

describe('seedBandwidth', () => {
    it("starts VHS from the host's number on a first visit", () => {
        const h = handler();
        expect(seedBandwidth(h, 1_500_000, storing(null))).toBe(true);
        expect(h.bandwidth).toBe(1_500_000);
    });

    it('leaves what VHS measured itself alone', () => {
        const h = handler();
        const stored = storing(
            JSON.stringify({ bandwidth: 9_000_000, throughput: 9_000_000 })
        );
        expect(seedBandwidth(h, 1_500_000, stored)).toBe(false);
        expect(h.bandwidth).toBe(4_194_304);
    });

    it('ignores a stored record without a usable bandwidth, and a store that cannot be read', () => {
        expect(
            seedBandwidth(handler(), 1_000_000, storing('{"bandwidth":0}'))
        ).toBe(true);
        expect(seedBandwidth(handler(), 1_000_000, storing('not json'))).toBe(
            true
        );
        expect(seedBandwidth(handler(), 1_000_000, undefined)).toBe(true);
    });

    it('takes no hint that is not a positive finite number', () => {
        for (const bad of [
            undefined,
            0,
            -5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
        ]) {
            const h = handler();
            expect(seedBandwidth(h, bad, storing(null))).toBe(false);
            expect(h.bandwidth).toBe(4_194_304);
        }
    });

    it('does nothing before VHS has a controller to hold the estimate', () => {
        const h = { xhr: (() => undefined) as never };
        expect(seedBandwidth(h, 1_000_000, storing(null))).toBe(false);
        expect('bandwidth' in h).toBe(false);
    });
});
