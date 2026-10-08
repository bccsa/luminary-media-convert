import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hls } from '@videojs/hlsjs-video';
import { HlsJsVideoAdapter, UnsupportedBrowserError } from '../src/adapter/HlsJsVideoAdapter';
import type { LoaderCallbacks, LoaderContext } from '../src/adapter/hlsTypes';
import { adapterSource, fakeElement, fakeEngine, type FakeEngine } from './helpers';

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Uint8Array.from(KEY_HEX.match(/../g)!.map((b) => parseInt(b, 16)));

let el: ReturnType<typeof fakeElement>;
let adapter: HlsJsVideoAdapter;

/** The element's engine config for the source most recently set. */
const engineConfig = () => (el.source as { engine: { hlsJs: Record<string, unknown> } }).engine.hlsJs;

/** Runs a `luminary://key` request through whichever loader the current source configured. */
function requestKey(): { bytes: Uint8Array | null; failed: boolean } {
    const Loader = engineConfig().loader as new (config: unknown) => {
        load(context: LoaderContext, config: unknown, callbacks: LoaderCallbacks): void;
    };
    let bytes: Uint8Array | null = null;
    let failed = false;
    new Loader(Hls.DefaultConfig).load({ url: 'luminary://key' } as LoaderContext, {}, {
        onSuccess: (response: { data: ArrayBuffer }) => (bytes = new Uint8Array(response.data)),
        onError: () => (failed = true),
    } as unknown as LoaderCallbacks);
    return { bytes, failed };
}

function events(a: HlsJsVideoAdapter, ...names: Parameters<HlsJsVideoAdapter['on']>[0][]) {
    const seen: [string, unknown][] = [];
    for (const name of names) a.on(name, ((payload: unknown) => seen.push([name, payload])) as never);
    return seen;
}

beforeEach(() => {
    vi.spyOn(Hls, 'isSupported').mockReturnValue(true);
    el = fakeElement();
    adapter = new HlsJsVideoAdapter(el);
});

