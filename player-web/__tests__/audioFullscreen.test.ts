import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AudioFullscreen from '../src/components/AudioFullscreen.vue';
import { DEFAULT_MESSAGES } from '../src/messages';

const chapters = Array.from({ length: 8 }, (_, i) => ({ startTime: i * 60, endTime: i * 60 + 60, title: `Chapter ${i + 1}` }));

function mountScreen(props: Record<string, unknown> = {}) {
    return mount(AudioFullscreen, {
        props: {
            title: 'Why we get thirsty',
            subtitle: 'Pastor Daniel',
            eyebrow: 'Sunday messages',
            artwork: { src: 'https://cdn.example.com/cover.jpg' },
            appearance: 'dark',
            chapters,
            currentTime: 150,
            duration: 480,
            bufferedEnd: 200,
            playing: false,
            chapterIndex: 2,
            playbackRate: 1,
            audioTracks: [{ id: 'en', label: 'English' }],
            activeAudioTrackId: 'en',
            sleepTimer: null,
            hasBrowse: true,
            skipBackSeconds: 10,
            skipForwardSeconds: 10,
            chapterMask: '',
            messages: DEFAULT_MESSAGES,
            ...props,
        },
        global: { config: { compilerOptions: { isCustomElement: (tag: string) => tag.startsWith('media-') } } },
        attachTo: document.body,
    });
}
const find = (wrapper: ReturnType<typeof mountScreen>, test: string) => wrapper.find(`[data-test='${test}']`);

describe('AudioFullscreen — what it shows', () => {
    it('names what is playing: the title, who it is by, and the series', () => {
        const wrapper = mountScreen();
        expect(find(wrapper, 'afsTitle').text()).toBe('Why we get thirsty');
        expect(wrapper.text()).toContain('Pastor Daniel');
        expect(wrapper.text()).toContain('Sunday messages');
    });

    it('leads with the cover, and with a placeholder when there is none', () => {
        expect(find(mountScreen(), 'afsCover').attributes('src')).toBe('https://cdn.example.com/cover.jpg');
        const bare = mountScreen({ artwork: null });
        expect(find(bare, 'afsCover').exists()).toBe(false);
        expect(bare.find('.lmpl-afs-cover-empty').exists()).toBe(true);
    });

    it('says where the playhead is among the chapters, on a chip that opens them', () => {
        const chip = find(mountScreen(), 'afsChip');
        expect(chip.text()).toBe('Chapter 3 of 8 · Chapter 3');
    });

    it('has no chip, and no chapter list, without chapters', () => {
        const wrapper = mountScreen({ chapters: [], chapterIndex: -1 });
        expect(find(wrapper, 'afsChip').exists()).toBe(false);
        expect(find(wrapper, 'afsChapters').exists()).toBe(false);
    });

    it('lists a window of chapters around the playing one, marking it', () => {
        const wrapper = mountScreen();
        const rows = find(wrapper, 'afsChapters').findAll('button');
        expect(rows.map((r) => r.find('.lmpl-afs-chapter-title').text())).toEqual(['Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5']);
        expect(wrapper.find('[aria-current=true] .lmpl-afs-chapter-title').text()).toBe('Chapter 3');
    });

    it('wears the cover as a colour over the whole screen in light, and as a glow behind it in dark', () => {
        const light = mountScreen({ appearance: 'light' });
        expect(light.find('.lmpl-afs-wash').exists()).toBe(true);
        expect(light.classes()).toContain('lmpl-afs-light');
        const dark = mountScreen({ appearance: 'dark' });
        expect(dark.find('.lmpl-afs-wash').exists()).toBe(false);
        expect(dark.find('.lmpl-afs-halo').exists()).toBe(true);
    });

    it('offers the language menu only when there is more than one language', () => {
        expect(find(mountScreen(), 'afsLanguage').exists()).toBe(false);
        const two = mountScreen({ audioTracks: [{ id: 'en', label: 'English' }, { id: 'fr', label: 'Français' }] });
        expect(find(two, 'afsLanguage').exists()).toBe(true);
    });

    it('has no skip button when skipping is switched off', () => {
        const wrapper = mountScreen({ skipBackSeconds: 0, skipForwardSeconds: 0 });
        expect(find(wrapper, 'afsSkipBack').exists()).toBe(false);
        expect(find(wrapper, 'afsSkipForward').exists()).toBe(false);
    });

    it('has no way to the chapters panel when there is nothing to browse', () => {
        const wrapper = mountScreen({ hasBrowse: false });
        expect(find(wrapper, 'afsBrowse').exists()).toBe(false);
        expect(find(wrapper, 'afsChip').exists()).toBe(false);
    });
});

