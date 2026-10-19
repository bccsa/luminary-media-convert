import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import AudioFullscreen from '../src/components/AudioFullscreen.vue';
import NowPlayingLyrics from '../src/components/NowPlayingLyrics.vue';
import { DEFAULT_MESSAGES } from '../src/messages';
import { activeLyric, cuesToLyrics, lyricText } from '../src/ui/lyrics';

const lyrics = [
    { start: 10, end: 14, text: 'Out of the depths of my heart, Lord, I pray!' },
    { start: 14, end: 18, text: 'Help me, Your Word to obey!' },
    { start: 18, end: 22, text: 'Help me to love Your laws and way!' },
];

function mountView(props: Record<string, unknown> = {}, slots: Record<string, () => unknown> = {}) {
    return mount(AudioFullscreen, {
        props: {
            title: 'Youth meeting',
            artwork: { src: 'https://cdn.example.com/cover.jpg' },
            appearance: 'dark',
            chapters: [],
            currentTime: 15,
            duration: 480,
            playing: true,
            chapterIndex: -1,
            playbackRate: 1,
            audioTracks: [{ id: 'en', label: 'English' }],
            activeAudioTrackId: 'en',
            sleepTimer: null,
            hasBrowse: false,
            skipBackSeconds: 10,
            skipForwardSeconds: 10,
            chapterMask: '',
            messages: DEFAULT_MESSAGES,
            ...props,
        },
        slots,
        attachTo: document.body,
    });
}
const find = (wrapper: ReturnType<typeof mountView>, test: string) => wrapper.find(`[data-test='${test}']`);

describe('lyrics', () => {
    it('reads a cue without its WebVTT markup', () => {
        expect(lyricText('<v Choir><i>Help me</i>, Your Word\n  to obey! </v>')).toBe('Help me, Your Word\nto obey!');
        expect(lyricText('Faith &amp; hope')).toBe('Faith & hope');
        expect(lyricText('<c.yellow></c>')).toBe('');
    });

    it("turns a track's cues into lines in time order, without empty or repeated ones", () => {
        const cues = [
            { startTime: 14, endTime: 18, text: 'Help me, Your Word to obey!' },
            { startTime: 10, endTime: 14, text: 'Out of the depths' },
            { startTime: 14, endTime: 18, text: 'Help me, Your Word to obey!' },
            { startTime: 20, endTime: 21, text: '   ' },
        ];
        expect(cuesToLyrics(cues).map((line) => line.start)).toEqual([10, 14]);
        expect(cuesToLyrics(null)).toEqual([]);
    });

    it('keeps the last line that has started lit, through the pause after it', () => {
        expect(activeLyric(lyrics, 5)).toBe(-1);
        expect(activeLyric(lyrics, 10)).toBe(0);
        expect(activeLyric(lyrics, 15)).toBe(1);
        expect(activeLyric(lyrics, 40)).toBe(2);
    });

    it('lights the line being sung, and goes to a line that is tapped', async () => {
        const wrapper = mount(NowPlayingLyrics, { props: { lines: lyrics, currentTime: 15, label: 'Lyrics' } });
        const lines = wrapper.findAll('[data-lyric]');
        expect(lines[1]!.attributes('aria-current')).toBe('true');
        expect(lines[0]!.attributes('aria-current')).toBeUndefined();

        await lines[2]!.trigger('click');
        expect(wrapper.emitted('seek')).toEqual([[18]]);
    });
});

