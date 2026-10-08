import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * A host leaves fullscreen when a video ends, whether or not it is in it; video.js rejects
 * leaving a fullscreen nothing is in, and that rejection had no one to catch it.
 */
const player = vi.hoisted(() => ({ current: null as any }));

vi.mock('video.js', () => {
    const videojs: any = vi.fn(() => player.current);
    videojs.browser = { IS_ANY_SAFARI: false };
    videojs.getTech = vi.fn(() => function Youtube() {});
    return { default: videojs };
});
vi.mock('videojs-mobile-ui', () => ({}));
vi.mock('videojs-youtube', () => ({}));

import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

async function mountPlayer(inFullscreen: boolean) {
    player.current = fakePlayer({ isFullscreen: vi.fn(() => inFullscreen) });
    const wrapper = mount(LuminaryPlayer, {
        props: { source: { masterUrl: 'https://cdn/master.m3u8' } } as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

describe('LuminaryPlayer — exitFullscreen', () => {
    it('does nothing outside fullscreen', async () => {
        const wrapper = await mountPlayer(false);
        (wrapper.vm as any).exitFullscreen();

        expect(player.current.exitFullscreen).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('leaves fullscreen when in it', async () => {
        const wrapper = await mountPlayer(true);
        (wrapper.vm as any).exitFullscreen();

        expect(player.current.exitFullscreen).toHaveBeenCalled();
        wrapper.unmount();
    });
});
