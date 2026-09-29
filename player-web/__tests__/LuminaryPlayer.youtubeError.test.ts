import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * A YouTube source whose iframe API cannot load — a network that blocks
 * YouTube, or Google's unusual-traffic block, which Safari turns into a redirect
 * loop — used to leave a dead player and nothing else. It now raises the same
 * error panel as the pipeline, and its retry loads the API again.
 *
 * The watch on the load is its own module with its own specs; here it is a fake
 * whose outcome each test decides.
 */
const player = vi.hoisted(() => ({ current: null as any }));
const api = vi.hoisted(() => ({
    settle: null as null | ((outcome: 'ready' | 'failed') => void),
    retry: null as any,
}));

vi.mock('video.js', () => {
    const videojs: any = vi.fn(() => player.current);
    videojs.browser = { IS_ANY_SAFARI: false };
    videojs.getTech = vi.fn(() => function Youtube() {});
    return { default: videojs };
});
vi.mock('videojs-mobile-ui', () => ({}));
vi.mock('videojs-youtube', () => ({}));
vi.mock('../src/vjs/youtubeApi', () => {
    api.retry = vi.fn();
    return {
        watchYouTubeApi: vi.fn(),
        retryYouTubeApi: api.retry,
        whenYouTubeApiSettles: () =>
            new Promise((resolve) => {
                api.settle = resolve;
            }),
    };
});

import { createInitialState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';
import { DEFAULT_MESSAGES } from '../src/messages';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

const YOUTUBE = { masterUrl: 'https://youtu.be/dQw4w9WgXcQ' };
const HLS = { masterUrl: 'https://cdn.example.com/master.m3u8' };

const fakeController = () =>
    ({
        load: vi.fn(() => Promise.resolve()),
        destroy: vi.fn(),
        getState: () => createInitialState(),
        subscribe: vi.fn(() => () => {}),
    }) as any;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mountPlayer(slots: Record<string, string> = {}) {
    player.current = fakePlayer();
    const wrapper = mount(LuminaryPlayer, {
        props: { source: YOUTUBE, createController: fakeController } as any,
        slots,
    });
    // The YouTube branch awaits the tech's dynamic import before setting a source.
    await settle();
    return wrapper;
}

/** How the API load ends, as the watch would report it. */
async function apiSettles(outcome: 'ready' | 'failed') {
    api.settle!(outcome);
    await settle();
}

beforeEach(() => {
    vi.clearAllMocks();
    api.settle = null;
});

describe('LuminaryPlayer — a YouTube player that cannot load', () => {
    it('shows the error panel, as a network error', async () => {
        const wrapper = await mountPlayer();

        await apiSettles('failed');

        expect(wrapper.find('.lmpl-error .lmpl-panel-text').text()).toBe(DEFAULT_MESSAGES.errorNetwork);
        expect(wrapper.find('.lmpl-retry').exists()).toBe(true);
        wrapper.unmount();
    });

    it('shows nothing while the API loads, nor once it has', async () => {
        const wrapper = await mountPlayer();
        expect(wrapper.find('.lmpl-error').exists()).toBe(false);

        await apiSettles('ready');

        expect(wrapper.find('.lmpl-error').exists()).toBe(false);
        wrapper.unmount();
    });

    it('hands a custom error slot the failure', async () => {
        const wrapper = await mountPlayer({
            error: '<template #error="{ error }"><p class="custom">{{ error.code }}</p></template>',
        });

        await apiSettles('failed');

        expect(wrapper.find('.custom').text()).toBe('network');
        wrapper.unmount();
    });

    it('loads the API again on retry, and clears the panel while it does', async () => {
        const wrapper = await mountPlayer();
        await apiSettles('failed');
        api.retry.mockClear();

        await wrapper.find('.lmpl-retry').trigger('click');
        await settle();

        expect(api.retry).toHaveBeenCalledTimes(1);
        expect(wrapper.find('.lmpl-error').exists()).toBe(false);

        await apiSettles('ready');
        expect(wrapper.find('.lmpl-error').exists()).toBe(false);
        wrapper.unmount();
    });

    it('clears the panel when the host moves on to an HLS source', async () => {
        const wrapper = await mountPlayer();
        await apiSettles('failed');

        await wrapper.setProps({ source: HLS } as any);
        await settle();

        expect(wrapper.find('.lmpl-error').exists()).toBe(false);
        wrapper.unmount();
    });

    it('ignores a failure that arrives after the host has moved on', async () => {
        const wrapper = await mountPlayer();

        await wrapper.setProps({ source: HLS } as any);
        await settle();
        await apiSettles('failed');

        expect(wrapper.find('.lmpl-error').exists()).toBe(false);
        wrapper.unmount();
    });
});