describe('the now-playing view for a host', () => {
    it('names the chevron as the host asks, and fills the right of the top line from its slot', () => {
        const wrapper = mountView({ exitLabel: 'Minimise player' }, { 'top-end': () => h('button', { 'data-test': 'hostToggle' }) });
        expect(find(wrapper, 'afsExit').attributes('aria-label')).toBe('Minimise player');
        expect(find(wrapper, 'afsTopEnd').find("[data-test='hostToggle']").exists()).toBe(true);

        const plain = mountView();
        expect(find(plain, 'afsExit').attributes('aria-label')).toBe(DEFAULT_MESSAGES.exitFullscreen);
        expect(find(plain, 'afsTopEnd').exists()).toBe(false);
    });

    it('takes its colour from the given wash, unblurred, and from the cover without one', () => {
        const hashed = mountView({ wash: 'data:image/png;base64,AAAA' });
        expect(find(hashed, 'afsWash').attributes('src')).toBe('data:image/png;base64,AAAA');
        expect(find(hashed, 'afsWash').classes()).toContain('lmpl-afs-wash-hash');

        const plain = mountView();
        expect(find(plain, 'afsWash').attributes('src')).toBe('https://cdn.example.com/cover.jpg');
        expect(find(plain, 'afsWash').classes()).not.toContain('lmpl-afs-wash-hash');
    });

    describe('with sound alone', () => {
        it('offers lyrics when there are words, and shows them in the cover\'s place', async () => {
            const wrapper = mountView({ lyrics });
            expect(find(wrapper, 'afsCover').exists()).toBe(true);
            await find(wrapper, 'afsLyricsToggle').trigger('click');
            expect(find(wrapper, 'afsLyrics').exists()).toBe(true);
            expect(find(wrapper, 'afsCover').exists()).toBe(false);
            expect(find(wrapper, 'afsLyricsToggle').attributes('aria-pressed')).toBe('true');

            await find(wrapper, 'afsLyrics').findAll('[data-lyric]')[0]!.trigger('click');
            expect(wrapper.emitted('seek')).toEqual([[10]]);
        });

        it('has no lyrics button for a post without words, and keeps the sleep timer', () => {
            const wrapper = mountView();
            expect(find(wrapper, 'afsLyricsToggle').exists()).toBe(false);
            expect(find(wrapper, 'afsSleep').exists()).toBe(true);
            expect(find(wrapper, 'afsSubtitles').exists()).toBe(false);
            expect(find(wrapper, 'afsFullscreen').exists()).toBe(false);
        });
    });

    describe('with the picture', () => {
        const video = { stage: 'video', subtitleTracks: [{ id: 'fr', label: 'Français' }], canPictureInPicture: true, lyrics };

        it("puts the host's picture in the cover's place, with a full-screen button on it", async () => {
            const wrapper = mountView(video, { stage: () => h('div', { 'data-test': 'hostPicture' }) });
            expect(find(wrapper, 'afsStage').find("[data-test='hostPicture']").exists()).toBe(true);
            expect(find(wrapper, 'afsCover').exists()).toBe(false);
            expect(wrapper.find('.lmpl-afs').classes()).toContain('lmpl-afs-video');

            await find(wrapper, 'afsFullscreen').trigger('click');
            expect(wrapper.emitted('fullscreen')).toHaveLength(1);
        });

        it("has a video's tools: subtitles and picture in picture, without the sleep timer or lyrics", async () => {
            const wrapper = mountView(video);
            expect(find(wrapper, 'afsSleep').exists()).toBe(false);
            expect(find(wrapper, 'afsLyricsToggle').exists()).toBe(false);

            await find(wrapper, 'afsSubtitles').trigger('click');
            await wrapper.findAll('[role=menuitemradio]').find((item) => item.text() === 'Français')!.trigger('click');
            await find(wrapper, 'afsSubtitles').trigger('click');
            await find(wrapper, 'afsSubtitlesOff').trigger('click');
            expect(wrapper.emitted('subtitle-track')).toEqual([['fr'], [null]]);

            await find(wrapper, 'afsPictureInPicture').trigger('click');
            expect(wrapper.emitted('picture-in-picture')).toHaveLength(1);
        });

        it("keeps the host's player mounted with sound alone, only hidden, so switching never stops it", async () => {
            const wrapper = mountView({ stage: 'cover' }, { stage: () => h('div', { 'data-test': 'hostPicture' }) });
            const slot = find(wrapper, 'afsStageSlot');
            expect(slot.find("[data-test='hostPicture']").exists()).toBe(true);
            expect(slot.isVisible()).toBe(false);
            expect(find(wrapper, 'afsCover').exists()).toBe(true);

            await wrapper.setProps({ stage: 'video' });
            expect(find(wrapper, 'afsStageSlot').isVisible()).toBe(true);
            expect(find(wrapper, 'afsCover').exists()).toBe(false);
        });

        it('closes the lyrics when the picture comes back', async () => {
            const wrapper = mountView({ lyrics });
            await find(wrapper, 'afsLyricsToggle').trigger('click');
            await wrapper.setProps({ stage: 'video' });
            await wrapper.setProps({ stage: 'cover' });
            expect(find(wrapper, 'afsLyrics').exists()).toBe(false);
            expect(find(wrapper, 'afsCover').exists()).toBe(true);
        });

        it('leaves its stage clear for a picture drawn behind the page', () => {
            const wrapper = mountView({ ...video, stageHole: true });
            const root = wrapper.find('.lmpl-afs');
            expect(root.classes()).toContain('lmpl-afs-hole');
            expect(root.attributes('style')).toContain('--lmpl-hole-top');
            expect(root.attributes('style')).toContain('--lmpl-hole-bottom');
            expect(mountView({ stageHole: true }).find('.lmpl-afs').classes()).not.toContain('lmpl-afs-hole');
        });
    });
});
