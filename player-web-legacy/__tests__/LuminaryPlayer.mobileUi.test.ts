import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * videojs-mobile-ui's own `fullscreenchange` listener calls
 * `screen.orientation.lock('landscape')` with no feature detection (unlike its
 * `rotationHandler`, which does), so it throws on iOS Safari — the browser
 * implements `screen.orientation` but never shipped `.lock()`. LuminaryPlayer
 * stubs a rejecting `lock()` before handing control to the plugin so that call
 * fails the same way a real orientation-lock refusal would, instead of crashing.
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

async function mountPlayer(mobileUi = vi.fn()) {
    player.current = fakePlayer({ mobileUi });
    const wrapper = mount(LuminaryPlayer, {
        props: { source: { masterUrl: 'https://cdn/master.m3u8' } } as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

const originalOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');

afterEach(() => {
    if (originalOrientation) Object.defineProperty(screen, 'orientation', originalOrientation);
});

describe('LuminaryPlayer — mobile-ui orientation lock (iOS Safari has no screen.orientation.lock)', () => {
    beforeEach(() => {
        Object.defineProperty(screen, 'orientation', { value: {}, configurable: true });
    });

    it('stubs a rejecting lock() instead of leaving it undefined', async () => {
        const wrapper = await mountPlayer();

        expect(typeof screen.orientation.lock).toBe('function');
        await expect(screen.orientation.lock('landscape')).rejects.toThrow();
        wrapper.unmount();
    });

    it('still hands mobile-ui the same fullscreen/rotation options', async () => {
        const mobileUi = vi.fn();
        const wrapper = await mountPlayer(mobileUi);

        expect(mobileUi).toHaveBeenCalledWith(
            expect.objectContaining({
                fullscreen: expect.objectContaining({
                    lockOnRotate: true,
                    lockToLandscapeOnEnter: true,
                }),
            }),
        );
        wrapper.unmount();
    });

    it('leaves a real lock() (Android/Chrome) untouched', async () => {
        const realLock = vi.fn(() => Promise.resolve());
        Object.defineProperty(screen, 'orientation', { value: { lock: realLock }, configurable: true });

        const wrapper = await mountPlayer();

        expect(screen.orientation.lock).toBe(realLock);
        wrapper.unmount();
    });
});
