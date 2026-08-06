import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FullscreenControls from '../src/components/FullscreenControls.vue';
import type { PlayerState } from '@luminary-media-converter/player-core';
import type { PlayerMessages } from '../src/messages';
import { createFakeController, createState, messages, type FakeController } from './helpers';

function mountControls(
    state: Partial<PlayerState> = {},
    overrides: Partial<PlayerMessages> = {},
): { wrapper: ReturnType<typeof mount>; controller: FakeController } {
    const controller = createFakeController();
    const wrapper = mount(FullscreenControls, {
        props: { state: createState(state), messages: messages(overrides), controller },
    });
    return { wrapper, controller };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('FullscreenControls — transport', () => {
    it('toggles playback through the controller', async () => {
        const { wrapper, controller } = mountControls({ playing: false });

        await wrapper.get('.lmp-fs-play').trigger('click');

        expect(controller.togglePlay).toHaveBeenCalledTimes(1);
    });

    it('labels the play button from messages and follows the play state', async () => {
        const { wrapper } = mountControls({ playing: false }, { play: 'Lire', pause: 'Pause it' });
        expect(wrapper.get('.lmp-fs-play').attributes('aria-label')).toBe('Lire');

        await wrapper.setProps({ state: createState({ playing: true }) });
        expect(wrapper.get('.lmp-fs-play').attributes('aria-label')).toBe('Pause it');
    });

    it('seeks from the scrubber and renders elapsed / remaining times', async () => {
        const { wrapper, controller } = mountControls({ currentTime: 65, duration: 130 });

        const scrubber = wrapper.get('.lmp-fs-scrubber');
        expect((scrubber.element as HTMLInputElement).max).toBe('130');

        (scrubber.element as HTMLInputElement).value = '42';
        await scrubber.trigger('input');
        expect(controller.seek).toHaveBeenCalledWith(42);

        const times = wrapper.findAll('.lmp-fs-time').map((el) => el.text());
        expect(times).toEqual(['1:05', '-1:05']);
    });

    it('formats past the hour', () => {
        const { wrapper } = mountControls({ currentTime: 3725, duration: 7200 });
        expect(wrapper.findAll('.lmp-fs-time')[0]?.text()).toBe('1:02:05');
    });

    it('emits exit rather than exiting fullscreen itself', async () => {
        const { wrapper } = mountControls();
        await wrapper.get('.lmp-fs-exit').trigger('click');
        expect(wrapper.emitted('exit')).toHaveLength(1);
    });
});

describe('FullscreenControls — track menus', () => {
    it('hides the audio menu unless there is a choice', () => {
        const single = mountControls({
            audioTracks: [{ id: '0', label: 'English', lang: 'en' }],
        });
        expect(single.wrapper.find('.lmp-fs-audio').exists()).toBe(false);

        const many = mountControls({
            audioTracks: [
                { id: '0', label: 'English', lang: 'en' },
                { id: '1', label: 'Français', lang: 'fr' },
            ],
            activeAudioTrackId: '0',
        });
        expect(many.wrapper.find('.lmp-fs-audio').exists()).toBe(true);
    });

    it('switches the audio track through the controller', async () => {
        const { wrapper, controller } = mountControls({
            audioTracks: [
                { id: '0', label: 'English' },
                { id: '1', label: 'Français' },
            ],
            activeAudioTrackId: '0',
        });

        await wrapper.get('.lmp-fs-audio').setValue('1');

        expect(controller.setAudioTrack).toHaveBeenCalledWith('1');
    });

    it('offers an off entry for subtitles and maps it to null', async () => {
        const { wrapper, controller } = mountControls(
            { subtitleTracks: [{ id: 'en', label: 'English', source: 'sidecar' }] },
            { subtitlesOff: 'None' },
        );

        const select = wrapper.get('.lmp-fs-subtitles');
        const options = select.findAll('option').map((el) => el.text());
        expect(options).toEqual(['None', 'English']);

        await select.setValue('en');
        expect(controller.setSubtitleTrack).toHaveBeenCalledWith('en');

        await select.setValue('');
        expect(controller.setSubtitleTrack).toHaveBeenLastCalledWith(null);
    });

    it('hides the subtitles menu when there are no tracks', () => {
        const { wrapper } = mountControls();
        expect(wrapper.find('.lmp-fs-subtitles').exists()).toBe(false);
    });
});

describe('FullscreenControls — auto-hide', () => {
    it('hides after inactivity while playing and returns on pointer movement', async () => {
        vi.useFakeTimers();
        const { wrapper } = mountControls({ playing: true });
        const overlay = wrapper.get('.lmp-fs');

        expect(overlay.classes()).not.toContain('lmp-fs-hidden');

        vi.advanceTimersByTime(3000);
        await wrapper.vm.$nextTick();
        expect(overlay.classes()).toContain('lmp-fs-hidden');

        await overlay.trigger('pointermove');
        expect(overlay.classes()).not.toContain('lmp-fs-hidden');

        vi.advanceTimersByTime(3000);
        await wrapper.vm.$nextTick();
        expect(overlay.classes()).toContain('lmp-fs-hidden');
    });

    it('never hides while paused', async () => {
        vi.useFakeTimers();
        const { wrapper } = mountControls({ playing: false });

        vi.advanceTimersByTime(60_000);
        await wrapper.vm.$nextTick();

        expect(wrapper.get('.lmp-fs').classes()).not.toContain('lmp-fs-hidden');
    });

    it('reappears when playback pauses', async () => {
        vi.useFakeTimers();
        const { wrapper } = mountControls({ playing: true });
        vi.advanceTimersByTime(3000);
        await wrapper.vm.$nextTick();
        expect(wrapper.get('.lmp-fs').classes()).toContain('lmp-fs-hidden');

        await wrapper.setProps({ state: createState({ playing: false }) });

        expect(wrapper.get('.lmp-fs').classes()).not.toContain('lmp-fs-hidden');
    });
});

describe('FullscreenControls — localization', () => {
    it('takes every visible and aria string from the messages map', () => {
        const { wrapper } = mountControls(
            {
                subtitleTracks: [{ id: 'en', label: 'English', source: 'master' }],
                audioTracks: [
                    { id: '0', label: 'English' },
                    { id: '1', label: 'Français' },
                ],
            },
            {
                scrubberLabel: 'Recherche',
                elapsedLabel: 'Écoulé',
                remainingLabel: 'Restant',
                exitFullscreen: 'Quitter',
                audioMenuLabel: 'Audio FR',
                subtitlesMenuLabel: 'Sous-titres',
                subtitlesOff: 'Aucun',
            },
        );

        expect(wrapper.get('.lmp-fs-scrubber').attributes('aria-label')).toBe('Recherche');
        expect(wrapper.findAll('.lmp-fs-time')[0]?.attributes('aria-label')).toBe('Écoulé');
        expect(wrapper.findAll('.lmp-fs-time')[1]?.attributes('aria-label')).toBe('Restant');
        expect(wrapper.get('.lmp-fs-exit').attributes('aria-label')).toBe('Quitter');
        expect(wrapper.get('.lmp-fs-audio').attributes('aria-label')).toBe('Audio FR');
        expect(wrapper.get('.lmp-fs-subtitles').attributes('aria-label')).toBe('Sous-titres');
        expect(wrapper.get('.lmp-fs-subtitles option').text()).toBe('Aucun');
    });
});
