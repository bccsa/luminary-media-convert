import type { ProbeResult, EncodeConfig } from './types';

const STORAGE_KEY = 'luminary_encode_configs';

function videoTrackSegment(track: { width: number; height: number; codec: string }): string {
    return `${track.width}x${track.height}:${track.codec}`;
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