afterEach(() => {
    adapter.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('loadSource', () => {
    it('hands the element a typed source: a blob master has no .m3u8 to infer it from', async () => {
        await adapter.loadSource(adapterSource({ url: 'blob:abc' }));
        expect(el.source).toMatchObject({ src: 'blob:abc', type: 'application/vnd.apple.mpegurl' });
    });

    it('configures hls.js to match the Video.js 8 player rather than v10\'s defaults', async () => {
        await adapter.loadSource(adapterSource());
        expect(engineConfig()).toMatchObject({
            capLevelToPlayerSize: false,
            capLevelOnFPSDrop: false,
            startLevel: 0,
        });
    });

    it('waits for a cold byte-range chunk', async () => {
        await adapter.loadSource(adapterSource());
        const policy = (engineConfig().fragLoadPolicy as { default: { maxTimeToFirstByteMs: number } }).default;
        expect(policy.maxTimeToFirstByteMs).toBeGreaterThanOrEqual(60_000);
    });

    it('reuses one engine config across sources, so an angle switch keeps the engine', async () => {
        await adapter.loadSource(adapterSource({ url: 'blob:one' }));
        const first = engineConfig().loader;
        await adapter.loadSource(adapterSource({ url: 'blob:two' }));
        expect(engineConfig().loader).toBe(first);
        expect(engineConfig()).not.toHaveProperty('engineGeneration');
    });

    it('seeds hls.js with the host\'s bandwidth measurement on a first visit', async () => {
        await adapter.loadSource(adapterSource({ bandwidthEstimate: 3_000_000 }));
        expect(engineConfig().abrEwmaDefaultEstimate).toBe(3_000_000);
    });

    it('refuses munged content when the browser has no Media Source, and says why', async () => {
        vi.spyOn(Hls, 'isSupported').mockReturnValue(false);
        const seen = events(adapter, 'error');
        await expect(adapter.loadSource(adapterSource({ isBlob: true }))).rejects.toBeInstanceOf(UnsupportedBrowserError);
        expect(seen[0]![1]).toMatchObject({ category: 'other', fatal: true });
    });

    it('hands an untouched URL to the platform player when there is nothing to munge', async () => {
        vi.spyOn(Hls, 'isSupported').mockReturnValue(false);
        await adapter.loadSource(adapterSource({ url: 'https://cdn.example.com/master.m3u8', isBlob: false }));
        expect(el.src).toBe('https://cdn.example.com/master.m3u8');
        expect(el.source).toBeNull();
    });
});

describe('key delivery', () => {
    it('serves the session key from memory', async () => {
        await adapter.loadSource(adapterSource({ keyHex: KEY_HEX }));
        expect(requestKey().bytes).toEqual(KEY);
    });

    it('does not carry one source\'s key into the next', async () => {
        await adapter.loadSource(adapterSource({ keyHex: KEY_HEX }));
        await adapter.loadSource(adapterSource({ url: 'blob:clear' }));
        expect(requestKey().failed).toBe(true);
    });

    it('advertises memory delivery, so the wrapper never mints a key blob URL', () => {
        expect(adapter.capabilities).toMatchObject({ keyDelivery: 'memory', nativeHls: false, variantSwitching: true });
    });
});

describe('reattach', () => {
    it('rebuilds the engine for the same source', async () => {
        await adapter.loadSource(adapterSource({ url: 'blob:one' }));
        const before = engineConfig();
        await adapter.reattach();
        expect(el.source).toMatchObject({ src: 'blob:one' });
        expect(engineConfig()).not.toEqual(before);
        expect(engineConfig().engineGeneration).toBe(1);
    });

    it('keeps the key: the source has not changed', async () => {
        await adapter.loadSource(adapterSource({ keyHex: KEY_HEX }));
        await adapter.reattach();
        expect(requestKey().bytes).toEqual(KEY);
    });

    it('puts the playhead and the play state back', async () => {
        await adapter.loadSource(adapterSource());
        el.currentTime = 42;
        el.paused = false;
        await adapter.reattach();
        expect(el.play).toHaveBeenCalled();
        // Nothing to seek in yet: the position waits for metadata.
        expect(el.currentTime).toBe(42);
        el.currentTime = 0;
        el.readyState = 1;
        el.dispatchEvent(new Event('loadedmetadata'));
        expect(el.currentTime).toBe(42);
    });

    it('stays paused when it was paused', async () => {
        await adapter.loadSource(adapterSource());
        await adapter.reattach();
        expect(el.play).not.toHaveBeenCalled();
    });

    it('does nothing before a source has been loaded', async () => {
        await adapter.reattach();
        expect(el.source).toBeNull();
    });

    it('survives a refused resume', async () => {
        await adapter.loadSource(adapterSource());
        el.paused = false;
        el.play.mockRejectedValueOnce(new Error('NotAllowedError'));
        await expect(adapter.reattach()).resolves.toBeUndefined();
    });
});

describe('seek', () => {
    it('waits for metadata when nothing is loaded, then lands where it was asked', () => {
        el.readyState = 0;
        adapter.seek(30);
        expect(el.currentTime).toBe(0);
        el.readyState = 1;
        el.dispatchEvent(new Event('loadedmetadata'));
        expect(el.currentTime).toBe(30);
    });

    it('is immediate once there is something to seek in', () => {
        el.readyState = 4;
        adapter.seek(12);
        expect(el.currentTime).toBe(12);
    });

    it('lets the latest request win', () => {
        el.readyState = 0;
        adapter.seek(10);
        adapter.seek(20);
        el.readyState = 1;
        el.dispatchEvent(new Event('loadedmetadata'));
        expect(el.currentTime).toBe(20);
    });

    it('reports a position and duration the wrapper can use before metadata', () => {
        el.currentTime = NaN;
        el.duration = NaN;
        expect(adapter.getCurrentTime()).toBe(0);
        expect(adapter.getDuration()).toBe(0);
        el.duration = Infinity;
        expect(adapter.getDuration()).toBe(0);
    });
});

describe('variants', () => {
    beforeEach(() => {
        el.videoRenditions.set([
            { id: '0', height: 180, bitrate: 250_000 },
            { id: '1', height: 360, bitrate: 800_000 },
            { id: '2', bitrate: 64_000 },
        ]);
    });

    it('names a variant by height, or by bitrate when there is none', () => {
        expect(adapter.getVariants()).toEqual([
            { id: '180', height: 180, bandwidth: 250_000 },
            { id: '360', height: 360, bandwidth: 800_000 },
            { id: 'b64000', height: undefined, bandwidth: 64_000 },
        ]);
    });

    it('pins a variant by its level index', () => {
        adapter.setVariant('360');
        expect(el.engine!.nextLevel).toBe(1);
    });

    it('returns to automatic selection', () => {
        adapter.setVariant('360');
        adapter.setVariant('auto');
        expect(el.engine!.nextLevel).toBe(-1);
    });

    it('treats an id that no longer exists as auto rather than pinning nothing', () => {
        adapter.setVariant('360');
        adapter.setVariant('1080');
        expect(el.engine!.nextLevel).toBe(-1);
    });

    it('says when the ladder changes', () => {
        const seen = events(adapter, 'variants-updated');
        el.videoRenditions.dispatchEvent(new Event('addrendition'));
        el.videoRenditions.dispatchEvent(new Event('change'));
        expect(seen).toHaveLength(2);
    });

    it('offers nothing when there is no engine yet', () => {
        el.engine = null;
        expect(() => adapter.setVariant('360')).not.toThrow();
    });
});

describe('audio tracks', () => {
    const tracks = () => [
        { id: '0', label: 'English', language: 'en', enabled: true },
        { id: '1', label: 'Afrikaans', language: 'af', enabled: false },
    ];

    beforeEach(() => el.audioTracks.set(tracks()));

    it('lists the element\'s tracks', () => {
        expect(adapter.getAudioTracks()).toEqual([
            { id: '0', lang: 'en', label: 'English' },
            { id: '1', lang: 'af', label: 'Afrikaans' },
        ]);
    });

    it('selects by enabling the track, which the element writes through to hls.js', () => {
        adapter.setAudioTrack('1');
        expect(el.audioTracks.items[1]!.enabled).toBe(true);
    });

    it('reads as empty and refuses selections while the tracks belong to the source being replaced', async () => {
        const seen = events(adapter, 'audiotracks-updated');
        await adapter.loadSource(adapterSource());
        expect(seen).toHaveLength(1);
        expect(adapter.getAudioTracks()).toEqual([]);
        adapter.setAudioTrack('1');
        expect(el.audioTracks.items[1]!.enabled).toBe(false);
    });

    it('serves the new source\'s tracks once the old list has been torn down', async () => {
        await adapter.loadSource(adapterSource());
        el.audioTracks.set([], 'removetrack');
        el.audioTracks.set(tracks(), 'addtrack');
        expect(adapter.getAudioTracks()).toHaveLength(2);
        adapter.setAudioTrack('1');
        expect(el.audioTracks.items[1]!.enabled).toBe(true);
    });

    it('does not retire an empty list: there is nothing outgoing', async () => {
        el.audioTracks.set([]);
        const seen = events(adapter, 'audiotracks-updated');
        await adapter.loadSource(adapterSource());
        expect(seen).toHaveLength(0);
    });

    it('falls back to an index id when a track has none', () => {
        el.audioTracks.set([{ id: '', label: '', language: '', enabled: true }]);
        expect(adapter.getAudioTracks()).toEqual([{ id: 'a0', lang: undefined, label: 'a0' }]);
    });
});

describe('playback events', () => {
    it('reports the position and the buffer around it', () => {
        const seen = events(adapter, 'timeupdate', 'progress');
        el.currentTime = 7;
        el.buffered = { length: 2, start: (i) => [0, 20][i]!, end: (i) => [10, 30][i]! };
        el.dispatchEvent(new Event('timeupdate'));
        expect(seen).toContainEqual(['timeupdate', { currentTime: 7 }]);
        // The range ahead at 20-30 cannot be played through from 7, so it is not reported.
        expect(seen).toContainEqual(['progress', { bufferedEnd: 10 }]);
    });

    it('reports nothing buffered when the playhead sits in a gap', () => {
        const seen = events(adapter, 'progress');
        el.currentTime = 15;
        el.buffered = { length: 2, start: (i) => [0, 20][i]!, end: (i) => [10, 30][i]! };
        el.dispatchEvent(new Event('timeupdate'));
        expect(seen[0]![1]).toEqual({ bufferedEnd: 0 });
    });

    it('forgives the hair\'s breadth the playhead sits outside the range it is playing from', () => {
        const seen = events(adapter, 'progress');
        el.currentTime = 9.95;
        el.buffered = { length: 1, start: () => 10, end: () => 20 };
        el.dispatchEvent(new Event('progress'));
        expect(seen[0]![1]).toEqual({ bufferedEnd: 20 });
    });

    it('treats play and playing alike, since consumers take playing as idempotent', () => {
        const seen = events(adapter, 'playing');
        el.dispatchEvent(new Event('play'));
        el.dispatchEvent(new Event('playing'));
        expect(seen).toHaveLength(2);
    });

    it.each([
        ['pause', 'pause'],
        ['ended', 'ended'],
        ['waiting', 'waiting'],
        ['seeked', 'seeked'],
    ] as const)('forwards %s', (domEvent, adapterEvent) => {
        const seen = events(adapter, adapterEvent);
        el.dispatchEvent(new Event(domEvent));
        expect(seen).toHaveLength(1);
    });

    it('reports the duration when it changes', () => {
        const seen = events(adapter, 'durationchange');
        el.duration = 120;
        el.dispatchEvent(new Event('durationchange'));
        expect(seen[0]![1]).toEqual({ duration: 120 });
    });

    it('stops reporting once destroyed', () => {
        const seen = events(adapter, 'pause');
        adapter.destroy();
        el.dispatchEvent(new Event('pause'));
        expect(seen).toHaveLength(0);
    });
});

describe('recovery', () => {
    let engine: FakeEngine;

    beforeEach(async () => {
        vi.useFakeTimers();
        engine = fakeEngine();
        el.engine = engine;
        await adapter.loadSource(adapterSource());
        // The element announces each engine it builds; the adapter hangs its listeners off it.
        el.dispatchEvent(new Event('loadstart'));
    });

    const fatal = (type: string) => engine.emit(Hls.Events.ERROR, { fatal: true, type, details: 'x' });

    it('tries hls.js\'s own media repair first', () => {
        fatal(Hls.ErrorTypes.MEDIA_ERROR);
        expect(engine.recoverMediaError).toHaveBeenCalledOnce();
    });

    it('tries restarting the load first for a network failure', () => {
        fatal(Hls.ErrorTypes.NETWORK_ERROR);
        expect(engine.startLoad).toHaveBeenCalledOnce();
    });

    it('has nothing to try in place for other failures, and climbs straight to a re-attach', async () => {
        fatal(Hls.ErrorTypes.OTHER_ERROR);
        expect(engine.recoverMediaError).not.toHaveBeenCalled();
        expect(engine.startLoad).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_100);
        expect(engineConfig().engineGeneration).toBe(1);
    });

    it('re-attaches when the same failure comes straight back', async () => {
        fatal(Hls.ErrorTypes.MEDIA_ERROR);
        fatal(Hls.ErrorTypes.MEDIA_ERROR);
        expect(engine.recoverMediaError).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2_100);
        expect(engineConfig().engineGeneration).toBe(1);
    });

    it('asks for a re-munge once re-attaching has not held', async () => {
        const seen = events(adapter, 'reload-requested');
        for (let i = 0; i < 6; i++) {
            fatal(Hls.ErrorTypes.OTHER_ERROR);
            await vi.advanceTimersByTimeAsync(9_000);
        }
        expect(seen.length).toBeGreaterThan(0);
    });

    it('ignores errors hls.js is still working through', () => {
        engine.emit(Hls.Events.ERROR, { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR, details: 'fragLoadError' });
        expect(engine.startLoad).not.toHaveBeenCalled();
    });

    it('stops listening to an engine the element has replaced', () => {
        const next = fakeEngine();
        el.engine = next;
        el.dispatchEvent(new Event('loadstart'));
        fatal(Hls.ErrorTypes.MEDIA_ERROR);
        expect(engine.recoverMediaError).not.toHaveBeenCalled();
        next.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'x' });
        expect(next.recoverMediaError).toHaveBeenCalledOnce();
    });

    it('declines in-place recovery when there is no engine', () => {
        el.engine = null;
        expect(adapter.recover('media')).toBe(false);
    });
});

