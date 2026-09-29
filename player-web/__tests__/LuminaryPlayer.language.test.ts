import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakePlayer } from './helpers';

/**
 * The preferred audio language, applied over a controller whose track list
 * changes under it the way the real one's does: the master's tracks on load,
 * then the engine's once VHS has built them — each published with the
 * controller's own pick of the first track.
 *
 * Neither pick is anybody overruling the preference, but the watcher that
 * notices a viewer's choice used to count them, and suspended the preference on
 * every load before it had applied once. It only ever worked when the preferred
 * language happened to be the stream's first track.
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

import { createInitialState } from '@luminary-media-converter/player-core';
import LuminaryPlayer from '../src/components/LuminaryPlayer.vue';

HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
HTMLMediaElement.prototype.pause = vi.fn();

/** The master's tracks, as the controller lists them before the engine has any. */
const MASTER_TRACKS = [
    { id: 'a:group_hd:Untranslated', lang: 'mul', label: 'Untranslated' },
    { id: 'a:group_hd:English', lang: 'eng', label: 'English' },
    { id: 'a:group_hd:Français', lang: 'fra', label: 'Français' },
];

/** The same tracks once VHS has built its own list, under its own ids. */
const ENGINE_TRACKS = [
    { id: 'Untranslated', lang: 'mul', label: 'Untranslated' },
    { id: 'English', lang: 'eng', label: 'English' },
    { id: 'Français', lang: 'fra', label: 'Français' },
];

let current: any;
let controller: any;

/** Publishes a snapshot at once, as the real store does. */
function notify(next: any) {
    current = next;
    controllerState.listeners.forEach((listener) => listener(next));
}

/** Lets the component's watchers and its awaited load run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A track list published the way the controller publishes one: a new array,
 * with its own pick of the first track as the active one.
 */
async function publishList(tracks: typeof MASTER_TRACKS) {
    notify({ ...current, audioTracks: [...tracks], activeAudioTrackId: tracks[0]!.id });
    await settle();
}

const fakeController = () => {
    controller = {
        // As the real one does: a load starts from a reset store.
        load: vi.fn(() => {
            notify({ ...createInitialState(), lifecycle: 'loading' });
            return Promise.resolve();
        }),
        destroy: vi.fn(),
        getState: () => current,
        subscribe: vi.fn((listener: (s: any) => void) => {
            controllerState.listeners.push(listener);
            return () => {};
        }),
        // A selection moves the active track and leaves the list as it was.
        setAudioTrack: vi.fn((id: string) => notify({ ...current, activeAudioTrackId: id })),
    };
    return controller;
};

async function mountPlayer(preferredLanguage: string) {
    player.current = fakePlayer();
    controllerState.listeners = [];
    current = createInitialState();
    const wrapper = mount(LuminaryPlayer, {
        props: {
            source: { masterUrl: 'https://cdn/master.m3u8' },
            preferredLanguage,
            createController: fakeController,
        } as any,
    });
    await settle();
    return wrapper;
}

/** A viewer's pick from the video.js menu, as the component relays it. */
async function viewerPicks(id: string) {
    controller.setAudioTrack(id);
    await settle();
    controller.setAudioTrack.mockClear();
}

beforeEach(() => vi.clearAllMocks());

describe('preferred audio language', () => {
    it("applies on load when it is not the stream's first track", async () => {
        const wrapper = await mountPlayer('fr');

        await publishList(MASTER_TRACKS);

        expect(controller.setAudioTrack).toHaveBeenLastCalledWith('a:group_hd:Français');
        wrapper.unmount();
    });

    it("applies again once the engine's own list replaces the master's", async () => {
        const wrapper = await mountPlayer('fr');
        await publishList(MASTER_TRACKS);

        await publishList(ENGINE_TRACKS);

        expect(controller.setAudioTrack).toHaveBeenLastCalledWith('Français');
        expect(current.activeAudioTrackId).toBe('Français');
        wrapper.unmount();
    });

    it('gives way to a viewer across the moments it is re-applied', async () => {
        const wrapper = await mountPlayer('fr');
        await publishList(ENGINE_TRACKS);

        await viewerPicks('English');
        player.current.fire('loadeddata');
        player.current.fire('fullscreenchange');
        await settle();

        expect(controller.setAudioTrack).not.toHaveBeenCalled();
        expect(current.activeAudioTrackId).toBe('English');
        wrapper.unmount();
    });

    it('applies again on a new source, whatever the viewer chose on the last', async () => {
        const wrapper = await mountPlayer('fr');
        await publishList(ENGINE_TRACKS);
        await viewerPicks('English');

        await wrapper.setProps({ source: { masterUrl: 'https://cdn/next.m3u8' } } as any);
        await settle();
        await publishList(ENGINE_TRACKS);

        expect(controller.setAudioTrack).toHaveBeenLastCalledWith('Français');
        wrapper.unmount();
    });

    it('applies a new preference, whatever the viewer chose under the old one', async () => {
        const wrapper = await mountPlayer('fr');
        await publishList(ENGINE_TRACKS);
        await viewerPicks('Untranslated');

        await wrapper.setProps({ preferredLanguage: 'en' } as any);
        await settle();

        expect(controller.setAudioTrack).toHaveBeenLastCalledWith('English');
        wrapper.unmount();
    });
});
