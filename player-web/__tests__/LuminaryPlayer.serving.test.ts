import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toRaw } from 'vue';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * Live playback needs the serving layer and the adapter to be one pair: the
 * strategy mints the `luminary://live/…` addresses, and only an adapter holding
 * that same strategy can answer them. Each half works alone, so a component
 * that built them apart would pass every other test and play no live stream.
 * These pin the pairing the default controller makes.
 */
const player = vi.hoisted(() => ({ current: null as any }));
const built = vi.hoisted(() => ({
    adapterOptions: [] as any[],
    controllerOptions: [] as any[],
}));

vi.mock('video.js', () => {
    const videojs: any = vi.fn(() => player.current);
    videojs.browser = { IS_ANY_SAFARI: false };
    videojs.getTech = vi.fn(() => function Youtube() {});
    return { default: videojs };
});
vi.mock('videojs-mobile-ui', () => ({}));
vi.mock('videojs-youtube', () => ({}));

// Both constructors are replaced by recorders: what is under test is what the
// component hands them, not what they do with it.
vi.mock('../src/adapter/VideoJsAdapter', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/adapter/VideoJsAdapter')>()),
    VideoJsAdapter: class {
        constructor(_player: unknown, options: unknown) {
            built.adapterOptions.push(options);
        }
    },
}));
vi.mock('@luminary-media-converter/player-core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@luminary-media-converter/player-core')>();
    return {
        ...actual,
        PlayerController: class {
            load = vi.fn(() => Promise.resolve());
            destroy = vi.fn();
            getState = () => actual.createInitialState();
            subscribe = vi.fn(() => () => {});
            constructor(_adapter: unknown, options: unknown) {
                built.controllerOptions.push(options);
            }
        },
    };
});

import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';
import { BlobServeStrategy } from '../src/serve/BlobServeStrategy';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

async function mountPlayer(controllerOptions?: Record<string, unknown>) {
    player.current = fakePlayer();
    const wrapper = mount(LuminaryPlayer, {
        props: {
            source: { masterUrl: 'https://cdn/master.m3u8' },
            ...(controllerOptions ? { controllerOptions } : {}),
        } as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

beforeEach(() => {
    built.adapterOptions.length = 0;
    built.controllerOptions.length = 0;
});

describe('LuminaryPlayer — the default serving layer', () => {
    it('hands the adapter the very strategy the controller serves through', async () => {
        const wrapper = await mountPlayer();

        const strategy = built.controllerOptions[0].serveStrategy;
        expect(strategy).toBeInstanceOf(BlobServeStrategy);
        expect(built.adapterOptions[0].liveSource).toBe(strategy);
        wrapper.unmount();
    });

    it("uses a host's strategy as given, and gives the adapter no live source for it", async () => {
        // The adapter can only answer addresses a BlobServeStrategy minted; a
        // host serving through something else answers its own.
        const hostStrategy = { serve: vi.fn(() => 'host:1'), release: vi.fn() };
        const wrapper = await mountPlayer({ serveStrategy: hostStrategy });

        // Props arrive reactive, so what the controller holds is a proxy of it.
        expect(toRaw(built.controllerOptions[0].serveStrategy)).toBe(hostStrategy);
        expect(built.adapterOptions[0].liveSource).toBeUndefined();
        wrapper.unmount();
    });

    it("refreshes live playlists through the host's fetch, as the load reads them", async () => {
        const LIVE_URL = 'https://live.example.com/video_360/chunks.m3u8';
        const hostFetch = vi.fn(async () => {
            const bytes = new TextEncoder().encode('#EXTM3U\n#EXT-X-TARGETDURATION:4\n');
            return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response;
        });
        const wrapper = await mountPlayer({ fetchImpl: hostFetch });

        const strategy: BlobServeStrategy = built.controllerOptions[0].serveStrategy;
        expect(toRaw(built.controllerOptions[0].fetchImpl)).toBe(hostFetch);
        const uri = strategy.serveLive({ url: LIVE_URL, baseUrl: LIVE_URL, refreshSec: 4 });
        await strategy.resolveLive(uri, new AbortController().signal);

        expect(hostFetch).toHaveBeenCalledWith(LIVE_URL, expect.anything());
        wrapper.unmount();
    });
});