describe('AudioFullscreen — the transport', () => {
    it('shows the time played and left, and the fill of the bar', () => {
        const wrapper = mountScreen();
        expect(find(wrapper, 'afsElapsed').text()).toBe('2:30');
        expect(find(wrapper, 'afsRemaining').text()).toBe('-5:30');
        expect(find(wrapper, 'afsBar').attributes('aria-valuenow')).toBe('150');
        expect(wrapper.find('.lmpl-afs-bar-fill').attributes('style')).toContain('31.25%');
    });

    it('asks to play and to pause from the one button', async () => {
        const wrapper = mountScreen();
        expect(find(wrapper, 'afsPlay').attributes('aria-label')).toBe('Play');
        await find(wrapper, 'afsPlay').trigger('click');
        expect(wrapper.emitted('toggle-play')).toHaveLength(1);
        await wrapper.setProps({ playing: true });
        expect(find(wrapper, 'afsPlay').attributes('aria-label')).toBe('Pause');
    });

    it('skips back and forward from where the playhead is, within the length', async () => {
        const wrapper = mountScreen({ currentTime: 5 });
        await find(wrapper, 'afsSkipBack').trigger('click');
        await find(wrapper, 'afsSkipForward').trigger('click');
        expect(wrapper.emitted('seek')).toEqual([[0], [15]]);
    });

    it('seeks with the arrow keys, five seconds at a time', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsBar').trigger('keydown', { key: 'ArrowRight' });
        await find(wrapper, 'afsBar').trigger('keydown', { key: 'ArrowLeft' });
        expect(wrapper.emitted('seek')).toEqual([[155], [145]]);
    });

    it('follows the finger along the bar, and asks for the seek once, when it is let go', async () => {
        const wrapper = mountScreen();
        const bar = find(wrapper, 'afsBar');
        bar.element.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 30, right: 300, bottom: 30, x: 100, y: 0, toJSON: () => ({}) });
        await bar.trigger('pointerdown', { clientX: 200, pointerId: 1 });
        await bar.trigger('pointermove', { clientX: 250, pointerId: 1 });
        expect(find(wrapper, 'afsElapsed').text()).toBe('6:00');
        expect(wrapper.emitted('seek')).toBeUndefined();
        await bar.trigger('pointerup', { pointerId: 1 });
        expect(wrapper.emitted('seek')).toEqual([[360]]);
        expect(find(wrapper, 'afsElapsed').text()).toBe('2:30');
    });
});

describe('AudioFullscreen — what it asks for', () => {
    it('asks to leave fullscreen, and to open the chapters from the chip and the button', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsExit').trigger('click');
        await find(wrapper, 'afsChip').trigger('click');
        await find(wrapper, 'afsBrowse').trigger('click');
        expect(wrapper.emitted('exit')).toHaveLength(1);
        expect(wrapper.emitted('open-browse')).toHaveLength(2);
    });

    it('asks to go to the chapter that is chosen', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsChapters').findAll('button')[3]!.trigger('click');
        expect(wrapper.emitted('seek-chapter')![0]).toEqual([chapters[4]]);
    });

    it('opens the speed menu, asks for a speed, and closes', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsSpeed').trigger('click');
        const items = wrapper.findAll('[role=menuitemradio]');
        expect(items.map((i) => i.text())).toEqual(['0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×']);
        await items[3]!.trigger('click');
        expect(wrapper.emitted('rate')![0]).toEqual([1.5]);
        expect(wrapper.find('[role=menu]').exists()).toBe(false);
    });

    it('asks for a language from its menu', async () => {
        const wrapper = mountScreen({ audioTracks: [{ id: 'en', label: 'English' }, { id: 'fr', label: 'Français' }] });
        await find(wrapper, 'afsLanguage').trigger('click');
        await wrapper.findAll('[role=menuitemradio]')[1]!.trigger('click');
        expect(wrapper.emitted('audio-track')![0]).toEqual(['fr']);
    });

    it('asks for a sleep timer in minutes, for the end of the chapter, and for none', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsSleep').trigger('click');
        await find(wrapper, 'afsSleep15').trigger('click');
        await find(wrapper, 'afsSleep').trigger('click');
        await find(wrapper, 'afsSleepChapter').trigger('click');
        await find(wrapper, 'afsSleep').trigger('click');
        await find(wrapper, 'afsSleepOff').trigger('click');
        expect(wrapper.emitted('sleep')).toEqual([[{ kind: 'minutes', minutes: 15 }], [{ kind: 'chapter' }], [null]]);
    });

    it('offers the end of the chapter only when there is a chapter to end', async () => {
        const wrapper = mountScreen({ chapters: [], chapterIndex: -1 });
        await find(wrapper, 'afsSleep').trigger('click');
        expect(find(wrapper, 'afsSleepChapter').exists()).toBe(false);
    });
});

