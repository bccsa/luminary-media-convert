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

export function getStoredConfig(layoutKey: string): EncodeConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const store = JSON.parse(raw) as Record<string, EncodeConfig>;
        return store[layoutKey] ?? null;
    } catch {
        return null;
    }
}

export function saveConfig(layoutKey: string, config: EncodeConfig): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const store: Record<string, EncodeConfig> = raw ? JSON.parse(raw) : {};
        store[layoutKey] = config;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // ignore storage errors
    }
}
