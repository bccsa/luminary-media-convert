import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hls.js', async () => {
    const { FakeHls } = await import('./hls-mock');
    return { default: FakeHls };
});

import { HlsJsAdapter, UnsupportedBrowserError } from '../src/adapter/HlsJsAdapter';
import { BaseLoaderStub, FakeHls, baseLoaderCalls, resetHlsMock } from './hls-mock';
import { keyBytes } from '@luminary-media-converter/player-core';
import type { AdapterErrorPayload } from '@luminary-media-converter/player-core';

const KEY_HEX = '000102030405060708090a0b0c0d0e0f';

function createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    document.body.appendChild(video);
    return video;
}

function lastHls(): FakeHls {
    const instance = FakeHls.instances.at(-1);
    if (!instance) throw new Error('no Hls instance was constructed');
    return instance;
}

beforeEach(() => {
    resetHlsMock();
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('HlsJsAdapter — capabilities & loading', () => {
    it('declares in-memory key delivery', () => {
        const adapter = new HlsJsAdapter(createVideo());
        expect(adapter.capabilities).toEqual({
            nativeHls: false,
            keyDelivery: 'memory',
            variantSwitching: true,
            renderText: true,
        });
    });

    it('attaches the media element and loads the munged url', async () => {
        const video = createVideo();
        const adapter = new HlsJsAdapter(video);
        await adapter.loadSource({ url: 'blob:master', isBlob: true, keyHex: KEY_HEX });

        expect(lastHls().media).toBe(video);
        expect(lastHls().url).toBe('blob:master');
    });

    it('tears down a previous engine when loading again', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:one', isBlob: true });
        const first = lastHls();
        await adapter.loadSource({ url: 'blob:two', isBlob: true });

        expect(first.destroyed).toBe(true);
        expect(lastHls()).not.toBe(first);
    });
});

describe('HlsJsAdapter — unsupported browser', () => {
    it('fails with an unsupported-browser error when munged content needs MSE', async () => {
        FakeHls.supported = false;
        const adapter = new HlsJsAdapter(createVideo());
        const errors: AdapterErrorPayload[] = [];
        adapter.on('error', (payload) => errors.push(payload));

        await expect(
            adapter.loadSource({ url: 'blob:master', isBlob: true, keyHex: KEY_HEX }),
        ).rejects.toBeInstanceOf(UnsupportedBrowserError);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.fatal).toBe(true);
        expect(errors[0]?.category).toBe('other');
        expect((errors[0]?.detail as UnsupportedBrowserError).code).toBe('unsupported-browser');
        expect(FakeHls.instances).toHaveLength(0);
    });

    it('falls back to the native player for un-munged sources', async () => {
        FakeHls.supported = false;
        const video = createVideo();
        const adapter = new HlsJsAdapter(video);

        await adapter.loadSource({ url: 'https://cdn.test/master.m3u8', isBlob: false });

        expect(video.src).toBe('https://cdn.test/master.m3u8');
        expect(FakeHls.instances).toHaveLength(0);
    });
});

