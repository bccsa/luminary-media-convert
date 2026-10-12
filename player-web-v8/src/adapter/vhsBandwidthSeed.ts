/**
 * Starting VHS's bandwidth estimate from the host's measurement.
 *
 * VHS picks its first rendition from `handler.bandwidth`, which it fills from
 * its own history (`useBandwidthFromLocalStorage`) or, with none, a 4 Mbps
 * default. A host that has already measured the connection can do better than
 * the default on a first visit, and the first segment is the one that costs.
 *
 * A hint, so VHS's own record wins: it is a measurement of this device
 * fetching this kind of segment, which a host's probe is not. Only a first
 * visit, or a cleared store, takes the host's number.
 */

import type { VhsHandler } from '../types/videojs-vhs';

/** Where VHS keeps what it measured (`useBandwidthFromLocalStorage`). */
const VHS_STORAGE_KEY = 'videojs-vhs';

function hasStoredBandwidth(
    storage: Pick<Storage, 'getItem'> | undefined
): boolean {
    try {
        const stored = JSON.parse(
            storage?.getItem(VHS_STORAGE_KEY) ?? 'null'
        ) as {
            bandwidth?: unknown;
        } | null;
        return typeof stored?.bandwidth === 'number' && stored.bandwidth > 0;
    } catch {
        return false;
    }
}

/**
 * Sets `handler.bandwidth` to `bitsPerSecond` unless VHS already has a
 * measurement of its own, or has no controller to hold one yet. Returns whether
 * it seeded.
 */
export function seedBandwidth(
    handler: VhsHandler,
    bitsPerSecond: number | undefined,
    storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage ===
    'undefined'
        ? undefined
        : localStorage
): boolean {
    if (
        !bitsPerSecond ||
        !(bitsPerSecond > 0) ||
        !Number.isFinite(bitsPerSecond)
    )
        return false;
    if (hasStoredBandwidth(storage)) return false;
    try {
        // VHS defines `bandwidth` on the handler once its controller exists; before
        // that there is nothing to set and writing a plain property would be ignored.
        if (!('bandwidth' in handler)) return false;
        handler.bandwidth = bitsPerSecond;
        return true;
    } catch {
        return false;
    }
}
