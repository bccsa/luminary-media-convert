import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * Audio-only has to be told to the engine as well as to the pipeline.
 *
 * Switching to the audio-only angle decides what is played. It says nothing
 * about what is drawn — and a video.js that has not been told will keep the
 * `<video>` element laid out, painting its own surface over the host's artwork.
 * These pin the half that is easy to forget, because forgetting it is exactly
 * what happened.
 */
const player = vi.hoisted(() => ({ current: null as any }));
const controllerState = vi.hoisted(() => ({ listeners: [] as ((s: any) => void)[] }));

vi.mock('video.js', () => {
    const videojs: any = vi.fn(() => player.current);
    videojs.browser = { IS_ANY_SAFARI: false };
    videojs.getTech = vi.fn(() => function Youtube() {});
    return { default: videojs };
});
vi.mock('videojs-mobile-ui', () => ({}));
vi.mock('videojs-youtube', () => ({}));

import { AUDIO_ONLY_ANGLE_ID, createInitialState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        ...createInitialState(),
        lifecycle: 'ready',
        angles: [
            { id: 'cam1', name: 'Camera 1', isDefault: true },
            { id: AUDIO_ONLY_ANGLE_ID, name: 'Audio only', isDefault: false },
        ],
        activeAngleId: 'cam1',
        ...overrides,
    };
}

let current: any;

const fakeController = () => ({
    load: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    getState: () => current,
    subscribe: vi.fn((listener: (s: any) => void) => {
        controllerState.listeners.push(listener);
        return () => {};
    }),
});

/** Pushes a new controller snapshot, as the real controller would. */
async function publish(next: any) {
    current = next;
    controllerState.listeners.forEach((listener) => listener(next));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountPlayer() {
    player.current = fakePlayer();
    controllerState.listeners = [];
    current = snapshot();
    const wrapper = mount(LuminaryPlayer, {
        props: {
            source: { masterUrl: 'https://cdn/master.m3u8' },
            createController: fakeController,
        } as any,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

beforeEach(() => vi.clearAllMocks());

describe('audio-only', () => {
    it('hides the picture when the audio-only angle is selected', async () => {
        // Without this the <video> stays laid out and paints its own surface
        // over the artwork, sized to the stream rather than to the frame.
        const wrapper = await mountPlayer();

        await publish(snapshot({ activeAngleId: AUDIO_ONLY_ANGLE_ID }));

        expect(player.current.audioOnlyMode).toHaveBeenCalledWith(true);
        expect(player.current.audioPosterMode).toHaveBeenCalledWith(true);
        wrapper.unmount();
    });

    it("accepts the controller's own audio-only flag as well as the angle id", async () => {
        // A natively audio-only stream reports the flag without the pseudo-angle
        // ever being selected.
        const wrapper = await mountPlayer();

        await publish(snapshot({ isAudioOnly: true }));

        expect(player.current.audioOnlyMode).toHaveBeenCalledWith(true);
        wrapper.unmount();
    });

    it('brings the picture back on the way out', async () => {
        const wrapper = await mountPlayer();

        await publish(snapshot({ activeAngleId: AUDIO_ONLY_ANGLE_ID }));
        vi.clearAllMocks();
        await publish(snapshot({ activeAngleId: 'cam1' }));

        expect(player.current.audioOnlyMode).toHaveBeenCalledWith(false);
        expect(player.current.audioPosterMode).toHaveBeenCalledWith(false);
        wrapper.unmount();
    });

    it('does not touch the engine while nothing has changed', async () => {
        // Re-asserting the mode on every state tick would fight video.js, which
        // does real layout work in these calls.
        const wrapper = await mountPlayer();

        await publish(snapshot({ playing: true }));
        await publish(snapshot({ playing: false }));

        expect(player.current.audioOnlyMode).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('survives an engine that rejects the call', async () => {
        // video.js rejects these before the player is ready; the next state
        // change asks again.
        const wrapper = await mountPlayer();
        player.current.audioOnlyMode = vi.fn(() => Promise.reject(new Error('not ready')));

        await expect(publish(snapshot({ activeAngleId: AUDIO_ONLY_ANGLE_ID }))).resolves.toBeUndefined();
        wrapper.unmount();
    });
});