describe('stalls', () => {
    it('reports one, and its end when the playhead moves', () => {
        const engine = fakeEngine();
        el.engine = engine;
        el.dispatchEvent(new Event('loadstart'));
        const seen = events(adapter, 'stalled');
        engine.emit(Hls.Events.ERROR, { fatal: false, type: 'mediaError', details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        el.currentTime = 3;
        el.dispatchEvent(new Event('timeupdate'));
        expect(seen.map(([, p]) => p)).toEqual([{ stalled: true }, { stalled: false }]);
    });
});

describe('visibility', () => {
    const setVisibility = (state: 'visible' | 'hidden') => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
    };

    afterEach(() => setVisibility('visible'));

    it('says again what is true now when the page comes back', () => {
        el.currentTime = 55;
        el.duration = 100;
        el.paused = false;
        const seen = events(adapter, 'timeupdate', 'durationchange', 'playing', 'progress');
        setVisibility('hidden');
        expect(seen).toHaveLength(0);
        setVisibility('visible');
        expect(seen.map(([name]) => name).sort()).toEqual(['durationchange', 'playing', 'progress', 'timeupdate']);
        expect(seen).toContainEqual(['timeupdate', { currentTime: 55 }]);
    });

    it('reports a paused player as paused', () => {
        el.paused = true;
        const seen = events(adapter, 'pause', 'playing');
        setVisibility('visible');
        expect(seen.map(([name]) => name)).toEqual(['pause']);
    });
});

describe('text tracks', () => {
    it('adds a subtitle track per sidecar, pointing at its blob', () => {
        const target = document.createElement('video');
        (el as unknown as { target: HTMLVideoElement }).target = target;
        adapter.setTextTracks([
            { id: 'en', lang: 'en', label: 'English', blobUrl: 'blob:en' },
            { id: 'af', lang: 'af', label: 'Afrikaans', blobUrl: 'blob:af' },
        ]);
        const els = target.querySelectorAll('track');
        expect(els).toHaveLength(2);
        expect(els[0]).toMatchObject({ kind: 'subtitles', label: 'English', srclang: 'en', id: 'en' });
        expect(els[0]!.getAttribute('src')).toBe('blob:en');
    });

    it('replaces the previous source\'s tracks', () => {
        const target = document.createElement('video');
        (el as unknown as { target: HTMLVideoElement }).target = target;
        adapter.setTextTracks([{ id: 'en', lang: 'en', label: 'English', blobUrl: 'blob:en' }]);
        adapter.setTextTracks([]);
        expect(target.querySelectorAll('track')).toHaveLength(0);
    });

    it('does nothing when the element has no media target yet', () => {
        expect(() => adapter.setTextTracks([{ id: 'en', label: 'English', blobUrl: 'blob:en' }])).not.toThrow();
    });
});

describe('transport', () => {
    it('plays, pauses and sets the rate on the element', async () => {
        await adapter.play();
        adapter.pause();
        adapter.setPlaybackRate(1.5);
        expect(el.play).toHaveBeenCalled();
        expect(el.pause).toHaveBeenCalled();
        expect(el.playbackRate).toBe(1.5);
    });
});
