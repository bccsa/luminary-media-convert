import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

const api = vi.hoisted(() => ({
    getEncodedMedia: vi.fn(),
    getSubtitles: vi.fn(),
    putSubtitles: vi.fn(),
    deleteSubtitles: vi.fn(),
}));
vi.mock('../../api', () => api);

// The timeline editor needs a browser's layout; its v-model is what the panel hands it.
vi.mock('../segment-editor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../segment-editor')>();
    return {
        ...actual,
        SegmentEditor: defineComponent({
            name: 'SegmentEditor',
            props: { modelValue: { type: Array, required: true }, mode: String },
            emits: ['update:modelValue'],
            setup: (props) => () => h('div', { 'data-test': 'segmentEditorStub' }, `${props.modelValue.length} lines`),
        }),
    };
});

import SubtitlesPanel from './SubtitlesPanel.vue';

const EN_VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello\n\n2\n00:00:04.000 --> 00:00:06.000\nGoodbye\n';
const media = (subtitles: { language: string; name: string }[], etag = 'v1') => ({
    tracks: [],
    angles: [],
    chapterLanguages: [],
    encrypted: true,
    etag,
    subtitles: subtitles.map((s) => ({ ...s, uri: `subtitles/${s.language}_x.m3u8`, default: false })),
});

const mountPanel = () =>
    mount(SubtitlesPanel, {
        props: { sessionId: 'sess-1', sessionToken: 'tok', duration: 60, getCurrentTime: () => 0 },
        attachTo: document.body,
    });

const editor = (wrapper: ReturnType<typeof mountPanel>) => wrapper.findComponent({ name: 'SegmentEditor' });

beforeEach(() => {
    vi.clearAllMocks();
    api.getEncodedMedia.mockResolvedValue(media([{ language: 'en', name: 'English' }]));
    api.getSubtitles.mockResolvedValue({ language: 'en', name: 'English', vtt: EN_VTT });
});

describe('SubtitlesPanel', () => {
    it("lists the video's languages and edits the first one's lines on the timeline", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.findAll('[data-test="subtitleLanguage"]').map((b) => b.text())).toEqual(['English · en']);
        expect(api.getSubtitles).toHaveBeenCalledWith('sess-1', 'tok', 'en');
        expect(editor(wrapper).props('mode')).toBe('subtitles');
        expect(editor(wrapper).props('modelValue')).toHaveLength(2);
        expect(wrapper.find('[data-test="saveSubtitles"]').attributes('disabled')).toBeDefined();
    });

    it('saves a changed line as WebVTT, against the version it read', async () => {
        api.putSubtitles.mockResolvedValue(media([{ language: 'en', name: 'English' }], 'v2'));
        const wrapper = mountPanel();
        await flushPromises();
        const lines = editor(wrapper).props('modelValue') as { label: string }[];
        editor(wrapper).vm.$emit('update:modelValue', [{ ...lines[0], label: 'Hi there' }, lines[1]]);
        await flushPromises();
        expect(wrapper.text()).toContain('Unsaved');

        await wrapper.find('[data-test="saveSubtitles"]').trigger('click');
        await flushPromises();
        const [, , language, ifMatch, name, vtt] = api.putSubtitles.mock.calls[0]!;
        expect([language, ifMatch, name]).toEqual(['en', 'v1', 'English']);
        expect(vtt).toContain('00:00:01.000 --> 00:00:03.000\nHi there');
        expect(wrapper.emitted('saved')).toHaveLength(1);
        expect(wrapper.text()).not.toContain('Unsaved');
    });

    it("adds a language on another's timings and opens it beside that one to translate", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="showAddSubtitles"]').trigger('click');
        await wrapper.find('[data-test="newSubtitleCode"]').setValue('fr');
        expect((wrapper.find('[data-test="newSubtitleName"]').element as HTMLInputElement).value).toBe('Français');
        await wrapper.find('[data-test="newSubtitleFromCopy"]').setValue(true);
        await wrapper.find('[data-test="addSubtitlesForm"]').trigger('submit');
        await flushPromises();

        expect(wrapper.findAll('[data-test="subtitleLanguage"]').map((b) => b.text())).toEqual([
            'English · en',
            'Français · fr•',
        ]);
        const rows = wrapper.findAll('[data-test="subtitleCompareRow"]');
        expect(rows.map((r) => r.text())).toEqual([
            expect.stringContaining('Hello'),
            expect.stringContaining('Goodbye'),
        ]);
        await wrapper.findAll('[data-test="subtitleCompareWords"]')[0]!.setValue('Bonjour');

        api.putSubtitles.mockResolvedValue(media([{ language: 'en', name: 'English' }, { language: 'fr', name: 'Français' }], 'v2'));
        await wrapper.find('[data-test="saveSubtitles"]').trigger('click');
        await flushPromises();
        const [, , language, , name, vtt] = api.putSubtitles.mock.calls[0]!;
        expect([language, name]).toEqual(['fr', 'Français']);
        // Only the translated line: the one still empty is not written.
        expect(vtt).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nBonjour\n');
    });

    it('refuses a language the video already has, or a code that is not one', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="showAddSubtitles"]').trigger('click');
        await wrapper.find('[data-test="newSubtitleCode"]').setValue('en');
        expect(wrapper.text()).toContain('already has subtitles in that language');
        await wrapper.find('[data-test="newSubtitleCode"]').setValue('French');
        expect(wrapper.text()).toContain('A language code');
        expect(wrapper.find('[data-test="addSubtitles"]').attributes('disabled')).toBeDefined();
    });

    it('replaces the lines with an imported .srt, unsaved until saved', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        const input = wrapper.find('[data-test="importSubtitlesFile"]');
        const srt = '1\n00:00:02,000 --> 00:00:04,000\nFrom a file\n';
        // jsdom's File has no text(); the browser's has.
        const file = Object.assign(new File([srt], 'en.srt'), { text: async () => srt });
        Object.defineProperty(input.element, 'files', { value: [file] });
        await input.trigger('change');
        // Reading a file finishes on a later turn than a promise.
        await vi.waitFor(() => expect(wrapper.text()).toContain('from en.srt'));
        expect(editor(wrapper).props('modelValue')).toEqual([
            expect.objectContaining({ inSec: 2, outSec: 4, label: 'From a file' }),
        ]);
        expect(wrapper.text()).toContain('1 lines from en.srt, not saved yet');
        expect(wrapper.text()).toContain('Unsaved');
    });

    it('takes a language out once it is confirmed', async () => {
        api.deleteSubtitles.mockResolvedValue(media([], 'v2'));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="removeSubtitles"]').trigger('click');
        await flushPromises();
        expect(confirm).toHaveBeenCalled();
        expect(api.deleteSubtitles).toHaveBeenCalledWith('sess-1', 'tok', 'en', 'v1');
        expect(wrapper.text()).toContain('This video has no subtitles yet');
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('says when the video changed since it was read, and reads it again', async () => {
        api.putSubtitles.mockRejectedValue(new Error('Could not save the subtitles: The video was changed since it was opened'));
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="subtitleName"]').setValue('English (UK)');
        await wrapper.find('[data-test="saveSubtitles"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-test="subtitlesError"]').text()).toContain('changed since');
        await wrapper.find('[data-test="subtitlesError"] button').trigger('click');
        await flushPromises();
        expect(api.getEncodedMedia).toHaveBeenCalledTimes(2);
        // The name typed survives the reread.
        expect((wrapper.find('[data-test="subtitleName"]').element as HTMLInputElement).value).toBe('English (UK)');
    });
});
