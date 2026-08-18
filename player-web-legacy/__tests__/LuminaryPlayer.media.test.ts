import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * The media surface, tested where it matters: **YouTube mode**.
 *
 * In LMC mode a host could read the position off the controller. In YouTube
 * mode there is no controller — so if these events do not fire, a host that
 * saves a resume point has nothing at all, and the failure is silent. Hence a
 * component mount rather than a unit test of a handler: what is being pinned is
 * that the subscriptions survive the mode that destroys everything else.
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

import { createInitialState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

/**
 * A controller that resolves instead of reaching for the network. The component
 * takes one through its `createController` seam; the media surface is deliberately
 * independent of it, and this is how that gets to be shown rather than asserted.
 */
const fakeController = () =>
    ({
        load: vi.fn(() => Promise.resolve()),
        destroy: vi.fn(),
        getState: () => createInitialState(),
        subscribe: vi.fn(() => () => {}),
    }) as any;

const YOUTUBE = { masterUrl: 'https://youtu.be/dQw4w9WgXcQ' };

async function mountPlayer(source: Record<string, unknown> = YOUTUBE) {
    player.current = fakePlayer();
    const wrapper = mount(LuminaryPlayer, { props: { source } as any });
    // The YouTube branch awaits a dynamic import before the source is set.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

// jsdom implements neither, and the keep-alive <audio> element uses both on
// unmount. A jsdom gap, not behaviour worth asserting.
HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

beforeEach(() => vi.clearAllMocks());

describe('LuminaryPlayer media surface, in YouTube mode', () => {
    it('has no controller to report through — which is why the events exist', async () => {
        const wrapper = await mountPlayer();
        expect((wrapper.vm as any).controller).toBeNull();
        wrapper.unmount();
    });

    it('emits the position as it advances', async () => {
        const wrapper = await mountPlayer();
        player.current._time = 42;

        player.current.fire('timeupdate');

        expect(wrapper.emitted('timeupdate')?.[0]).toEqual([42, 120]);
        wrapper.unmount();
    });

    it('reports a live stream as an infinite duration rather than hiding it', async () => {
        // A host saving a resume point has to tell "live" from "not known yet".
        const wrapper = await mountPlayer();
        player.current.duration = vi.fn(() => Infinity);

        player.current.fire('timeupdate');

        expect(wrapper.emitted('timeupdate')?.[0]?.[1]).toBe(Infinity);
        wrapper.unmount();
    });

    it('reads an unknown time as 0 rather than NaN', async () => {
        const wrapper = await mountPlayer();
        player.current.currentTime = vi.fn(() => undefined);
        player.current.duration = vi.fn(() => undefined);

        player.current.fire('timeupdate');

        expect(wrapper.emitted('timeupdate')?.[0]).toEqual([0, 0]);
        wrapper.unmount();
    });

    it('emits loadedmetadata, the earliest point a saved position can be restored', async () => {
        const wrapper = await mountPlayer();

        player.current.fire('loadedmetadata');

        expect(wrapper.emitted('loadedmetadata')).toHaveLength(1);
        wrapper.unmount();
    });

    it('emits ended', async () => {
        const wrapper = await mountPlayer();

        player.current.fire('ended');

        expect(wrapper.emitted('ended')).toHaveLength(1);
        wrapper.unmount();
    });

    it('seeks to a saved position', async () => {
        const wrapper = await mountPlayer();

        (wrapper.vm as any).seek(90);

        expect(player.current.currentTime).toHaveBeenCalledWith(90);
        wrapper.unmount();
    });

    it('drops a seek to a time that is not a time', async () => {
        // NaN strands the element with no way back; video.js clamps a real
        // out-of-range number itself, so only the unreal ones are refused.
        const wrapper = await mountPlayer();

        (wrapper.vm as any).seek(NaN);
        (wrapper.vm as any).seek(-5);
        (wrapper.vm as any).seek(Infinity);

        expect(player.current.currentTime).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

describe('LuminaryPlayer media surface, on an LMC source', () => {
    it('emits the same events, so a host needs one code path', async () => {
        player.current = fakePlayer();
        const wrapper = mount(LuminaryPlayer, {
            props: {
                source: { masterUrl: 'https://cdn.example.com/media/abc/master.m3u8' },
                createController: fakeController,
            } as any,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        player.current._time = 7;

        player.current.fire('timeupdate');
        player.current.fire('ended');

        expect(wrapper.emitted('timeupdate')?.[0]).toEqual([7, 120]);
        expect(wrapper.emitted('ended')).toHaveLength(1);
        wrapper.unmount();
    });
});
