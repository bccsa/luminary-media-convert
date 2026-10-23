import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

const { media, save } = vi.hoisted(() => ({ media: vi.fn(), save: vi.fn() }));

vi.mock('../../api', () => ({
    getEncodedMedia: media,
    putAudioTracks: save,
}));
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

import AudioTracksPanel from './AudioTracksPanel.vue';

const MEDIA = {
    tracks: [
        { language: 'fr', name: 'Francais', groups: ['aud'], default: true },
        { language: 'en', name: 'English', groups: ['aud'], default: false },
    ],
    chapterLanguages: ['en'],
    etag: 'v1',
    encrypted: false,
};
const names = (w: ReturnType<typeof mount>) =>
    w.findAll('[data-test="audioTracksPanel"] input[type="text"]');

beforeEach(() => {
    vi.clearAllMocks();
    media.mockResolvedValue(MEDIA);
    save.mockImplementation(async (_id, _t, _etag, edits) => ({
        ...MEDIA,
        etag: 'v2',
        tracks: MEDIA.tracks.map((t) => {
            const e = edits.find(
                (x: { from: { name: string } }) => x.from.name === t.name
            );
            return e ? { ...t, ...e.to } : t;
        }),
    }));
});

const mountPanel = () =>
    mount(AudioTracksPanel, {
        props: { sessionId: 'sess-1', sessionToken: 'sess_token' },
    });

describe('AudioTracksPanel', () => {
    it("lists the video's audio tracks, with nothing to save yet", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(
            names(wrapper).map((n) => (n.element as HTMLInputElement).value)
        ).toEqual(['Francais', 'English']);
        expect(
            wrapper.find('[data-test="saveAudioTracks"]').attributes('disabled')
        ).toBeDefined();
    });

    it('saves only the tracks that changed, against the version it read, and says so', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await names(wrapper)[0].setValue('Français');
        await wrapper.findAll('[data-test="language"]')[0].setValue('fra');
        await wrapper.find('[data-test="saveAudioTracks"]').trigger('click');
        await flushPromises();

        expect(save).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            'v1',
            [
                {
                    from: { language: 'fr', name: 'Francais' },
                    to: { language: 'fra', name: 'Français' },
                },
            ],
            []
        );
        expect(wrapper.emitted('saved')).toHaveLength(1);
        expect(wrapper.text()).toContain('Saved');
    });

    it('offers to read the video again when it changed since it was opened', async () => {
        save.mockRejectedValue(
            new Error('The video was changed since it was opened')
        );
        const wrapper = mountPanel();
        await flushPromises();
        await names(wrapper)[1].setValue('Anglais');
        await wrapper.find('[data-test="saveAudioTracks"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('changed since');
        await wrapper.find('button.underline').trigger('click');
        await flushPromises();
        expect(media).toHaveBeenCalledTimes(2);
    });

    it('removes a track on save, and puts it back on discard', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.text()).not.toContain('Default');
        await wrapper
            .findAll('[data-test="removeAudioTrack"]')[1]
            .trigger('click');
        expect(
            names(wrapper).map((n) => (n.element as HTMLInputElement).value)
        ).toEqual(['Francais']);
        expect(wrapper.text()).toContain('Unsaved');

        await wrapper
            .findAll('button')
            .find((b) => b.text() === 'Discard')!
            .trigger('click');
        expect(names(wrapper)).toHaveLength(2);

        await wrapper
            .findAll('[data-test="removeAudioTrack"]')[1]
            .trigger('click');
        await wrapper.find('[data-test="saveAudioTracks"]').trigger('click');
        await flushPromises();
        expect(save).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            'v1',
            [],
            [{ language: 'en', name: 'English' }]
        );
    });

    it('keeps the last track', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper
            .findAll('[data-test="removeAudioTrack"]')[0]
            .trigger('click');
        const [last] = wrapper.findAll('[data-test="removeAudioTrack"]');
        expect(last.attributes('disabled')).toBeDefined();
    });
});

describe('AudioTracksPanel adding a track', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows the add under way, holds renaming, and lists the track once it is in', async () => {
        const running = {
            state: 'running',
            phase: 'encoding',
            progress: 40,
            language: 'deu',
            name: 'Deutsch',
        };
        media.mockResolvedValueOnce({ ...MEDIA, adding: running });
        media.mockResolvedValueOnce({
            ...MEDIA,
            adding: { ...running, phase: 'uploading', progress: 80 },
        });
        media.mockResolvedValue({
            ...MEDIA,
            etag: 'v3',
            tracks: [
                ...MEDIA.tracks,
                {
                    language: 'deu',
                    name: 'Deutsch',
                    groups: ['aud'],
                    default: false,
                },
            ],
            adding: { ...running, state: 'done', phase: 'done', progress: 100 },
        });
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-test="addingAudioTrack"]').text()).toContain(
            'Encoding 40%'
        );
        expect(
            wrapper.find('[data-test="saveAudioTracks"]').attributes('disabled')
        ).toBeDefined();
        expect(
            wrapper
                .find('[data-test="showAddAudioTrack"]')
                .attributes('disabled')
        ).toBeDefined();

        await vi.advanceTimersByTimeAsync(1000);
        expect(wrapper.find('[data-test="addingAudioTrack"]').text()).toContain(
            'Uploading 80%'
        );

        await vi.advanceTimersByTimeAsync(1000);
        expect(wrapper.find('[data-test="addingAudioTrack"]').exists()).toBe(
            false
        );
        expect(
            names(wrapper).map((n) => (n.element as HTMLInputElement).value)
        ).toEqual(['Francais', 'English', 'Deutsch']);
        expect(wrapper.text()).toContain('“Deutsch” was added.');
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('says why a track was not added', async () => {
        media.mockResolvedValue({
            ...MEDIA,
            adding: {
                state: 'failed',
                phase: 'encoding',
                progress: 10,
                language: 'deu',
                name: 'Deutsch',
                error: 'The audio could not be encoded',
            },
        });
        const wrapper = mountPanel();
        await flushPromises();
        expect(
            wrapper.find('[data-test="addAudioTrackFailed"]').text()
        ).toContain('The audio could not be encoded');
    });
});
