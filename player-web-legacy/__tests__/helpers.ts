import { vi } from 'vitest';

/**
 * A stand-in for a video.js player: the surface the adapter touches, and a way to
 * fire an event at it. Testing against a real player would test video.js, which
 * is not what the adapter is — it is a translation layer, and what is worth
 * pinning is the translation.
 */
export function fakePlayer(overrides: Record<string, unknown> = {}) {
    const handlers = new Map<string, ((e?: unknown) => void)[]>();
    // videojs-contrib-quality-levels: `enabled` is a getter/setter function on
    // each level, and the adapter identifies a level by height (or bitrate).
    const levels = Object.assign(
        [
            // `enabled` is assigned, not called: VHS pins a quality by leaving
            // exactly one level enabled.
            { height: 360, bitrate: 800_000, enabled: true },
            { height: 720, bitrate: 2_400_000, enabled: true },
        ],
        { length: 2, on: vi.fn(), off: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    );
    const audioTracks = Object.assign(
        [
            { id: 'en', language: 'en', label: 'English', enabled: true },
            { id: 'fr', language: 'fr', label: 'French', enabled: false },
        ],
        { length: 2, on: vi.fn(), off: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    );
    const textTracks = Object.assign([] as unknown[], {
        length: 0,
        on: vi.fn(),
        off: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });

    const player: Record<string, unknown> = {
        _levels: levels,
        _time: 0,
        _error: undefined as unknown,
        src: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
        currentTime: vi.fn((v?: number) =>
            v === undefined ? (player._time as number) : ((player._time = v) as unknown as void),
        ),
        duration: vi.fn(() => 120),
        playbackRate: vi.fn(),
        buffered: () => ({ length: 1, start: () => 0, end: () => 42 }),
        error: vi.fn(() => player._error),
        readyState: () => 4,
        textTracks: () => textTracks,
        audioTracks: () => audioTracks,
        addRemoteTextTrack: vi.fn(() => ({ track: { id: 'added' } })),
        removeRemoteTextTrack: vi.fn(),
        qualityLevels: vi.fn(() => levels),
        tech: vi.fn(() => ({ vhs: {} })),
        on: (name: string, fn: (e?: unknown) => void) =>
            handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        one: (name: string, fn: (e?: unknown) => void) =>
            handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        off: vi.fn(),
        fire: (name: string, payload?: unknown) =>
            (handlers.get(name) ?? []).forEach((f) => f(payload)),
        handlers,
        ...overrides,
    };
    return player as any;
}
