// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import {
    AUDIO_ONLY_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
    flush,
    makeFetch,
    type RouteBody,
} from '../../../player-core/src/test-support/index.js';
import type { LoadArgs } from '../bridge.js';
import { FakePlugin } from '../test-support/fakePlugin.js';
import { NativeLuminaryPlayer, type NativeLuminaryPlayerExposed } from './NativeLuminaryPlayer.js';

const BASE = 'https://cdn.example.com/out/session';
const MASTER_URL = `${BASE}/master.m3u8`;

function routesFor(master: string): Record<string, RouteBody> {
    return {
        [MASTER_URL]: master,
        [`${BASE}/stream_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/stream_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/stream_480/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/audio_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    };
}

type Exposed = NativeLuminaryPlayerExposed;

const wrappers: VueWrapper[] = [];

async function mountPlayer(
    props: Record<string, unknown> = {},
    master: string = SIMPLE_MASTER,
): Promise<{ plugin: FakePlugin; wrapper: VueWrapper; exposed: Exposed }> {
    vi.stubGlobal('fetch', makeFetch(routesFor(master)).fetchImpl);
    const plugin = new FakePlugin();
    const wrapper = mount(NativeLuminaryPlayer, {
        props: { source: { masterUrl: MASTER_URL }, plugin, ...props },
    });
    wrappers.push(wrapper);
    await flush();
    await flush();
    return { plugin, wrapper, exposed: wrapper.vm as unknown as Exposed };
}

/** Native's answer to the load: the item is ready. */
async function ready(plugin: FakePlugin): Promise<void> {
    const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
    plugin.emit('loadedmetadata', { playerId: load.playerId, loadId: load.loadId }, { duration: 120 });
    await flush();
    await nextTick();
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    vi.unstubAllGlobals();
});

describe('NativeLuminaryPlayer', () => {
    it('creates a native player and loads the source through the bridge', async () => {
        const { plugin } = await mountPlayer();

        expect(plugin.methods().slice(0, 3)).toEqual(['getInfo', 'reset', 'create']);
        expect(plugin.argsOf<LoadArgs>('load')).toHaveLength(1);
    });

    it('sends the lock-screen metadata with the load, the poster standing in for missing artwork', async () => {
        const { plugin } = await mountPlayer({
            poster: 'https://cdn.example.com/poster.jpg',
            nowPlaying: { title: 'Episode 12', subtitle: 'Season 2' },
        });

        expect(plugin.argsOf<LoadArgs>('load')[0]!.nowPlaying).toEqual({
            title: 'Episode 12',
            subtitle: 'Season 2',
            artworkUrl: 'https://cdn.example.com/poster.jpg',
        });
    });

    it('keeps artwork the host gave', async () => {
        const { plugin } = await mountPlayer({
            poster: 'https://cdn.example.com/poster.jpg',
            nowPlaying: { title: 'Episode 12', artworkUrl: 'https://cdn.example.com/art.jpg' },
        });

        expect(plugin.argsOf<LoadArgs>('load')[0]!.nowPlaying?.artworkUrl).toBe('https://cdn.example.com/art.jpg');
    });

    it("emits loadedmetadata for its own player, and not for another's", async () => {
        const { plugin, wrapper } = await mountPlayer();
        const load = plugin.argsOf<LoadArgs>('load')[0]!;

        plugin.emit('loadedmetadata', { playerId: 'player-other', loadId: load.loadId }, { duration: 120 });
        expect(wrapper.emitted('loadedmetadata')).toBeUndefined();

        await ready(plugin);
        expect(wrapper.emitted('loadedmetadata')).toHaveLength(1);
    });

    it('plays and presents full-screen from the poster once the load is handed over', async () => {
        const { plugin, wrapper } = await mountPlayer();
        await ready(plugin);
        const button = wrapper.get('button');
        expect(button.attributes('disabled')).toBeUndefined();

        await button.trigger('click');
        await flush();
        expect(plugin.methods()).toContain('play');
        expect(plugin.methods()).toContain('enterFullscreen');
    });

    it('plays audio-only where it is, with no full-screen', async () => {
        const { plugin, wrapper } = await mountPlayer({}, AUDIO_ONLY_MASTER);
        await ready(plugin);

        await wrapper.get('button').trigger('click');
        await flush();
        expect(plugin.methods()).toContain('play');
        expect(plugin.methods()).not.toContain('enterFullscreen');
    });

    it('exposes the web player surface the host drives', async () => {
        const { plugin, exposed } = await mountPlayer();
        await ready(plugin);

        exposed.seek(42);
        await exposed.enterFullscreen();
        await exposed.exitFullscreen();
        await flush();

        expect(plugin.argsOf<{ position: number }>('seek').at(-1)?.position).toBe(42);
        expect(plugin.methods()).toEqual(expect.arrayContaining(['enterFullscreen', 'exitFullscreen']));
    });

    it('holds the play button while the native player could not start', async () => {
        vi.stubGlobal('fetch', makeFetch(routesFor(SIMPLE_MASTER)).fetchImpl);
        const plugin = new FakePlugin();
        plugin.failWith('create', 'engine');
        const wrapper = mount(NativeLuminaryPlayer, { props: { source: { masterUrl: MASTER_URL }, plugin } });
        wrappers.push(wrapper);
        await flush();

        expect(wrapper.get('button').attributes('disabled')).toBeDefined();
        expect(plugin.methods()).not.toContain('load');
    });

    it('destroys the native player when unmounted', async () => {
        const { plugin, wrapper } = await mountPlayer();

        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        await flush();

        expect(plugin.methods()).toContain('destroy');
    });
});
