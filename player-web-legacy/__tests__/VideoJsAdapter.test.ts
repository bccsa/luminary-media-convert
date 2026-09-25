import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_RECOVERY_POLICY,
    LUMINARY_KEY_PLACEHOLDER_URI,
} from '@luminary-media-converter/player-core';
import { VideoJsAdapter, type VideoJsAdapterOptions } from '../src/adapter/VideoJsAdapter';
import { fakePlayer } from './helpers';

/** Let promise callbacks run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('VideoJsAdapter — the contract player-core relies on', () => {
    it('serves keys from memory by default, and says so', () => {
        // The capability is load-bearing: the wrapper mints a key blob URL only
        // for adapters that decline the job, so claiming 'memory' without doing
        // it would leave AES requests unanswered.
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.capabilities.keyDelivery).toBe('memory');
        expect(a.capabilities.nativeHls).toBe(false);
        expect(a.capabilities.variantSwitching).toBe(true);
        expect(a.capabilities.renderText).toBe(true);
    });

    it('honours the documented fallback when the VHS seam is declined', () => {
        const a = new VideoJsAdapter(fakePlayer(), { keyDelivery: 'url' });
        expect(a.capabilities.keyDelivery).toBe('url');
    });

    it('reports the ladder as variants, identified by height', () => {
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.getVariants()).toEqual([
            { id: '360', height: 360, bandwidth: 800_000 },
            { id: '720', height: 720, bandwidth: 2_400_000 },
        ]);
    });

    it('pins one quality and lets `auto` restore the ladder', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setVariant('720');
        expect(p._levels.map((l: any) => l.enabled)).toEqual([false, true]);

        a.setVariant('auto');
        expect(p._levels.map((l: any) => l.enabled)).toEqual([true, true]);
    });

    it('treats an id that matches no level as auto, not as a pin nothing satisfies', () => {
        // An angle switch rebuilds the ladder under a pinned quality. Disabling
        // every level would leave VHS on whatever it holds with ABR unable to
        // move — a stall dressed as a choice.
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setVariant('1080');

        expect(p._levels.map((l: any) => l.enabled)).toEqual([true, true]);
    });

    it('lists audio tracks, falling back to an index when one has no id', () => {
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.getAudioTracks()).toEqual([
            { id: 'en', lang: 'en', label: 'English' },
            { id: 'fr', lang: 'fr', label: 'French' },
        ]);
    });

    it('enables only the chosen audio track, and never disables first', () => {
        // Writing false across the list before enabling the match leaves a frame
        // with no audio track at all, which VHS resolves by picking for itself.
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setAudioTrack('fr');

        const list = p.audioTracks();
        expect(list[1].enabled).toBe(true);
    });

    it('reports position and duration through the engine', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        p.currentTime(30);
        expect(a.getCurrentTime()).toBe(30);
        expect(a.getDuration()).toBe(120);
    });

    it('translates engine events into adapter events', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        a.on('playing', () => seen.push('playing'));
        a.on('pause', () => seen.push('pause'));
        a.on('waiting', () => seen.push('waiting'));
        a.on('ended', () => seen.push('ended'));

        p.fire('playing');
        p.fire('pause');
        p.fire('waiting');
        p.fire('ended');

        expect(seen).toEqual(['playing', 'pause', 'waiting', 'ended']);
    });

    it('reports the buffered front, which moves while paused', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: number[] = [];
        a.on('progress', (e) => seen.push(e.bufferedEnd));

        p.fire('progress');

        expect(seen).toEqual([42]);
    });

    it('unsubscribing stops delivery to that listener alone', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        const off = a.on('playing', () => seen.push('first'));
        a.on('playing', () => seen.push('second'));

        off();
        p.fire('playing');

        expect(seen).toEqual(['second']);
    });

    it('declines a recovery it cannot attempt, so the wrapper reloads instead', () => {
        // Returning true for a recovery that did nothing is worse than saying no:
        // the wrapper believes it and stops escalating.
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.recover('network')).toBe(false);
        expect(a.recover('media')).toBe(false);
        expect(a.recover('other')).toBe(false);
    });

    it('stops listening once destroyed', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        a.on('playing', () => seen.push('playing'));

        a.destroy();
        p.fire('playing');

        expect(seen).toEqual([]);
    });

    it('survives a second destroy', () => {
        const a = new VideoJsAdapter(fakePlayer());
        a.destroy();
        expect(() => a.destroy()).not.toThrow();
    });

    it('does not fall over on a player without quality levels or audio tracks', () => {
        // Not hypothetical: the YouTube tech has neither, and the adapter is
        // constructed before the source decides which tech runs.
        const bare = fakePlayer({ qualityLevels: undefined, audioTracks: undefined });
        const a = new VideoJsAdapter(bare);

        expect(a.getVariants()).toEqual([]);
        expect(a.getAudioTracks()).toEqual([]);
        expect(() => a.setVariant('720')).not.toThrow();
        expect(() => a.setAudioTrack('en')).not.toThrow();
    });
});

describe('VideoJsAdapter — recovery ladder', () => {
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY };
    // Each adapter listens on the shared `document`; one left behind would
    // answer the next test's visibility changes.
    const adapters: VideoJsAdapter[] = [];

    function setup() {
        vi.useFakeTimers();
        vi.stubGlobal('MediaSource', class {});
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        adapters.push(a);
        const errors: unknown[] = [];
        const reloads: number[] = [];
        a.on('error', (e) => errors.push(e));
        a.on('reload-requested', ({ attempt }) => reloads.push(attempt));
        return { p, a, errors, reloads };
    }

    function setVisibility(state: 'visible' | 'hidden') {
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('does not count the position restored after a re-munge as recovery', async () => {
        const { p, a, errors } = setup();
        // What the controller does on `reload-requested`: rebuild, then restore the position.
        a.on('reload-requested', () => {
            void a.loadSource(source).then(() => {
                p._time = 0;
                a.seek(120);
                p.fire('timeupdate');
            });
        });
        await a.loadSource(source);
        p._time = 120;
        p.fire('timeupdate');

        // The same failure every time playback gets back to 120 s.
        p._error = { code: 2 };
        for (let i = 0; i < 10 && errors.length === 0; i++) {
            p.fire('error');
            await vi.advanceTimersByTimeAsync(10_000);
        }

        expect(errors).toHaveLength(1);
    });

    it('does not rebuild a source it has given up on when the page becomes visible', async () => {
        const { p, a, errors, reloads } = setup();
        await a.loadSource(source);
        p._error = { code: 3 };
        for (let i = 0; i < 6 && errors.length === 0; i++) {
            p.fire('error');
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(errors).toHaveLength(1);
        const requested = reloads.length;

        setVisibility('hidden');
        setVisibility('visible');

        expect(reloads).toHaveLength(requested);
    });

    it('re-raises a re-munge only when the page was hidden while it was outstanding', async () => {
        const { p, a, reloads } = setup();
        await a.loadSource(source);
        p._error = { code: 3 };
        // In place (declined), re-attach, then the first re-munge request.
        p.fire('error');
        await vi.advanceTimersByTimeAsync(10_000);
        p.fire('error');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reloads).toEqual([2]);

        // Delivered while visible: returning to the page must not repeat it.
        setVisibility('visible');
        expect(reloads).toEqual([2]);

        // Hidden while still outstanding: it may not have been delivered.
        setVisibility('hidden');
        setVisibility('visible');
        expect(reloads).toEqual([2, 2]);
    });
});

describe('VideoJsAdapter — live playlists', () => {
    const KEY_HEX = '000102030405060708090a0b0c0d0e0f';
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY, keyHex: KEY_HEX };
    const adapters: VideoJsAdapter[] = [];

    /**
     * A player whose tech carries a VHS handler with a request factory, which
     * the adapter wraps once VHS announces it with `xhr-hooks-ready`.
     */
    function setup(liveSource?: { resolveLive: ReturnType<typeof vi.fn> }) {
        vi.stubGlobal('MediaSource', class {});
        const network = vi.fn(() => 'network');
        const tech = { vhs: { xhr: network } as Record<string, any> };
        const p = fakePlayer({ tech: vi.fn(() => tech) });
        const a = new VideoJsAdapter(p, liveSource ? { liveSource } : {});
        adapters.push(a);
        return { p, a, tech, network };
    }

    const liveSource = () => ({ resolveLive: vi.fn(() => Promise.resolve('#EXTM3U\n')) });

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.unstubAllGlobals();
    });

    it('answers live playlist requests from the live source it was given', async () => {
        const live = liveSource();
        const { p, a, tech, network } = setup(live);
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');

        const callback = vi.fn();
        tech.vhs.xhr({ uri: 'luminary://live/1' }, callback);
        await settle();

        expect(live.resolveLive).toHaveBeenCalledWith('luminary://live/1', expect.any(AbortSignal));
        expect(network).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ status: 200 }));
    });

    it('answers keys and live playlists side by side, and sends the rest to the network', async () => {
        // Three policies on one factory: none may swallow another's requests.
        const live = liveSource();
        const { p, a, tech, network } = setup(live);
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');

        const keyCallback = vi.fn();
        tech.vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, keyCallback);
        tech.vhs.xhr({ uri: 'luminary://live/1' }, vi.fn());
        tech.vhs.xhr({ uri: 'https://live.example.com/l_1.ts' }, vi.fn());
        await settle();

        expect(new Uint8Array(keyCallback.mock.calls[0]![1].response)).toHaveLength(16);
        expect(live.resolveLive).toHaveBeenCalledTimes(1);
        expect(network).toHaveBeenCalledTimes(1);
        expect(network).toHaveBeenCalledWith({ uri: 'https://live.example.com/l_1.ts' }, expect.anything());
    });

    it('leaves live addresses to the network when it has no live source', async () => {
        const { p, a, tech, network } = setup();
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');

        tech.vhs.xhr({ uri: 'luminary://live/1' }, vi.fn());

        expect(network).toHaveBeenCalledWith({ uri: 'luminary://live/1' }, expect.anything());
    });

    it('arms the live seam again on the handler a re-attach builds', async () => {
        // A re-src builds a fresh VHS handler with a fresh request factory; a
        // live stream that recovers must still be able to refresh.
        const live = liveSource();
        const { p, a, tech } = setup(live);
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');

        const rebuilt = vi.fn();
        tech.vhs = { xhr: rebuilt };
        await a.reattach();
        p.fire('xhr-hooks-ready');
        tech.vhs.xhr({ uri: 'luminary://live/2' }, vi.fn());

        expect(live.resolveLive).toHaveBeenCalledWith('luminary://live/2', expect.any(AbortSignal));
        expect(rebuilt).not.toHaveBeenCalled();
    });

    it('leaves the handler it is moving away from wrapped, not back on the raw network', async () => {
        // video.js disposes that handler only once the next src() lands, and a
        // live one keeps refreshing until then: luminary://live/… over a real XHR
        // is refused by the browser, and VHS excludes renditions over it.
        const live = liveSource();
        const { p, a, tech, network } = setup(live);
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');
        const leaving = tech.vhs;

        await a.loadSource({ ...source, url: 'blob:next' });
        leaving.xhr({ uri: 'luminary://live/1' }, vi.fn());

        expect(live.resolveLive).toHaveBeenCalledWith('luminary://live/1', expect.any(AbortSignal));
        expect(network).not.toHaveBeenCalled();
    });

    it('leaves it wrapped on destroy as well, which is how a switch to YouTube begins', async () => {
        const live = liveSource();
        const { p, a, tech, network } = setup(live);
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');

        a.destroy();
        tech.vhs.xhr({ uri: 'luminary://live/1' }, vi.fn());

        expect(live.resolveLive).toHaveBeenCalledTimes(1);
        expect(network).not.toHaveBeenCalled();
    });

    it("answers a handler's key requests with its own source's key, whatever came next", async () => {
        const { p, a, tech } = setup();
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');
        const leaving = tech.vhs;

        await a.loadSource({ ...source, url: 'blob:next', keyHex: 'ff'.repeat(16) });
        const callback = vi.fn();
        leaving.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, callback);
        await settle();

        // KEY_HEX is 00 01 … 0f.
        expect(new Uint8Array(callback.mock.calls[0]![1].response)).toEqual(
            Uint8Array.from({ length: 16 }, (_, i) => i),
        );
    });
});

