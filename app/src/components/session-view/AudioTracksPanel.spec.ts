import { describe, expect, it, vi, beforeEach } from 'vitest';
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
    w.findAll('tbody input[type="text"]');

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

        expect(save).toHaveBeenCalledWith('sess-1', 'sess_token', 'v1', [
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'fra', name: 'Français' },
            },
        ]);
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
});