describe('HlsJsAdapter — in-memory key loader', () => {
    async function loadedAdapter(keyHex?: string) {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:master', isBlob: true, keyHex });
        const LoaderClass = lastHls().config.loader as new (config: unknown) => BaseLoaderStub;
        return { adapter, loader: new LoaderClass({}) };
    }

    it('answers the sentinel key uri from memory without any network request', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const { loader } = await loadedAdapter(KEY_HEX);

        const onSuccess = vi.fn();
        const onError = vi.fn();
        loader.load(
            { url: 'luminary://key' },
            {},
            { onSuccess, onError } as unknown as Parameters<BaseLoaderStub['load']>[2],
        );

        expect(onError).not.toHaveBeenCalled();
        expect(baseLoaderCalls).toHaveLength(0);
        expect(fetchSpy).not.toHaveBeenCalled();

        const response = onSuccess.mock.calls[0]?.[0] as { data: ArrayBuffer };
        expect(new Uint8Array(response.data)).toEqual(keyBytes(KEY_HEX));
        expect(response.data.byteLength).toBe(16);
        vi.unstubAllGlobals();
    });

    it('never mints a blob url for the key', async () => {
        const createObjectURL = vi.fn(() => 'blob:key');
        vi.stubGlobal('URL', { ...URL, createObjectURL });
        const { loader } = await loadedAdapter(KEY_HEX);
        loader.load(
            { url: 'luminary://key' },
            {},
            { onSuccess: vi.fn(), onError: vi.fn() } as unknown as Parameters<
                BaseLoaderStub['load']
            >[2],
        );

        expect(createObjectURL).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('delegates every other request to the default loader', async () => {
        const { loader } = await loadedAdapter(KEY_HEX);
        const callbacks = { onSuccess: vi.fn(), onError: vi.fn() };
        loader.load(
            { url: 'https://cdn.test/seg1.m4s' },
            {},
            callbacks as unknown as Parameters<BaseLoaderStub['load']>[2],
        );

        expect(baseLoaderCalls).toHaveLength(1);
        expect(baseLoaderCalls[0]?.context.url).toBe('https://cdn.test/seg1.m4s');
        expect(callbacks.onSuccess).not.toHaveBeenCalled();
    });

    it('errors the key request when no session key was supplied', async () => {
        const { loader } = await loadedAdapter(undefined);
        const onSuccess = vi.fn();
        const onError = vi.fn();
        loader.load(
            { url: 'luminary://key' },
            {},
            { onSuccess, onError } as unknown as Parameters<BaseLoaderStub['load']>[2],
        );

        expect(onSuccess).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalled();
    });
});

describe('HlsJsAdapter — event mapping', () => {
    it('maps manifest and level events to variants-updated', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        const seen = vi.fn();
        adapter.on('variants-updated', seen);
        await adapter.loadSource({ url: 'blob:master', isBlob: true });

        lastHls().trigger(FakeHls.Events.MANIFEST_PARSED);
        lastHls().trigger(FakeHls.Events.LEVELS_UPDATED);
        lastHls().trigger(FakeHls.Events.LEVEL_SWITCHED);

        expect(seen).toHaveBeenCalledTimes(3);
    });

    it('maps audio track events to audiotracks-updated', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        const seen = vi.fn();
        adapter.on('audiotracks-updated', seen);
        await adapter.loadSource({ url: 'blob:master', isBlob: true });

        lastHls().trigger(FakeHls.Events.AUDIO_TRACKS_UPDATED);
        lastHls().trigger(FakeHls.Events.AUDIO_TRACK_SWITCHED);

        expect(seen).toHaveBeenCalledTimes(2);
    });

    it.each([
        [FakeHls.ErrorTypes.NETWORK_ERROR, 'network'],
        [FakeHls.ErrorTypes.MEDIA_ERROR, 'media'],
        [FakeHls.ErrorTypes.OTHER_ERROR, 'other'],
    ])('maps hls error type %s to category %s', async (type, category) => {
        const adapter = new HlsJsAdapter(createVideo());
        const errors: AdapterErrorPayload[] = [];
        adapter.on('error', (payload) => errors.push(payload));
        await adapter.loadSource({ url: 'blob:master', isBlob: true });

        lastHls().trigger(FakeHls.Events.ERROR, { type, fatal: true });

        expect(errors[0]).toMatchObject({ category, fatal: true });
    });

    it('forwards media element events', async () => {
        const video = createVideo();
        const adapter = new HlsJsAdapter(video);
        await adapter.loadSource({ url: 'blob:master', isBlob: true });

        const timeupdate = vi.fn();
        const paused = vi.fn();
        const ended = vi.fn();
        const waiting = vi.fn();
        const seeked = vi.fn();
        adapter.on('timeupdate', timeupdate);
        adapter.on('pause', paused);
        adapter.on('ended', ended);
        adapter.on('waiting', waiting);
        adapter.on('seeked', seeked);

        video.dispatchEvent(new Event('timeupdate'));
        video.dispatchEvent(new Event('pause'));
        video.dispatchEvent(new Event('ended'));
        video.dispatchEvent(new Event('waiting'));
        video.dispatchEvent(new Event('seeked'));

        expect(timeupdate).toHaveBeenCalledWith({ currentTime: 0 });
        expect(paused).toHaveBeenCalledTimes(1);
        expect(ended).toHaveBeenCalledTimes(1);
        expect(waiting).toHaveBeenCalledTimes(1);
        expect(seeked).toHaveBeenCalledTimes(1);
    });

    it('stops forwarding after destroy()', async () => {
        const video = createVideo();
        const adapter = new HlsJsAdapter(video);
        await adapter.loadSource({ url: 'blob:master', isBlob: true });
        const paused = vi.fn();
        adapter.on('pause', paused);

        adapter.destroy();
        video.dispatchEvent(new Event('pause'));

        expect(paused).not.toHaveBeenCalled();
        expect(lastHls().destroyed).toBe(true);
    });
});

