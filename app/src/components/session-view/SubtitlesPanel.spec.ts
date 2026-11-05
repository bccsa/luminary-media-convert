import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const api = vi.hoisted(() => ({
    getEncodedMedia: vi.fn(),
    getSubtitles: vi.fn(),
    putSubtitles: vi.fn(),
    deleteSubtitles: vi.fn(),
}));
vi.mock('../../api', () => api);

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
type Panel = ReturnType<typeof mountPanel>;

const words = (wrapper: Panel) =>
    wrapper.findAll('[data-test="lineWords"]').map((t) => (t.element as HTMLTextAreaElement).value);
const chips = (wrapper: Panel) => wrapper.findAll('[data-test="subtitleLanguage"]').map((b) => b.text());

beforeEach(() => {
    vi.clearAllMocks();
    api.getEncodedMedia.mockResolvedValue(media([{ language: 'en', name: 'English' }]));
    api.getSubtitles.mockResolvedValue({ language: 'en', name: 'English', vtt: EN_VTT });
});

describe('SubtitlesPanel', () => {
    it("opens the video's first language on its lines, nothing to save yet", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(chips(wrapper)).toEqual(['English en']);
        expect(api.getSubtitles).toHaveBeenCalledWith('sess-1', 'tok', 'en');
        expect(words(wrapper)).toEqual(['Hello', 'Goodbye']);
        const save = wrapper.find('[data-test="saveSubtitles"]');
        expect(save.text()).toBe('Save English');
        expect(save.attributes('disabled')).toBeDefined();
    });

    it('saves a changed line as WebVTT, against the version it read', async () => {
        api.putSubtitles.mockResolvedValue(media([{ language: 'en', name: 'English' }], 'v2'));
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.findAll('[data-test="lineWords"]')[0]!.setValue('Hi there');
        expect(wrapper.text()).toContain('Unsaved');

        await wrapper.find('[data-test="saveSubtitles"]').trigger('click');
        await flushPromises();
        const [, , language, ifMatch, name, vtt] = api.putSubtitles.mock.calls[0]!;
        expect([language, ifMatch, name]).toEqual(['en', 'v1', 'English']);
        expect(vtt).toContain('00:00:01.000 --> 00:00:03.000\nHi there');
        expect(wrapper.emitted('saved')).toHaveLength(1);
        expect(wrapper.text()).not.toContain('Unsaved');
    });

    it('switches between Lines and Translate on the same language', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="subtitleViewTranslate"]').trigger('click');
        // One language: nothing to translate from yet, and a way to start.
        expect(wrapper.find('[data-test="translateNeedsTwo"]').text()).toContain('Add a second language to translate');
        await wrapper.find('[data-test="translateNeedsTwo"] button').trigger('click');
        expect(wrapper.find('[data-test="addSubtitlesForm"]').exists()).toBe(true);
        expect((wrapper.find('[data-test="newSubtitleFromCopy"]').element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.find('[data-test="addSubtitles"]').text()).toBe('Start translating');

        await wrapper.find('[data-test="subtitleViewLines"]').trigger('click');
        expect(wrapper.find('[data-test="subtitleLines"]').exists()).toBe(true);
    });

    it("adds a language on another's timings and opens it in Translate beside that one", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="showAddSubtitles"]').trigger('click');
        await wrapper.find('[data-test="newSubtitleCode"]').setValue('fr');
        expect((wrapper.find('[data-test="newSubtitleName"]').element as HTMLInputElement).value).toBe('Français');
        await wrapper.find('[data-test="newSubtitleFromCopy"]').setValue(true);
        await wrapper.find('[data-test="addSubtitlesForm"]').trigger('submit');
        await flushPromises();

        expect(chips(wrapper)).toEqual(['English en', 'Français fr']);
        expect(wrapper.text()).toContain('Translating Français from');
        expect(wrapper.find('[data-test="translatedCount"]').text()).toBe('0 of 2 translated');
        await wrapper.findAll('[data-test="subtitleCompareWords"]')[0]!.setValue('Bonjour');
        expect(wrapper.find('[data-test="translatedCount"]').text()).toBe('1 of 2 translated');

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

    it('replaces the lines with a file imported from the Files menu, unsaved until saved', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="subtitleFiles"]').trigger('click');
        expect(wrapper.find('[data-test="subtitleFilesMenu"]').exists()).toBe(true);
        const input = wrapper.find('[data-test="importSubtitlesFile"]');
        const srt = '1\n00:00:02,000 --> 00:00:04,000\nFrom a file\n';
        // jsdom's File has no text(); the browser's has.
        const file = Object.assign(new File([srt], 'en.srt'), { text: async () => srt });
        Object.defineProperty(input.element, 'files', { value: [file] });
        await input.trigger('change');
        await vi.waitFor(() => expect(wrapper.text()).toContain('from en.srt'));
        expect(words(wrapper)).toEqual(['From a file']);
        expect(wrapper.text()).toContain('Unsaved');
    });

    it('renames a language in the Files menu', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="subtitleFiles"]').trigger('click');
        await wrapper.find('[data-test="subtitleName"]').setValue('English (UK)');
        expect(chips(wrapper)).toEqual(['English (UK) en']);
        expect(wrapper.find('[data-test="saveSubtitles"]').text()).toBe('Save English (UK)');
        expect(wrapper.text()).toContain('Unsaved');
    });

    it('takes a language out once it is confirmed, and says the video has none', async () => {
        api.deleteSubtitles.mockResolvedValue(media([], 'v2'));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-test="subtitleFiles"]').trigger('click');
        await wrapper.find('[data-test="removeSubtitles"]').trigger('click');
        await flushPromises();
        expect(confirm).toHaveBeenCalled();
        expect(api.deleteSubtitles).toHaveBeenCalledWith('sess-1', 'tok', 'en', 'v1');
        expect(wrapper.find('[data-test="subtitlesEmpty"]').text()).toContain('This video has no subtitles yet');
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('says when the video changed since it was read, and reads it again keeping the edit', async () => {
        api.putSubtitles.mockRejectedValue(new Error('Could not save the subtitles: The video was changed since it was opened'));
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.findAll('[data-test="lineWords"]')[1]!.setValue('Bye');
        await wrapper.find('[data-test="saveSubtitles"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-test="subtitlesError"]').text()).toContain('changed since');
        await wrapper.find('[data-test="subtitlesError"] button').trigger('click');
        await flushPromises();
        expect(api.getEncodedMedia).toHaveBeenCalledTimes(2);
        expect(words(wrapper)).toEqual(['Hello', 'Bye']);
    });
});
