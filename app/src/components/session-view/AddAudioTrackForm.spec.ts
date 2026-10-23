import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

const { probe, add } = vi.hoisted(() => ({ probe: vi.fn(), add: vi.fn() }));
vi.mock('../../api', () => ({ probeAudioSource: probe, addAudioTrack: add }));
vi.mock('@luminary-media-converter/encode-config', () => ({
    LanguageSelect: defineComponent({
        name: 'LanguageSelect',
        props: ['modelValue'],
        emits: ['update:modelValue'],
        setup:
            (props, { emit }) =>
            () =>
                h('input', {
                    'data-test': 'language',
                    value: props.modelValue,
                    onInput: (e: Event) =>
                        emit(
                            'update:modelValue',
                            (e.target as HTMLInputElement).value
                        ),
                }),
    }),
}));

import AddAudioTrackForm from './AddAudioTrackForm.vue';

const mountForm = () =>
    mount(AddAudioTrackForm, {
        props: { sessionId: 'sess-1', sessionToken: 'sess_token', etag: 'v1' },
    });

beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { luminary?: unknown }).luminary;
    probe.mockResolvedValue({
        durationSec: 600,
        audioTracks: [
            { index: 1, channels: 2, language: 'eng' },
            { index: 2, channels: 2, language: 'fra', name: 'Dub' },
        ],
    });
    add.mockResolvedValue({ state: 'running' });
});

describe('AddAudioTrackForm', () => {
    it("reads a typed path's audio streams and offers the one it states as the language", async () => {
        const wrapper = mountForm();
        await wrapper
            .find('[data-test="audioFilePath"]')
            .setValue('/media/dub.mkv');
        await wrapper.find('form').trigger('submit');
        await flushPromises();

        expect(probe).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            '/media/dub.mkv'
        );
        const options = wrapper.findAll(
            '[data-test="audioSourceTrack"] option'
        );
        expect(options.map((o) => o.text())).toEqual([
            'Track 1 · eng · 2 ch',
            'Track 2 · fra · Dub · 2 ch',
        ]);
        expect(
            (wrapper.find('[data-test="language"]').element as HTMLInputElement)
                .value
        ).toBe('eng');
    });

    it('uses the desktop file dialog where there is one', async () => {
        (window as { luminary?: unknown }).luminary = {
            showOpenDialog: vi.fn().mockResolvedValue('/media/dub.wav'),
        };
        const wrapper = mountForm();
        await wrapper.find('[data-test="chooseAudioFile"]').trigger('click');
        await flushPromises();
        expect(probe).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            '/media/dub.wav'
        );
    });

    it('adds the chosen stream, named and placed, over the version the panel read', async () => {
        const wrapper = mountForm();
        await wrapper
            .find('[data-test="audioFilePath"]')
            .setValue('/media/dub.mkv');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(
            wrapper.find('[data-test="addAudioTrack"]').attributes('disabled')
        ).toBeDefined();

        await wrapper.find('[data-test="audioSourceTrack"]').setValue('1');
        await wrapper.find('[data-test="language"]').setValue('fra');
        await wrapper.find('[data-test="newTrackName"]').setValue('Français');
        await wrapper.find('[data-test="newTrackOffset"]').setValue('-2.5');
        await wrapper.find('[data-test="addAudioTrack"]').trigger('click');
        await flushPromises();

        expect(add).toHaveBeenCalledWith('sess-1', 'sess_token', {
            path: '/media/dub.mkv',
            sourceTrackIndex: 1,
            language: 'fra',
            name: 'Français',
            offsetSec: -2.5,
            ifMatch: 'v1',
        });
        expect(wrapper.emitted('started')).toEqual([[{ state: 'running' }]]);
    });

    it('says why a file cannot be used', async () => {
        probe.mockRejectedValue(new Error('This file has no audio'));
        const wrapper = mountForm();
        await wrapper
            .find('[data-test="audioFilePath"]')
            .setValue('/media/silent.mp4');
        await wrapper.find('form').trigger('submit');
        await flushPromises();
        expect(wrapper.text()).toContain('This file has no audio');
        expect(wrapper.find('[data-test="addAudioTrack"]').exists()).toBe(
            false
        );
    });
});