describe('HlsJsAdapter — variants & audio tracks', () => {
    it('maps levels to variants, falling back to a bandwidth id', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:master', isBlob: true });
        lastHls().levels = [
            { height: 720, bitrate: 2_500_000 },
            { height: 0, bitrate: 128_000 },
        ];

        expect(adapter.getVariants()).toEqual([
            { id: '720', height: 720, bandwidth: 2_500_000 },
            { id: 'b128000', height: undefined, bandwidth: 128_000 },
        ]);
    });

    it('pins and un-pins variants', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:master', isBlob: true });
        const hls = lastHls();
        hls.levels = [
            { height: 360, bitrate: 800_000 },
            { height: 720, bitrate: 2_500_000 },
        ];

        adapter.setVariant('720');
        expect(hls.currentLevel).toBe(1);

        adapter.setVariant('auto');
        expect(hls.currentLevel).toBe(-1);

        adapter.setVariant('1080');
        expect(hls.currentLevel).toBe(-1);
    });

    it('maps and selects audio tracks', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:master', isBlob: true });
        const hls = lastHls();
        hls.audioTracks = [
            { id: 0, name: 'English', lang: 'en' },
            { id: 1, name: 'Français', lang: 'fr' },
        ];

        expect(adapter.getAudioTracks()).toEqual([
            { id: '0', lang: 'en', label: 'English' },
            { id: '1', lang: 'fr', label: 'Français' },
        ]);

        adapter.setAudioTrack('1');
        expect(hls.audioTrack).toBe(1);
    });
});

describe('HlsJsAdapter — text tracks', () => {
    function fakeTextTracks(video: HTMLVideoElement): { mode: string }[] {
        // jsdom has no TextTrack implementation — simulate the browser side.
        return [...video.querySelectorAll('track')].map((el) => {
            const track = { mode: 'disabled' };
            Object.defineProperty(el, 'track', { value: track, configurable: true });
            return track;
        });
    }

    it('creates, activates and removes track elements', async () => {
        const video = createVideo();
        const adapter = new HlsJsAdapter(video);
        await adapter.loadSource({ url: 'blob:master', isBlob: true });

        adapter.setTextTracks([
            { id: 'en', lang: 'en', label: 'English', blobUrl: 'blob:en' },
            { id: 'fr', lang: 'fr', label: 'Français', blobUrl: 'blob:fr' },
        ]);

        const els = [...video.querySelectorAll('track')];
        expect(els).toHaveLength(2);
        expect(els[0]?.kind).toBe('subtitles');
        expect(els[0]?.src).toContain('blob:en');
        expect(els[0]?.srclang).toBe('en');
        expect(els[1]?.label).toBe('Français');

        const tracks = fakeTextTracks(video);
        adapter.setActiveTextTrack('fr');
        expect(tracks.map((t) => t.mode)).toEqual(['disabled', 'showing']);

        adapter.setActiveTextTrack(null);
        expect(tracks.map((t) => t.mode)).toEqual(['disabled', 'disabled']);

        adapter.setTextTracks([]);
        expect(video.querySelectorAll('track')).toHaveLength(0);
    });
});

describe('HlsJsAdapter — recovery', () => {
    it('recovers media and network errors in place, and declines the rest', async () => {
        const adapter = new HlsJsAdapter(createVideo());
        await adapter.loadSource({ url: 'blob:master', isBlob: true });
        const hls = lastHls();

        expect(adapter.recover('media')).toBe(true);
        expect(hls.recoverMediaErrorCalls).toBe(1);

        expect(adapter.recover('network')).toBe(true);
        expect(hls.startLoadCalls).toBe(1);

        expect(adapter.recover('other')).toBe(false);
    });

    it('declines recovery without an engine', () => {
        const adapter = new HlsJsAdapter(createVideo());
        expect(adapter.recover('media')).toBe(false);
    });
});
