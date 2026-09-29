// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ThumbnailSpriteCue } from '@luminary-media-converter/player-core';
import FullscreenControls from '../src/components/FullscreenControls.vue';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';
import { createFakeController, messages, createState } from './helpers';

const CUES: ThumbnailSpriteCue[] = [
    {
        startTime: 0,
        endTime: 10,
        spriteUrl: 'https://cdn.example.com/out/sprite_0.jpg',
        x: 0,
        y: 0,
        w: 160,
        h: 90,
    },
    {
        startTime: 10,
        endTime: 20,
        spriteUrl: 'https://cdn.example.com/out/sprite_0.jpg',
        x: 160,
        y: 0,
        w: 160,
        h: 90,
    },
];

/**
 * jsdom gives every element a zero-sized box, and the preview's position is
 * computed from the bar's width — so without this the handler bails and the
 * test would be asserting on a code path no browser takes.
 */
function giveWidth(el: Element, width = 400, left = 0): void {
    (el as HTMLElement).getBoundingClientRect = () =>
        ({ left, width, right: left + width, top: 0, bottom: 18, height: 18, x: left, y: 0 }) as DOMRect;
}

function mountFullscreen(thumbnailsReady: boolean) {
    const controller = createFakeController({
        duration: 20,
        currentTime: 0,
        thumbnailsReady,
    });
    controller.setThumbnails(CUES);
    const wrapper = mount(FullscreenControls, {
        props: { state: controller.getState(), messages: messages(), controller },
    });
    return { wrapper, controller };
}

describe('fullscreen scrub preview', () => {
    it('follows the pointer and shows the frame for that moment', async () => {
        const { wrapper } = mountFullscreen(true);
        const scrub = wrapper.find('.lmp-fs-scrub');
        giveWidth(scrub.element);

        // 75% along a 20s video is 15s, which is the second cue.
        await scrub.trigger('pointermove', { clientX: 300 });

        const frame = wrapper.find('.lmp-thumb-frame');
        expect(frame.exists()).toBe(true);
        expect(frame.attributes('style')).toContain('-160px');
        // The label says where the drag would land, not where playback is.
        expect(wrapper.find('.lmp-thumb-time').text()).toBe('0:15');
    });

    it('hides again when the pointer leaves', async () => {
        const { wrapper } = mountFullscreen(true);
        const scrub = wrapper.find('.lmp-fs-scrub');
        giveWidth(scrub.element);
        await scrub.trigger('pointermove', { clientX: 100 });
        expect(wrapper.find('.lmp-thumb').exists()).toBe(true);

        await scrub.trigger('pointerleave');

        expect(wrapper.find('.lmp-thumb').exists()).toBe(false);
    });

    it('shows nothing when the source has no sidecar', async () => {
        // Audio-only encodes and `thumbnails: false` sessions: the scrubber must
        // work exactly as before, with no empty box following the pointer.
        const { wrapper } = mountFullscreen(false);
        const scrub = wrapper.find('.lmp-fs-scrub');
        giveWidth(scrub.element);

        await scrub.trigger('pointermove', { clientX: 200 });

        expect(wrapper.find('.lmp-thumb').exists()).toBe(false);
    });

    it('clamps to the bar at either end', async () => {
        const { wrapper } = mountFullscreen(true);
        const scrub = wrapper.find('.lmp-fs-scrub');
        giveWidth(scrub.element);

        // Past the right-hand end: the last frame, not undefined.
        await scrub.trigger('pointermove', { clientX: 9999 });
        expect(wrapper.find('.lmp-thumb-time').text()).toBe('0:20');

        // Before the left-hand end.
        await scrub.trigger('pointermove', { clientX: -50 });
        expect(wrapper.find('.lmp-thumb-time').text()).toBe('0:00');
    });
});

describe('windowed scrub preview', () => {
    function mountPlayer(props: Record<string, unknown>) {
        const controller = createFakeController({ thumbnailsReady: true, duration: 20 });
        controller.setThumbnails(CUES);
        const wrapper = mount(LuminaryPlayer, {
            props: {
                source: { masterUrl: 'https://cdn.example.com/out/master.m3u8' },
                createController: () => controller,
                ...props,
            },
        });
        return { wrapper, controller };
    }

    it('draws nothing unless a host asks', () => {
        /*
         * The rule this protects: outside fullscreen the player draws no chrome
         * over the picture, which is what lets the encoder put its controls
         * beside the frame. A preview that appeared on its own would break that
         * for every consumer at once.
         */
        const { wrapper } = mountPlayer({});

        expect(wrapper.find('.lmp-windowed-preview').exists()).toBe(false);
    });

    it('draws the frame for the time the host names', async () => {
        const { wrapper } = mountPlayer({ previewTime: 15 });
        await wrapper.vm.$nextTick();

        const preview = wrapper.find('.lmp-windowed-preview');
        expect(preview.exists()).toBe(true);
        expect(preview.find('.lmp-thumb-frame').attributes('style')).toContain(
            '-160px',
        );
    });

    it('draws nothing for a source without thumbnails, even when asked', async () => {
        const controller = createFakeController({ thumbnailsReady: false });
        const wrapper = mount(LuminaryPlayer, {
            props: {
                source: { masterUrl: 'https://cdn.example.com/out/master.m3u8' },
                createController: () => controller,
                previewTime: 5,
            },
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.find('.lmp-windowed-preview').exists()).toBe(false);
    });

    it('ignores a nonsense time rather than drawing the first frame', async () => {
        const { wrapper } = mountPlayer({ previewTime: Number.NaN });
        await wrapper.vm.$nextTick();

        expect(wrapper.find('.lmp-windowed-preview').exists()).toBe(false);
    });
});
