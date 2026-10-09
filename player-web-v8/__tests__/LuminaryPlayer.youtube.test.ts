import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * The YouTube tech joins the tech order at the moment a YouTube source is set,
 * and not before: listed while it is not loaded, video.js logs "The "youtube"
 * tech is undefined" every time it picks a tech — on every HLS load of a session
 * that never plays YouTube. Not listed when a YouTube source arrives, the source
 * finds no tech that accepts `video/youtube` and falls through to Html5.
 */
const player = vi.hoisted(() => ({ current: null as any }));

vi.mock('video.js', () => {
    // Keeps the construction options the component passes, as video.js does, so
    // the order under test is the one the component actually built.
    const videojs: any = vi.fn((_el: unknown, options: any) => {
        player.current.options_ = { ...options };
        return player.current;
    });
    videojs.browser = { IS_ANY_SAFARI: false };
    videojs.getTech = vi.fn(() => function Youtube() {});
    return { default: videojs };
});
vi.mock('videojs-mobile-ui', () => ({}));
vi.mock('videojs-youtube', () => ({}));

import { createInitialState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

const fakeController = () =>
    ({
        load: vi.fn(() => Promise.resolve()),
        destroy: vi.fn(),
        getState: () => createInitialState(),
        subscribe: vi.fn(() => () => {}),
    }) as any;

/** Mounts over a fake player whose `src` records the tech order it was set under. */
async function mountPlayer(masterUrl: string) {
    player.current = fakePlayer();
    const orderAtSrc: string[][] = [];
    player.current.src = vi.fn(() => {
        orderAtSrc.push([...player.current.options_.techOrder]);
    });
    const wrapper = mount(LuminaryPlayer, {
        props: { source: { masterUrl }, createController: fakeController } as any,
    });
    // The YouTube branch awaits the tech's dynamic import before setting a source.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { wrapper, orderAtSrc };
}

beforeEach(() => vi.clearAllMocks());

describe('LuminaryPlayer — the YouTube tech in the tech order', () => {
    it('lists the YouTube tech first before handing video.js a YouTube source', async () => {
        const { wrapper, orderAtSrc } = await mountPlayer('https://youtu.be/dQw4w9WgXcQ');

        expect(player.current.src).toHaveBeenCalledWith({
            type: 'video/youtube',
            src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        });
        expect(orderAtSrc).toEqual([['youtube', 'html5']]);
        wrapper.unmount();
    });

    it('leaves the order alone for an HLS source, so video.js has nothing to complain about', async () => {
        const { wrapper } = await mountPlayer('https://cdn.example.com/master.m3u8');

        expect(player.current.options_.techOrder).toEqual(['html5']);
        wrapper.unmount();
    });
});
