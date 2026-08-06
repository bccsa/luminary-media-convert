import { describe, expect, it, vi } from 'vitest';

/**
 * `PlayerController` is Lane B's concrete class; this suite only needs the
 * import to resolve, because every test injects a fake through the internal
 * `createController` seam. Mocking it here (rather than stubbing it in `src/`)
 * keeps the shipped package free of test scaffolding.
 */
vi.mock('@luminary-media-converter/player-core', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        PlayerController: class PlayerControllerStub {},
    };
});

import { flushPromises, mount } from '@vue/test-utils';
import type { PlayerSource, PlayerState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';
import { createFakeController, type FakeController } from './helpers';

const source: PlayerSource = { masterUrl: 'https://cdn.test/master.m3u8' };

function mountPlayer(options: {
    state?: Partial<PlayerState>;
    props?: Record<string, unknown>;
    slots?: Record<string, string>;
} = {}) {
    const controller = createFakeController(options.state ?? {});
    const createController = vi.fn((_video: HTMLVideoElement) => controller as FakeController);
    const wrapper = mount(LuminaryPlayer, {
        props: { source, createController, ...options.props },
        slots: options.slots,
    });
    return { wrapper, controller, createController };
}

describe('LuminaryPlayer — lifecycle', () => {
    it('builds a controller around the mounted video element and loads the source', () => {
        const { wrapper, controller, createController } = mountPlayer();

        const video = wrapper.get('video').element;
        expect(video.hasAttribute('playsinline')).toBe(true);
        expect(createController).toHaveBeenCalledWith(video);
        expect(controller.load).toHaveBeenCalledWith(source);
    });

    it('reloads when the source prop changes', async () => {
        const { wrapper, controller } = mountPlayer();
        const next: PlayerSource = { masterUrl: 'https://cdn.test/other.m3u8' };

        await wrapper.setProps({ source: next });

        expect(controller.load).toHaveBeenLastCalledWith(next);
    });

    it('destroys the controller on unmount', () => {
        const { wrapper, controller } = mountPlayer();
        wrapper.unmount();
        expect(controller.destroy).toHaveBeenCalledTimes(1);
    });

    it('exposes the controller', () => {
        const { wrapper, controller } = mountPlayer();
        expect((wrapper.vm as unknown as { controller: unknown }).controller).toBe(controller);
    });
});

describe('LuminaryPlayer — coming soon', () => {
    it('renders the default panel while waiting for the master', async () => {
        const { wrapper, controller } = mountPlayer();
        expect(wrapper.find('.lmp-coming-soon').exists()).toBe(false);

        controller.setState({ lifecycle: 'waiting-for-master' });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.lmp-coming-soon').text()).toBe('Coming soon');
    });

    it('uses the messages prop for the default panel', async () => {
        const { wrapper, controller } = mountPlayer({
            props: { messages: { comingSoon: 'Bientôt disponible' } },
        });

        controller.setState({ lifecycle: 'waiting-for-master' });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.lmp-coming-soon').text()).toBe('Bientôt disponible');
    });

    it('lets the host replace the panel through the scoped slot', async () => {
        const { wrapper, controller } = mountPlayer({
            slots: { 'coming-soon': '<p class="host-soon">{{ params.state.lifecycle }}</p>' },
        });

        controller.setState({ lifecycle: 'waiting-for-master' });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.host-soon').text()).toBe('waiting-for-master');
        expect(wrapper.find('.lmp-coming-soon').exists()).toBe(false);
    });
});

describe('LuminaryPlayer — errors', () => {
    it('renders the generic message for unmapped codes', async () => {
        const { wrapper, controller } = mountPlayer();

        controller.setState({
            lifecycle: 'error',
            error: { code: 'unknown', fatal: true, message: 'boom' },
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.lmp-error').text()).toContain('This video could not be played.');
    });

    it('keys the message on the error code', async () => {
        const { wrapper, controller } = mountPlayer({
            props: { messages: { errorUnsupportedBrowser: 'No dice on this browser' } },
        });

        controller.setState({
            lifecycle: 'error',
            error: { code: 'unsupported-browser', fatal: true, message: 'no MSE' },
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.lmp-error').text()).toContain('No dice on this browser');
    });

    it('retries by loading the same source again', async () => {
        const { wrapper, controller } = mountPlayer();
        controller.setState({
            lifecycle: 'error',
            error: { code: 'network', fatal: true, message: 'offline' },
        });
        await wrapper.vm.$nextTick();

        await wrapper.get('.lmp-retry').trigger('click');

        expect(controller.load).toHaveBeenCalledTimes(2);
        expect(controller.load).toHaveBeenLastCalledWith(source);
    });

    it('lets the host replace the error surface through the scoped slot', async () => {
        const { wrapper, controller } = mountPlayer({
            slots: { error: '<p class="host-error">{{ params.error.code }}</p>' },
        });

        controller.setState({
            lifecycle: 'error',
            error: { code: 'key-required', fatal: true, message: 'no key' },
        });
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.host-error').text()).toBe('key-required');
        expect(wrapper.find('.lmp-error').exists()).toBe(false);
    });
});

describe('LuminaryPlayer — fullscreen', () => {
    it('offers a fullscreen affordance labelled from messages and no controls inline', () => {
        const { wrapper } = mountPlayer({
            props: { messages: { enterFullscreen: 'Plein écran' } },
        });

        expect(wrapper.get('.lmp-enter-fs').attributes('aria-label')).toBe('Plein écran');
        expect(wrapper.find('.lmp-fs').exists()).toBe(false);
    });

    it('mounts the custom controls only for element fullscreen', async () => {
        const { wrapper } = mountPlayer({ state: { playing: false } });
        const container = wrapper.get('.lmp-root').element as HTMLElement;
        // jsdom implements no fullscreen API — provide the browser surface.
        document.exitFullscreen = vi.fn(async () => {});
        container.requestFullscreen = vi.fn(async () => {
            Object.defineProperty(document, 'fullscreenElement', {
                value: container,
                configurable: true,
            });
            document.dispatchEvent(new Event('fullscreenchange'));
        });

        await wrapper.get('.lmp-enter-fs').trigger('click');
        await flushPromises();

        expect(wrapper.find('.lmp-fs').exists()).toBe(true);
        expect(wrapper.find('.lmp-enter-fs').exists()).toBe(false);

        Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    });

    it('never mounts the custom controls in platform-native fullscreen', async () => {
        const { wrapper } = mountPlayer();
        const container = wrapper.get('.lmp-root').element as HTMLElement;
        Object.defineProperty(container, 'requestFullscreen', {
            value: undefined,
            configurable: true,
        });
        const video = wrapper.get('video').element as HTMLVideoElement & {
            webkitEnterFullscreen?: () => void;
        };
        video.webkitEnterFullscreen = vi.fn();

        await wrapper.get('.lmp-enter-fs').trigger('click');
        await flushPromises();

        expect(video.webkitEnterFullscreen).toHaveBeenCalled();
        expect(wrapper.find('.lmp-fs').exists()).toBe(false);
    });
});