/**
 * video.js swaps sources a tick after `src()`, and until then the outgoing VHS
 * handler is alive with its tracks in the list. Selecting one sends that handler
 * for a playlist whose URL the wrapper revoked when the new load began: the
 * request fails, VHS falls back to its default, and the default is what the new
 * source was given. So the adapter keeps the outgoing list to itself.
 */
describe("VideoJsAdapter — the outgoing source's audio tracks", () => {
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY };
    const adapters: VideoJsAdapter[] = [];

    /**
     * An audio track list that behaves as video.js's does across a source
     * change: every addition and removal is announced, and the outgoing
     * source's tracks are all removed before the new source's are added.
     */
    function trackList() {
        const handlers = new Map<string, Set<() => void>>();
        const fire = (type: string) => handlers.get(type)?.forEach((handler) => handler());
        const list: any = Object.assign([] as any[], {
            on: (type: string, handler: () => void) => {
                handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
            },
            off: (type: string, handler: () => void) => handlers.get(type)?.delete(handler),
            add(id: string, enabled = false) {
                list.push({ id, language: id, label: id.toUpperCase(), enabled });
                fire('addtrack');
            },
            clear() {
                while (list.length > 0) {
                    list.pop();
                    fire('removetrack');
                }
            },
        });
        return list;
    }

    function setup() {
        vi.stubGlobal('MediaSource', class {});
        const tracks = trackList();
        const a = new VideoJsAdapter(fakePlayer({ audioTracks: () => tracks }));
        adapters.push(a);
        const updates = vi.fn();
        a.on('audiotracks-updated', updates);
        return { a, tracks, updates };
    }

    /** A source loaded and playing, its tracks listed. */
    async function playing() {
        const context = setup();
        await context.a.loadSource(source);
        context.tracks.add('en', true);
        context.tracks.add('fr');
        context.updates.mockClear();
        return context;
    }

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.unstubAllGlobals();
    });

    it('lists none from the next load until video.js has torn the old ones down', async () => {
        const { a, tracks } = await playing();

        await a.loadSource({ ...source, url: 'blob:next' });
        expect(a.getAudioTracks()).toEqual([]);

        tracks.clear();
        tracks.add('en', true);
        expect(a.getAudioTracks()).toEqual([{ id: 'en', lang: 'en', label: 'EN' }]);
    });

    it('refuses a selection in the outgoing list', async () => {
        const { a, tracks } = await playing();

        await a.loadSource({ ...source, url: 'blob:next' });
        a.setAudioTrack('fr');

        expect(tracks[1].enabled).toBe(false);
    });

    it("selects in the new source's list once it has arrived", async () => {
        const { a, tracks } = await playing();
        await a.loadSource({ ...source, url: 'blob:next' });
        tracks.clear();
        tracks.add('en', true);
        tracks.add('fr');

        a.setAudioTrack('fr');

        expect(tracks[1].enabled).toBe(true);
    });

    it('announces the retirement, which is all the wrapper learns of a re-attach', async () => {
        const { a, updates } = await playing();

        await a.reattach();

        expect(a.getAudioTracks()).toEqual([]);
        expect(updates).toHaveBeenCalledTimes(1);
    });

    it('has nothing to retire on a first load', async () => {
        const { a, tracks, updates } = setup();

        await a.loadSource(source);
        expect(updates).not.toHaveBeenCalled();

        tracks.add('en', true);
        expect(a.getAudioTracks()).toEqual([{ id: 'en', lang: 'en', label: 'EN' }]);
    });
});

