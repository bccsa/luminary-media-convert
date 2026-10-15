import { describe, expect, it } from 'vitest';
import { CLOSED, clamp, press, sectionsOf, type View } from './menu.js';

const phone = {
    angles: [
        { id: 'cam1', label: 'Stage' },
        { id: '__audio__', label: 'Audio only' },
    ],
    activeAngleId: 'cam1',
    qualities: [
        { id: '720', label: '720p' },
        { id: '480', label: '480p' },
    ],
    activeQualityId: 'auto',
};
const audio = [
    { id: '1', label: 'English' },
    { id: '2', label: 'Spanish' },
];
const sections = sectionsOf({ audio, activeAudioId: '1', subtitles: [{ id: '9', label: 'English' }], activeSubtitleId: null, phone });

function keys(start: View, ...pressed: string[]) {
    let view = start;
    const picks: unknown[] = [];
    for (const key of pressed) {
        const result = press(view, sections, key);
        view = result.view;
        if (result.pick) picks.push(result.pick);
    }
    return { view, picks };
}

describe('sectionsOf', () => {
    it('offers what there is a choice of, with Off and Auto the TV\'s own', () => {
        expect(sections.map((section) => section.key)).toEqual(['audio', 'subtitles', 'quality', 'angle']);
        expect(sections[1]!.items[0]).toEqual({ id: 'off', label: 'Off' });
        expect(sections[1]!.activeId).toBe('off');
        expect(sections[2]!.items[0]).toEqual({ id: 'auto', label: 'Auto' });
    });

    it('leaves out a single audio track, a single angle, and the phone\'s lists before it sends them', () => {
        const few = sectionsOf({ audio: [audio[0]!], activeAudioId: '1', subtitles: [], activeSubtitleId: null, phone: null });
        expect(few).toEqual([]);
        const oneAngle = sectionsOf({ audio: [], activeAudioId: null, subtitles: [], activeSubtitleId: null, phone: { ...phone, angles: [phone.angles[0]!] } });
        expect(oneAngle.map((section) => section.key)).toEqual(['quality']);
    });
});

describe('press', () => {
    it('leaves every key to the player while the menu is shut, but Up', () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', 'ArrowDown', 'MediaPlayPause']) {
            expect(press(CLOSED, sections, key)).toEqual({ view: CLOSED, consumed: false });
        }
        expect(press(CLOSED, sections, 'ArrowUp')).toMatchObject({ consumed: true, view: { open: true, list: false } });
    });

    it('picks a language: up, Enter on Audio, down, Enter', () => {
        const { view, picks } = keys(CLOSED, 'ArrowUp', 'Enter', 'ArrowDown', 'Enter');
        expect(picks).toEqual([{ section: 'audio', id: '2' }]);
        expect(view.open).toBe(false);
    });

    it('opens a list on the current choice, and moves between sections in the row and in a list', () => {
        const row = keys(CLOSED, 'ArrowUp', 'ArrowRight', 'ArrowRight').view;
        expect(row.section).toBe(2);
        const list = keys(row, 'Enter').view;
        expect(list).toMatchObject({ list: true, item: 0 });
        const angles = keys(list, 'ArrowRight').view;
        expect(angles).toMatchObject({ section: 3, list: true, item: 0 });
        expect(keys(angles, 'ArrowDown', 'Enter').picks).toEqual([{ section: 'angle', id: '__audio__' }]);
    });

    it('steps back a level with Back, and out of a list from its top with Up', () => {
        const list = keys(CLOSED, 'ArrowUp', 'Enter').view;
        expect(keys(list, 'BrowserBack').view).toMatchObject({ open: true, list: false });
        expect(keys(list, 'ArrowUp').view).toMatchObject({ open: true, list: false });
        expect(keys(list, 'BrowserBack', 'BrowserBack').view.open).toBe(false);
    });

    it('keeps every key while open, so nothing seeks behind it, and stays within the ends', () => {
        const row = keys(CLOSED, 'ArrowUp').view;
        expect(press(row, sections, 'MediaPlayPause').consumed).toBe(true);
        expect(keys(row, 'ArrowLeft', 'ArrowLeft').view.section).toBe(0);
        const last = keys(CLOSED, 'ArrowUp', 'Enter', 'ArrowDown', 'ArrowDown', 'ArrowDown').view;
        expect(last.item).toBe(1);
    });

    it('does nothing with no sections, and a view outside changed sections is pulled back in', () => {
        expect(press(CLOSED, [], 'ArrowUp')).toEqual({ view: CLOSED, consumed: false });
        expect(clamp({ open: true, list: true, section: 9, item: 9 }, sections)).toEqual({ open: true, list: true, section: 3, item: 1 });
    });
});
