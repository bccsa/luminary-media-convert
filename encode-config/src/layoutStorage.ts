import { displayDimensionsOf } from './aspect';
import type { ProbeResult, EncodeConfig } from './types';

const STORAGE_KEY = 'luminary_encode_configs';

/**
 * One video track's contribution to the layout fingerprint.
 *
 * The display size is appended only when it differs from the coded size, so
 * every key ever written for a square-pixel source stays byte-identical and
 * nothing already saved is orphaned — which is all but broadcast SD. It has to
 * be there at all because a 4:3 PAL SD and a 16:9 PAL SD are both `720x576` and
 * shared one slot: the track names and languages saved against one came back on
 * the other.
 */
function videoTrackSegment(track: {
    width: number;
    height: number;
    codec: string;
    displayWidth?: number;
    displayHeight?: number;
}): string {
    const display = displayDimensionsOf(track);
    const shown =
        display.width !== track.width || display.height !== track.height
            ? `@${display.width}x${display.height}`
            : '';
    return `${track.width}x${track.height}${shown}:${track.codec}`;
}

function audioTrackSegment(track: { codec: string; channels: number; sampleRate: number }): string {
    return `${track.codec}:${track.channels}:${track.sampleRate}`;
}

export function computeLayoutKey(probeResult: ProbeResult, type: 'video' | 'audio'): string {
    const videoParts =
        type === 'video'
            ? probeResult.videoTracks.map(v => videoTrackSegment(v)).join(',')
            : '';
    const audioParts = probeResult.audioTracks.map(a => audioTrackSegment(a)).join(',');

    if (type === 'video') {
        return `video|v:${videoParts}|a:${audioParts}`;
    }
    return `audio|a:${audioParts}`;
}

/**
 * Everything saved so far, or an empty store when there is nothing usable.
 *
 * Reading is separated from writing deliberately. Both accessors used to parse
 * inside their own single `try`, which meant a corrupted entry threw *before*
 * the write and was swallowed along with it: the corruption then survived every
 * later save, silently, and the user never got a remembered ladder again. A
 * store that cannot be read is a store with nothing in it, and the next write
 * is entitled to replace it — whatever was in there is unrecoverable anyway.
 *
 * `typeof null === 'object'`, and an array indexes without complaint, so both
 * are rejected explicitly rather than left to produce a store whose entries
 * come back as undefined.
 */
function readStore(): Record<string, EncodeConfig> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed as Record<string, EncodeConfig>;
    } catch {
        // Unparseable, or storage itself refused to be read (a private window,
        // or a browser set to block site data).
        return {};
    }
}

export function getStoredConfig(layoutKey: string): EncodeConfig | null {
    return readStore()[layoutKey] ?? null;
}

export function saveConfig(layoutKey: string, config: EncodeConfig): void {
    const store = readStore();
    store[layoutKey] = config;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // A full quota or a browser that refuses to store anything. Losing the
        // suggestion is the whole cost; the form carries on regardless.
    }
}
