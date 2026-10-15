import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FullscreenControls from '../src/components/FullscreenControls.vue';
import type { PlayerState } from '@luminary-media-converter/player-core';
import type { PlayerMessages } from '../src/messages';
import type { PlayerControlsOptions } from '../src/controls';
import { createFakeController, createState, messages, type FakeController } from './helpers';

function mountControls(
    state: Partial<PlayerState> = {},
    overrides: Partial<PlayerMessages> = {},
    controls?: Partial<PlayerControlsOptions>,
): { wrapper: ReturnType<typeof mount>; controller: FakeController } {
    const controller = createFakeController();
    const wrapper = mount(FullscreenControls, {
        props: { state: createState(state), messages: messages(overrides), controller, controls },
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

        // The far end is the whole length, not what is left — a fixed point to
        // read progress against, which does not move as the video plays.
        const times = wrapper.findAll('.lmp-fs-time').map((el) => el.text());
        expect(times).toEqual(['1:05', '2:10']);
    });

    it('gives both readouts the hours field when the video is over an hour', () => {
        const { wrapper } = mountControls({ currentTime: 3725, duration: 7200 });
        expect(wrapper.findAll('.lmp-fs-time').map((el) => el.text())).toEqual([
            '1:02:05',
            '2:00:00',
        ]);
    });

    it('keeps both readouts short when the video is not', () => {
        // 8:03 into an hour-long video reads 0:08:03; 8:03 into a short one
        // does not gain an empty hours field it will never use.
        const { wrapper } = mountControls({ currentTime: 483, duration: 600 });
        expect(wrapper.findAll('.lmp-fs-time').map((el) => el.text())).toEqual([
            '8:03',
            '10:00',
        ]);
    });

    it('sizes the played and buffered bands', () => {
        const { wrapper } = mountControls({
            currentTime: 30,
            duration: 120,
            bufferedEnd: 60,
        });

        // Ratios, not percentages: the bands are measured against the run the
        // handle travels, which is a thumb-width short of the full track.
        const style = wrapper.get('.lmp-fs-scrub').attributes('style');
        expect(style).toContain('--lmp-progress: 0.25');
        expect(style).toContain('--lmp-buffered: 0.5');
    });

    it('never draws the buffered band behind the playhead', () => {
        // Between a seek and the first fill, buffered sits behind where we are.
        // Drawing that literally would put a gap in front of the handle.
        const { wrapper } = mountControls({
            currentTime: 90,
            duration: 120,
            bufferedEnd: 10,
        });
        const style = wrapper.get('.lmp-fs-scrub').attributes('style');
        expect(style).toContain('--lmp-progress: 0.75');
        expect(style).toContain('--lmp-buffered: 0.75');
    });

    it('sizes nothing before the duration is known', () => {
        const { wrapper } = mountControls({
            currentTime: 5,
            duration: 0,
            bufferedEnd: 20,
        });
        const style = wrapper.get('.lmp-fs-scrub').attributes('style');
        expect(style).toContain('--lmp-progress: 0');
        expect(style).toContain('--lmp-buffered: 0');
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

    it('drops the audio menu when the host asks it to', () => {
        // player-web is published: a consumer's viewers need this menu, so a
        // host that has its own selectors opts out rather than the library
        // losing it.
        const state = {
            audioTracks: [
                { id: '0', label: 'English' },
                { id: '1', label: 'Français' },
            ],
        };

        expect(mountControls(state).wrapper.find('.lmp-fs-audio').exists()).toBe(true);
        expect(
            mountControls(state, {}, { audioMenu: false }).wrapper.find('.lmp-fs-audio').exists(),
        ).toBe(false);
    });

    it('leaves the subtitles menu alone when the audio menu is dropped', () => {
        const { wrapper } = mountControls(
            {
                audioTracks: [
                    { id: '0', label: 'English' },
                    { id: '1', label: 'Français' },
                ],
                subtitleTracks: [{ id: 'en', label: 'English', source: 'master' }],
            },
            {},
            { audioMenu: false },
        );

        expect(wrapper.find('.lmp-fs-subtitles').exists()).toBe(true);
    });
});

describe('FullscreenControls — skip buttons', () => {
    const MIDWAY = { currentTime: 60, duration: 600 };

    it('skips by the default interval in both directions', async () => {
        const { wrapper, controller } = mountControls(MIDWAY);

        await wrapper.get('.lmp-fs-skip-back').trigger('click');
        expect(controller.seek).toHaveBeenCalledWith(45);

        await wrapper.get('.lmp-fs-skip-forward').trigger('click');
        expect(controller.seek).toHaveBeenCalledWith(75);
    });

    it('honours separate back and forward intervals', async () => {
        const { wrapper, controller } = mountControls(MIDWAY, {}, {
            skipBackSeconds: 10,
            skipForwardSeconds: 30,
        });

        await wrapper.get('.lmp-fs-skip-back').trigger('click');
        expect(controller.seek).toHaveBeenCalledWith(50);

        await wrapper.get('.lmp-fs-skip-forward').trigger('click');
        expect(controller.seek).toHaveBeenCalledWith(90);
    });

    it('clamps at the start rather than seeking negative', async () => {
        const { wrapper, controller } = mountControls({ currentTime: 4, duration: 600 });

        await wrapper.get('.lmp-fs-skip-back').trigger('click');
        expect(controller.seek).toHaveBeenCalledWith(0);
    });

    it('stops short of the end, so skipping forward never finishes the video', async () => {
        // Landing exactly on `duration` fires `ended` — "a bit further on" must
        // not mean "over".
        const { wrapper, controller } = mountControls({ currentTime: 595, duration: 600 });

        await wrapper.get('.lmp-fs-skip-forward').trigger('click');

        const target = controller.seek.mock.calls[0]?.[0] as number;
        expect(target).toBeLessThan(600);
        expect(target).toBeGreaterThan(599);
    });

    it('leaves the far end open while the duration is still unknown', async () => {
        const { wrapper, controller } = mountControls({ currentTime: 10, duration: 0 });

        await wrapper.get('.lmp-fs-skip-forward').trigger('click');

        expect(controller.seek).toHaveBeenCalledWith(25);
    });

    it('drops a button whose interval is zero', () => {
        const { wrapper } = mountControls(MIDWAY, {}, { skipBackSeconds: 0 });

        expect(wrapper.find('.lmp-fs-skip-back').exists()).toBe(false);
        expect(wrapper.find('.lmp-fs-skip-forward').exists()).toBe(true);
    });

    it('interpolates the configured interval into the label', () => {
        const { wrapper } = mountControls(
            MIDWAY,
            { skipForward: 'Avancer de {seconds} s' },
            { skipForwardSeconds: 30 },
        );

        // A hardcoded number in the string would still read "15" here.
        expect(wrapper.get('.lmp-fs-skip-forward').attributes('aria-label')).toBe(
            'Avancer de 30 s',
        );
    });
});

describe('FullscreenControls — auto-hide', () => {
    it('hides after inactivity while playing and returns on movement anywhere', async () => {
        vi.useFakeTimers();
        const { wrapper } = mountControls({ playing: true });
        const overlay = wrapper.get('.lmp-fs');

        expect(overlay.classes()).not.toContain('lmp-fs-hidden');

        vi.advanceTimersByTime(3000);
        await wrapper.vm.$nextTick();
        expect(overlay.classes()).toContain('lmp-fs-hidden');

        // Deliberately not on the overlay: hidden, it takes no pointer events
        // at all, so anything listening there could never bring itself back.
        document.dispatchEvent(new Event('pointermove'));
        await wrapper.vm.$nextTick();
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
                durationLabel: 'Durée',
                exitFullscreen: 'Quitter',
                audioMenuLabel: 'Audio FR',
                subtitlesMenuLabel: 'Sous-titres',
                subtitlesOff: 'Aucun',
            },
        );

        expect(wrapper.get('.lmp-fs-scrubber').attributes('aria-label')).toBe('Recherche');
        expect(wrapper.findAll('.lmp-fs-time')[0]?.attributes('aria-label')).toBe('Écoulé');
        expect(wrapper.findAll('.lmp-fs-time')[1]?.attributes('aria-label')).toBe('Durée');
        expect(wrapper.get('.lmp-fs-exit').attributes('aria-label')).toBe('Quitter');
        expect(wrapper.get('.lmp-fs-audio').attributes('aria-label')).toBe('Audio FR');
        expect(wrapper.get('.lmp-fs-subtitles').attributes('aria-label')).toBe('Sous-titres');
        expect(wrapper.get('.lmp-fs-subtitles option').text()).toBe('Aucun');
    });
});
