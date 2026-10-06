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
    const plugin = (props.plugin as FakePlugin | undefined) ?? new FakePlugin();
    const wrapper = mount(NativeLuminaryPlayer, {
        props: { source: { masterUrl: MASTER_URL }, ...props, plugin },
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

    it('takes the poster as player-web does: a URL, or what the browser chooses between, with a fallback', async () => {
        const image = { src: 'https://cdn.example.com/p.jpg', srcset: 'https://cdn.example.com/p-2x.jpg 2x', sizes: '100vw', fallback: 'https://cdn.example.com/f.jpg' };
        const { plugin, wrapper } = await mountPlayer({ poster: image, nowPlaying: { title: 'Episode 12' } });

        expect(plugin.argsOf<LoadArgs>('load')[0]!.nowPlaying?.artworkUrl).toBe('https://cdn.example.com/p.jpg');
        const img = wrapper.get('img');
        expect(img.attributes('srcset')).toBe(image.srcset);
        expect(img.attributes('sizes')).toBe('100vw');

        await img.trigger('error');
        expect(wrapper.get('img').attributes('src')).toBe(image.fallback);
        expect(wrapper.get('img').attributes('srcset')).toBeUndefined();
    });

    it('keeps the default text where a host passes an undefined one', async () => {
        const { plugin, wrapper } = await mountPlayer({ messages: { retry: undefined, errorMedia: 'Échec' } });
        await ready(plugin);
        const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
        plugin.emit('error', { playerId: load.playerId, loadId: load.loadId }, { category: 'media', code: 'x', message: 'x', fatal: true });
        await flush();
        await nextTick();

        expect(wrapper.text()).toContain('Échec');
        expect(wrapper.get('button').text()).toBe('Try again');
    });

    it('hands the host\'s controller options to the controller', async () => {
        const fetched: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            fetched.push(String(input));
            return new Response(SIMPLE_MASTER, { status: 200 });
        }) as typeof fetch;
        vi.stubGlobal('fetch', () => {
            throw new Error('the global fetch must not be used');
        });
        const plugin = new FakePlugin();
        const wrapper = mount(NativeLuminaryPlayer, {
            props: { source: { masterUrl: MASTER_URL }, plugin, controllerOptions: { fetchImpl } },
        });
        wrappers.push(wrapper);
        await flush();
        await flush();

        expect(fetched).toContain(MASTER_URL);
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

    describe('the texts native full-screen says', () => {
        it('are the host\'s messages as they are when full-screen opens, and native\'s English where there are none', async () => {
            const { plugin, wrapper, exposed } = await mountPlayer({ messages: { exitFullscreen: 'Quitter le plein écran' } });
            await ready(plugin);

            await exposed.enterFullscreen();
            const first = plugin.argsOf<{ texts: Record<string, string> }>('enterFullscreen').at(-1)!.texts;
            expect(first.exitFullscreen).toBe('Quitter le plein écran');
            expect(first.playbackRate).toBe('Playback Rate');
            expect(first.skipBack).toBe('Skip back {seconds} seconds');

            // The language changed: the next full-screen says it.
            await wrapper.setProps({ messages: { exitFullscreen: 'Exit fullscreen now' } });
            await exposed.enterFullscreen();
            expect(plugin.argsOf<{ texts: Record<string, string> }>('enterFullscreen').at(-1)!.texts.exitFullscreen).toBe(
                'Exit fullscreen now',
            );
        });
    });

    describe('muting and picture in picture, for a host that draws its own controls', () => {
        it('follows what native says about muting, and passes the host\'s choice on', async () => {
            const { plugin, exposed } = await mountPlayer({ plugin: new FakePlugin({ muting: true, pictureInPicture: true }) });
            await ready(plugin);
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;

            expect(exposed.canMute).toBe(true);
            expect(exposed.muted).toBe(false);
            plugin.emit('mutedchange', { playerId: load.playerId, loadId: load.loadId }, { muted: true });
            await flush();
            expect(exposed.muted).toBe(true);

            exposed.setMuted(false);
            exposed.startPictureInPicture();
            expect(plugin.argsOf('setMuted').at(-1)).toEqual({ playerId: load.playerId, muted: false });
            expect(plugin.methods()).toContain('startPictureInPicture');
        });

        it('says what native cannot do', async () => {
            const { plugin, exposed } = await mountPlayer();
            await ready(plugin);

            expect(exposed.canMute).toBe(false);
            expect(exposed.canPictureInPicture).toBe(false);
            exposed.setMuted(true);
            expect(plugin.methods()).not.toContain('setMuted');
        });
    });

    describe('video inside the page', () => {
        const RECT = { left: 0, top: 72, width: 390, height: 219, right: 390, bottom: 291, x: 0, y: 72 } as DOMRect;

        beforeEach(() => {
            vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            });
            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
        });
        afterEach(() => vi.restoreAllMocks());

        const frames = (plugin: FakePlugin) => plugin.argsOf<{ frame?: unknown }>('setInlineFrame').map((args) => args.frame);

        it('tells native where the video goes, and draws nothing over it', async () => {
            const { plugin, wrapper } = await mountPlayer({ inline: true, plugin: new FakePlugin({ inlineVideo: true }), poster: 'https://cdn.example.com/p.jpg' });
            await ready(plugin);
            await flush();

            expect(frames(plugin)).toEqual([{ x: 0, y: 72, width: 390, height: 219 }]);
            expect(wrapper.find('img').exists()).toBe(false);
            expect(wrapper.find('button[aria-label="Play"]').exists()).toBe(false);
            expect(wrapper.get('.native-luminary-player').attributes('style')).toContain('background: transparent');
        });

        it('says it again only when the frame moves', async () => {
            const { plugin } = await mountPlayer({ inline: true, plugin: new FakePlugin({ inlineVideo: true }) });
            await ready(plugin);
            window.dispatchEvent(new Event('resize'));
            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...RECT, top: 100, y: 100 } as DOMRect);
            window.dispatchEvent(new Event('resize'));

            expect(frames(plugin)).toEqual([
                { x: 0, y: 72, width: 390, height: 219 },
                { x: 0, y: 100, width: 390, height: 219 },
            ]);
        });

        it('takes the video away in audio only, and when the component goes', async () => {
            const { plugin, wrapper } = await mountPlayer({ inline: true, plugin: new FakePlugin({ inlineVideo: true }) }, AUDIO_ONLY_MASTER);
            await ready(plugin);
            expect(frames(plugin).at(-1)).toBeUndefined();

            wrapper.unmount();
            expect(plugin.methods()).toContain('setInlineFrame');
            expect(frames(plugin).at(-1)).toBeUndefined();
        });

        it('behaves as it always has where native cannot draw inline', async () => {
            const { plugin, wrapper } = await mountPlayer({ inline: true, poster: 'https://cdn.example.com/p.jpg' });
            await ready(plugin);

            expect(plugin.methods()).not.toContain('setInlineFrame');
            expect(wrapper.find('img').exists()).toBe(true);
            expect(wrapper.find('button[aria-label="Play"]').exists()).toBe(true);
        });
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

        it('leaves full-screen when a new source is not published yet, so "Coming soon" shows', async () => {
            const { plugin, wrapper } = await mountPlayer();
            await ready(plugin);
            const load = plugin.argsOf<LoadArgs>('load').at(-1)!;
            plugin.emit('presentationchange', { playerId: load.playerId, loadId: load.loadId }, { state: 'fullscreen' });
            await flush();

            await wrapper.setProps({ source: { masterUrl: `${BASE}/not-yet.m3u8` } });
            await flush();
            await flush();

            expect(wrapper.text()).toContain('Coming soon');
            expect(plugin.methods()).toContain('exitFullscreen');
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