describe('AudioFullscreen — the sleep timer on show', () => {
    it('says how long is left on the button, and that it stops at the chapter end', () => {
        const minutes = mountScreen({ sleepTimer: { kind: 'minutes', endsAt: Date.now() + 14 * 60_000 + 5_000 } });
        expect(find(minutes, 'afsSleepCaption').text()).toBe('15 min left');
        const chapter = mountScreen({ sleepTimer: { kind: 'chapter', endTime: 180 } });
        expect(find(chapter, 'afsSleepCaption').text()).toBe('End of chapter');
        expect(find(mountScreen(), 'afsSleepCaption').exists()).toBe(false);
    });

    it('marks the entry that is running', async () => {
        const wrapper = mountScreen({ sleepTimer: { kind: 'chapter', endTime: 180 } });
        await find(wrapper, 'afsSleep').trigger('click');
        expect(find(wrapper, 'afsSleepChapter').attributes('aria-checked')).toBe('true');
        expect(find(wrapper, 'afsSleepOff').attributes('aria-checked')).toBe('false');
    });
});

describe('AudioFullscreen — the chapters sheet', () => {
    it('opens over the screen from the chip and the button, and lists every chapter with the playing one marked', async () => {
        const wrapper = mountScreen({ chaptersSheet: true });
        expect(find(wrapper, 'afsSheet').exists()).toBe(false);
        await find(wrapper, 'afsChip').trigger('click');
        expect(find(wrapper, 'afsSheet').exists()).toBe(true);
        expect(wrapper.findAll('[data-test=afsSheetRow]')).toHaveLength(8);
        expect(wrapper.find('[data-test=afsSheetRow][aria-current=true]').text()).toContain('Chapter 3');
        expect(wrapper.emitted('open-browse')).toBeUndefined();

        await find(wrapper, 'afsSheetClose').trigger('click');
        expect(find(wrapper, 'afsSheet').exists()).toBe(false);
        await find(wrapper, 'afsBrowse').trigger('click');
        expect(find(wrapper, 'afsSheet').exists()).toBe(true);
    });

    it('goes to the chapter that is picked and closes, staying on this screen', async () => {
        const wrapper = mountScreen({ chaptersSheet: true });
        await find(wrapper, 'afsBrowse').trigger('click');
        await wrapper.findAll('[data-test=afsSheetRow]')[5]!.trigger('click');
        expect(wrapper.emitted('seek-chapter')![0]).toEqual([chapters[5]]);
        expect(wrapper.emitted('exit')).toBeUndefined();
        expect(find(wrapper, 'afsSheet').exists()).toBe(false);
    });

    it('closes on Escape, and on a press on the backdrop', async () => {
        const wrapper = mountScreen({ chaptersSheet: true });
        await find(wrapper, 'afsBrowse').trigger('click');
        await wrapper.trigger('keydown', { key: 'Escape' });
        expect(find(wrapper, 'afsSheet').exists()).toBe(false);
        await find(wrapper, 'afsBrowse').trigger('click');
        await wrapper.find('.lmpl-afs-backdrop').trigger('click');
        expect(find(wrapper, 'afsSheet').exists()).toBe(false);
    });
});

describe('AudioFullscreen — the menus', () => {
    it('close on Escape, and on a press outside them, but not on a press inside the tools', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsSpeed').trigger('click');
        expect(wrapper.find('[role=menu]').exists()).toBe(true);

        await wrapper.trigger('keydown', { key: 'Escape' });
        expect(wrapper.find('[role=menu]').exists()).toBe(false);

        await find(wrapper, 'afsSpeed').trigger('click');
        await find(wrapper, 'afsTitle').trigger('pointerdown');
        expect(wrapper.find('[role=menu]').exists()).toBe(false);

        await find(wrapper, 'afsSpeed').trigger('click');
        await find(wrapper, 'afsSpeed').trigger('pointerdown');
        expect(wrapper.find('[role=menu]').exists()).toBe(true);
    });

    it('open one at a time', async () => {
        const wrapper = mountScreen();
        await find(wrapper, 'afsSpeed').trigger('click');
        await find(wrapper, 'afsSleep').trigger('click');
        expect(wrapper.findAll('[role=menu]')).toHaveLength(1);
        expect(wrapper.find('[role=menu]').attributes('aria-label')).toBe('Sleep timer');
    });
});