/**
 * The way back from YouTube is a tech swap inside `src()`. video.js unloads the
 * YouTube tech, carrying its text tracks across as JSON, and builds an Html5
 * tech with the source already in hand. The new VHS handler announces itself
 * from inside that constructor, while the player still reports no tech at all.
 */
describe('VideoJsAdapter — coming back from YouTube', () => {
    const KEY_HEX = '000102030405060708090a0b0c0d0e0f';
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY, keyHex: KEY_HEX };
    const adapters: VideoJsAdapter[] = [];

    /** A player on the YouTube tech, whose `src()` swaps it for Html5 as video.js's does. */
    function fromYouTube(options: VideoJsAdapterOptions = {}) {
        vi.stubGlobal('MediaSource', class {});
        const network = vi.fn(() => 'network');
        const youtube = {
            // VHS's metadata track, filled by the HLS source played before YouTube.
            textTracks: [{ kind: 'metadata', cues: [{ startTime: 0, endTime: 6 }] }] as unknown[],
            clearTracks: vi.fn(() => {
                youtube.textTracks = [];
            }),
        };
        const html5 = { vhs: { xhr: network } as Record<string, any> };
        let tech: unknown = youtube;
        let carried: unknown[] = [];
        let recorded: { src?: string; type?: string } = {};
        const p = fakePlayer({
            techName_: 'Youtube',
            tech: vi.fn(() => tech),
            currentSource: () => recorded,
            updateSourceCaches_: (next: typeof recorded) => {
                recorded = next;
            },
            src: vi.fn((next: typeof recorded) => {
                recorded = next;
                // unloadTech_: what the next tech is handed of this one's tracks.
                carried = youtube.textTracks;
                tech = false;
                // loadTech_: the new tech's constructor sets the source, and
                // VHS announces its handler from in there.
                p.techName_ = 'Html5';
                p.fire('xhr-hooks-ready');
                tech = html5;
            }),
        });
        const a = new VideoJsAdapter(p, options);
        adapters.push(a);
        return { p, a, html5, network, youtube, carried: () => carried };
    }

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.unstubAllGlobals();
    });

    it("answers the new source's keys and live playlists, though its handler is out of reach when announced", async () => {
        // Unanswered, a live source's playlist requests went out as real XHRs,
        // which the browser refuses, and VHS excluded one rendition after another.
        const live = { resolveLive: vi.fn(() => Promise.resolve('#EXTM3U\n')) };
        const { a, html5, network } = fromYouTube({ liveSource: live });
        await a.loadSource(source);

        const keyCallback = vi.fn();
        html5.vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, keyCallback);
        html5.vhs.xhr({ uri: 'luminary://live/1' }, vi.fn());
        await settle();

        expect(network).not.toHaveBeenCalled();
        expect(new Uint8Array(keyCallback.mock.calls[0]![1].response)).toHaveLength(16);
        expect(live.resolveLive).toHaveBeenCalledWith('luminary://live/1', expect.any(AbortSignal));
    });

    it('carries no text tracks out of the YouTube tech', async () => {
        // Html5 puts carried cues back with `addCue`, which Safari's native
        // tracks refuse: the swap threw half-way, and every play after it
        // waited on a load that had already happened.
        const { a, youtube, carried } = fromYouTube();

        await a.loadSource(source);

        expect(youtube.clearTracks).toHaveBeenCalledWith('text');
        expect(carried()).toEqual([]);
    });

    it('leaves the text tracks alone when the player is on Html5 already', async () => {
        // No tech is swapped, so nothing is carried: the tracks are the
        // playing handler's own.
        vi.stubGlobal('MediaSource', class {});
        const tech = { vhs: {}, clearTracks: vi.fn() };
        const a = new VideoJsAdapter(fakePlayer({ techName_: 'Html5', tech: vi.fn(() => tech) }));
        adapters.push(a);

        await a.loadSource(source);

        expect(tech.clearTracks).not.toHaveBeenCalled();
    });

    it("puts back the record of its source that the new tech's first sourceset wipes", async () => {
        // video.js trusts that record: `play()` will not start without one,
        // and in Safari it rebuilds the engine from it — from nothing, which
        // is "No compatible source was found for this media".
        const { p, a } = fromYouTube();
        await a.loadSource(source);

        // The Html5 tech, once ready, reports the empty source it was built
        // with, and video.js records that over the one it was given.
        p.updateSourceCaches_({ src: '' });
        p.fire('sourceset');

        expect(p.currentSource()).toEqual({ src: 'blob:master', type: 'application/x-mpegURL' });
    });
});

