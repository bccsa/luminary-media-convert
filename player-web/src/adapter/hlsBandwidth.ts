import { Hls } from '@videojs/hlsjs-video';
import type { HlsEngine } from './hlsTypes';

/** Where this player keeps what it measured; the VHS build used VHS's own `videojs-vhs` record. */
export const BANDWIDTH_STORAGE_KEY = 'luminary-player-bandwidth';

function storedBandwidth(storage: Pick<Storage, 'getItem'> | undefined): number | undefined {
    try {
        const stored = JSON.parse(storage?.getItem(BANDWIDTH_STORAGE_KEY) ?? 'null') as { bandwidth?: unknown } | null;
        return typeof stored?.bandwidth === 'number' && stored.bandwidth > 0 ? stored.bandwidth : undefined;
    } catch {
        return undefined;
    }
}

const defaultStorage = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/**
 * The bandwidth hls.js should start from: this device's own record when there is one, else the
 * host's measurement, else nothing (hls.js's default). A host's probe is a hint — a measurement
 * of this device fetching this kind of segment is better, as it was with VHS.
 */
export function initialBandwidth(
    hostEstimate: number | undefined,
    storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()
): number | undefined {
    const stored = storedBandwidth(storage);
    if (stored) return stored;
    return hostEstimate && hostEstimate > 0 && Number.isFinite(hostEstimate) ? hostEstimate : undefined;
}

/** Writes the engine's estimate at most this often. */
const PERSIST_INTERVAL_MS = 5_000;

/** Persists the engine's running estimate so the next visit starts from it. Returns the stop function. */
export function persistBandwidth(
    engine: HlsEngine,
    storage: Pick<Storage, 'setItem'> | undefined = defaultStorage(),
    now: () => number = () => Date.now()
): () => void {
    let last = 0;
    const onFragLoaded = (): void => {
        const t = now();
        if (t - last < PERSIST_INTERVAL_MS) return;
        const bandwidth = engine.bandwidthEstimate;
        if (!(bandwidth > 0) || !Number.isFinite(bandwidth)) return;
        last = t;
        try {
            storage?.setItem(BANDWIDTH_STORAGE_KEY, JSON.stringify({ bandwidth }));
        } catch {
            /* storage unavailable: the estimate is a hint, not state */
        }
    };
    engine.on(Hls.Events.FRAG_LOADED, onFragLoaded);
    return () => engine.off(Hls.Events.FRAG_LOADED, onFragLoaded);
}
