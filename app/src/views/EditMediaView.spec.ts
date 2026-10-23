import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

const { detail, media, save, replace, key } = vi.hoisted(() => ({
    detail: vi.fn(),
    media: vi.fn(),
    save: vi.fn(),
    replace: vi.fn(),
    key: vi.fn(),
}));

vi.mock('vue-router', () => ({
    useRoute: () => ({ params: { id: 'sess-1' } }),
    useRouter: () => ({ push: vi.fn(), replace }),
}));

vi.mock('../api', () => ({
    API_BASE: '',
    getSession: detail,
    listSessions: vi
        .fn()
        .mockResolvedValue([
            { sessionId: 'sess-1', sessionToken: 'sess_token' },
        ]),
    getEncodedMedia: media,
    putAudioTracks: save,
    getSessionKey: key,
    getChapters: vi.fn().mockResolvedValue(null),
    putChapters: vi.fn().mockResolvedValue(undefined),
}));

// The player and the chapter editor have suites of their own; this one is about the view's wiring.
vi.mock('../components/session-view/SessionPlayerStrip.vue', () => ({
    default: defineComponent({
        name: 'SessionPlayerStrip',
        props: ['source'],
        setup: () => () => h('div'),
    }),
}));
vi.mock('../components/segment-editor', () => ({
    SegmentEditor: defineComponent({
        name: 'SegmentEditor',
        setup: () => () => h('div'),
    }),
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

import EditMediaView from './EditMediaView.vue';

const MEDIA = {
    tracks: [
        { language: 'fr', name: 'Francais', groups: ['aud'], default: true },
        { language: 'en', name: 'English', groups: ['aud'], default: false },
    ],
    chapterLanguages: ['en'],
    etag: 'v1',
    encrypted: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    detail.mockResolvedValue({
        sessionId: 'sess-1',
        status: 'created',
        mode: 'edit',
        title: 'Sunday',
        hlsUrl: 'https://cdn.test/p/master.m3u8',
    });
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

describe('EditMediaView', () => {
    it('plays the existing video and lists its audio tracks', async () => {
        const wrapper = mount(EditMediaView);
        await flushPromises();
        expect(
            wrapper
                .findComponent({ name: 'SessionPlayerStrip' })
                .props('source')
        ).toMatchObject({
            masterUrl: 'https://cdn.test/p/master.m3u8',
        });
        const names = wrapper.findAll(
            '[data-test="editAudioTracks"] tbody input[type="text"]'
        );
        expect(names.map((n) => (n.element as HTMLInputElement).value)).toEqual(
            ['Francais', 'English']
        );
    });

    it('saves only the tracks that changed, against the version it read', async () => {
        const wrapper = mount(EditMediaView);
        await flushPromises();
        const save$ = wrapper.find('[data-test="editSaveTracks"]');
        expect(save$.attributes('disabled')).toBeDefined();

        await wrapper
            .findAll(
                '[data-test="editAudioTracks"] tbody input[type="text"]'
            )[0]
            .setValue('Français');
        await wrapper.findAll('[data-test="language"]')[0].setValue('fra');
        await save$.trigger('click');
        await flushPromises();

        expect(save).toHaveBeenCalledWith('sess-1', 'sess_token', 'v1', [
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'fra', name: 'Français' },
            },
        ]);
        expect(
            wrapper.find('[data-test="editSaveTracks"]').attributes('disabled')
        ).toBeDefined();
    });

    it('says so when an encrypted video came without its key', async () => {
        media.mockResolvedValue({ ...MEDIA, encrypted: true });
        key.mockResolvedValue(null);
        const wrapper = mount(EditMediaView);
        await flushPromises();
        expect(wrapper.find('[data-test="editLoadError"]').text()).toContain(
            'key'
        );
    });

    it('sends an encode session to its own screen', async () => {
        detail.mockResolvedValue({ sessionId: 'sess-1', status: 'created' });
        mount(EditMediaView);
        await flushPromises();
        expect(replace).toHaveBeenCalledWith('/sessions/sess-1');
        expect(media).not.toHaveBeenCalled();
    });
});
