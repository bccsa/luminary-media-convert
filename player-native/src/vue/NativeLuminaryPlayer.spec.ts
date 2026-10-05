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

    it('reports a refused play as false and a refused presentation as a warning, never a rejection', async () => {
        const { plugin, exposed, wrapper } = await mountPlayer();
        await ready(plugin);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        plugin.failWith('play', 'engine');
        plugin.failWith('enterFullscreen', 'unknown-player');

        await expect(exposed.play()).resolves.toBe(false);
        await exposed.enterFullscreen();
        await wrapper.get('button').trigger('click');
        await flush();

        expect(warn).toHaveBeenCalledWith('[luminary-native] enterFullscreen failed', expect.anything());
        warn.mockRestore();
    });

    it('says so when the native player could not start, with nothing to retry', async () => {
        vi.stubGlobal('fetch', makeFetch(routesFor(SIMPLE_MASTER)).fetchImpl);
        const plugin = new FakePlugin();
        plugin.failWith('create', 'engine');
        const wrapper = mount(NativeLuminaryPlayer, { props: { source: { masterUrl: MASTER_URL }, plugin } });
        wrappers.push(wrapper);
        await flush();

        expect(wrapper.text()).toContain('This video could not be played.');
        expect(wrapper.find('button').exists()).toBe(false);
        expect(plugin.methods()).not.toContain('load');
    });

    describe("player-web's panels", () => {
        /** A fatal error from native, after the ladder: what the viewer is told. */
        async function fail(plugin: FakePlugin, category: 'network' | 'media' | 'other'): Promise<void> {
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
            plugin.emit(
                'error',
                { playerId: load.playerId, loadId: load.loadId },
                { category, fatal: true, code: 'NSURLErrorDomain:-1009', message: 'offline' },
            );
            await flush();
            await nextTick();
        }

        it('shows the error and tries again from it, as the web player does', async () => {
            const { plugin, wrapper } = await mountPlayer();
            await ready(plugin);
            await fail(plugin, 'network');

            expect(wrapper.text()).toContain('The video could not be reached. Check your connection.');
            const loads = plugin.argsOf<LoadArgs>('load').length;
            await wrapper.get('button').trigger('click');
            await flush();
            expect(plugin.argsOf<LoadArgs>('load').length).toBe(loads + 1);
        });

        it('leaves full-screen on an error, so the panel shows', async () => {
            const { plugin } = await mountPlayer();
            await ready(plugin);
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
            plugin.emit('presentationchange', { playerId: load.playerId, loadId: load.loadId }, { state: 'fullscreen' });
            await flush();
            await fail(plugin, 'network');

            expect(plugin.methods()).toContain('exitFullscreen');
        });

        it('reports an exit from full-screen that native refuses on an error', async () => {
            const { plugin } = await mountPlayer();
            await ready(plugin);
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
            plugin.emit('presentationchange', { playerId: load.playerId, loadId: load.loadId }, { state: 'fullscreen' });
            await flush();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            plugin.failWith('exitFullscreen', 'unknown-player');

            await fail(plugin, 'network');
            await flush();

            expect(warn).toHaveBeenCalledWith('[luminary-native] exitFullscreen failed', expect.anything());
            warn.mockRestore();
        });

        it('leaves an inline player as it is on an error', async () => {
            const { plugin } = await mountPlayer();
            await ready(plugin);
            await fail(plugin, 'network');

            expect(plugin.methods()).not.toContain('exitFullscreen');
        });

        it('takes the texts a host passes', async () => {
            const { plugin, wrapper } = await mountPlayer({ messages: { errorMedia: 'Échec', retry: 'Réessayer' } });
            await ready(plugin);
            await fail(plugin, 'media');

            expect(wrapper.text()).toContain('Échec');
            expect(wrapper.get('button').text()).toBe('Réessayer');
        });

        it('lets a host replace the error panel', async () => {
            vi.stubGlobal('fetch', makeFetch(routesFor(SIMPLE_MASTER)).fetchImpl);
            const plugin = new FakePlugin();
            const wrapper = mount(NativeLuminaryPlayer, {
                props: { source: { masterUrl: MASTER_URL }, plugin },
                slots: { error: '<p class="mine">Custom</p>' },
            });
            wrappers.push(wrapper);
            await flush();
            await flush();
            await ready(plugin);
            await fail(plugin, 'other');

            expect(wrapper.find('.mine').exists()).toBe(true);
            expect(wrapper.text()).not.toContain('This video could not be played.');
        });

        it('says "Coming soon" while the master is not published yet', async () => {
            vi.stubGlobal('fetch', makeFetch({}).fetchImpl);
            const plugin = new FakePlugin();
            const wrapper = mount(NativeLuminaryPlayer, { props: { source: { masterUrl: MASTER_URL }, plugin } });
            wrappers.push(wrapper);
            await flush();
            await flush();

            expect(wrapper.text()).toContain('Coming soon');
        });
    });

    describe("player-web's audio / video toggle", () => {
        const toggle = (wrapper: VueWrapper) => wrapper.find('button[aria-label="Play audio only"], button[aria-label="Play video"]');

        it('switches to audio only and back', async () => {
            const { plugin, wrapper } = await mountPlayer();
            await ready(plugin);
            expect(toggle(wrapper).attributes('aria-label')).toBe('Play audio only');

            await toggle(wrapper).trigger('click');
            await flush();
            await ready(plugin);
            expect(toggle(wrapper).attributes('aria-label')).toBe('Play video');

            await toggle(wrapper).trigger('click');
            await flush();
            await ready(plugin);
            expect(toggle(wrapper).attributes('aria-label')).toBe('Play audio only');
        });

        it('is gone when the host switches it off', async () => {
            const { plugin, wrapper } = await mountPlayer({ controls: { audioVideoToggle: false } });
            await ready(plugin);
            expect(toggle(wrapper).exists()).toBe(false);
        });
    });

    describe('the preferred audio language', () => {
        const TRACKS = [
            { id: 'en', lang: 'en', label: 'English' },
            { id: 'fr', lang: 'fr', label: 'Français' },
            { id: 'es', lang: 'es', label: 'Español' },
        ];

        /** Native's track list, as the engine announces it, with `activeId` selected. */
        async function announce(plugin: FakePlugin, activeId: string, tracks = TRACKS): Promise<void> {
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
            plugin.emit(
                'audiotracks-updated',
                { playerId: load.playerId, loadId: load.loadId },
                { tracks, activeId },
            );
            await flush();
            await nextTick();
            await flush();
        }

        const picks = (plugin: FakePlugin) => plugin.argsOf<{ id: string }>('setAudioTrack').map((args) => args.id);

        it('selects the preferred language when the tracks arrive, however it is spelled', async () => {
            const { plugin } = await mountPlayer({ preferredLanguage: 'fra' });
            await ready(plugin);

            await announce(plugin, 'en');

            expect(picks(plugin)).toEqual(['fr']);
        });

        it('leaves the selection alone when no track is in the preferred language', async () => {
            const { plugin } = await mountPlayer({ preferredLanguage: 'de' });
            await ready(plugin);

            await announce(plugin, 'en');

            expect(picks(plugin)).toEqual([]);
        });

        it("stands down once the viewer picks another language in the native menu", async () => {
            const { plugin, exposed } = await mountPlayer({ preferredLanguage: 'fr' });
            await ready(plugin);
            await announce(plugin, 'en');
            await announce(plugin, 'fr');

            // The viewer picks Spanish in AVKit's menu: native reports it, unasked.
            await announce(plugin, 'es');

            // Native already plays it, so nothing is sent back; and French is not put back.
            expect(picks(plugin)).toEqual(['fr']);
            expect(exposed.state.activeAudioTrackId).toBe('es');

            // Nor later, when a new list arrives with the viewer's language still on.
            await announce(plugin, 'es', [...TRACKS, { id: 'de', lang: 'de', label: 'Deutsch' }]);
            expect(picks(plugin)).toEqual(['fr']);
        });

        it('applies a new preference even after the viewer chose', async () => {
            const { plugin, wrapper } = await mountPlayer({ preferredLanguage: 'fr' });
            await ready(plugin);
            await announce(plugin, 'en');
            await announce(plugin, 'fr');
            await announce(plugin, 'es');

            await wrapper.setProps({ preferredLanguage: 'en' });
            await flush();

            expect(picks(plugin).at(-1)).toBe('en');
        });
    });

    it('destroys the native player when unmounted', async () => {
        const { plugin, wrapper } = await mountPlayer();

        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        await flush();

        expect(plugin.methods()).toContain('destroy');
    });
});