/**
 * On Safari, VHS attaches its MediaSource through `<source>` elements, and
 * video.js's `play()` calls `load()` while a source change is under way. Each
 * undid a switch made behind it — an angle, the audio toggle, a recovery
 * re-attach: the first by playing the old stream on, the second by rebuilding
 * the engine from video.js's record of the source.
 */
describe('VideoJsAdapter — changing source in Safari', () => {
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY };
    const adapters: VideoJsAdapter[] = [];

    function setup({ mediaSource = true } = {}) {
        if (mediaSource) vi.stubGlobal('MediaSource', class {});
        const video = document.createElement('video');
        const tech = {
            vhs: { xhr: vi.fn() },
            el: () => video,
            // The Html5 tech's own: every `<source>` and the `src` removed.
            reset: vi.fn(() => {
                video.querySelectorAll('source').forEach((element) => element.remove());
                video.removeAttribute('src');
            }),
        };
        const load = vi.fn();
        const p = fakePlayer({ techName_: 'Html5', tech: vi.fn(() => tech) });
        // Where video.js keeps it: on the prototype, not the instance.
        Object.setPrototypeOf(p, { load });
        const a = new VideoJsAdapter(p);
        adapters.push(a);
        return { p, a, video, tech, load };
    }

    /** What VHS attaches on Safari: its MediaSource's URL, and the playlist's for AirPlay. */
    function attachSources(video: HTMLVideoElement, mediaSourceUrl: string, playlistUrl: string): void {
        for (const src of [mediaSourceUrl, playlistUrl]) {
            video.append(Object.assign(document.createElement('source'), { src }));
        }
    }

    const sourcesOf = (video: HTMLVideoElement) =>
        [...video.querySelectorAll('source')].map((element) => element.getAttribute('src'));

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.unstubAllGlobals();
    });

    it("takes the replaced handler's <source> elements off before the next one adds its own", async () => {
        // A playing element ignores a `<source>` added to it: the old stream
        // played on to its end, and stopped.
        const { p, a, video } = setup();
        await a.loadSource(source);
        p.fire('xhr-hooks-ready');
        attachSources(video, 'blob:media-source-1', 'blob:master');

        await a.loadSource({ ...source, url: 'blob:angle-2' });
        p.fire('xhr-hooks-ready');
        attachSources(video, 'blob:media-source-2', 'blob:angle-2');
        p.fire('loadstart');

        expect(sourcesOf(video)).toEqual(['blob:media-source-2', 'blob:angle-2']);
    });

    it('leaves an element given its source through `src` alone', async () => {
        // Everywhere else VHS sets `src`, which the next handler's replaces.
        const { p, a, video, tech } = setup();
        await a.loadSource(source);
        video.setAttribute('src', 'blob:media-source-1');

        await a.loadSource({ ...source, url: 'blob:angle-2' });
        p.fire('xhr-hooks-ready');

        expect(tech.reset).not.toHaveBeenCalled();
    });

    it("declines video.js's load() while VHS plays the source", async () => {
        // For a VHS source, load() is src(currentSource()): a handler built
        // behind the adapter, which never wrapped it.
        const { p, a, load } = setup();
        await a.loadSource(source);

        p.load();

        expect(load).not.toHaveBeenCalled();
    });

    it('leaves load() to video.js for a source played natively', async () => {
        // With no Media Source the platform plays the URL, and load() is how
        // video.js primes the element for it.
        const { p, a, load } = setup({ mediaSource: false });
        await a.loadSource({ url: 'https://cdn.example.com/master.m3u8', isBlob: false, recovery: DEFAULT_RECOVERY_POLICY });

        p.load();

        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.contexts[0]).toBe(p);
    });

    it('gives load() back when destroyed', async () => {
        const { p, a, load } = setup();
        await a.loadSource(source);

        a.destroy();

        expect(p.load).toBe(load);
    });
});
