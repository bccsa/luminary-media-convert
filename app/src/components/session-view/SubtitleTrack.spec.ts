import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Segment } from '../segment-editor';
import SubtitleTrack from './SubtitleTrack.vue';

const LINES: Segment[] = [
    { id: 'a', inSec: 10, outSec: 14, label: 'Second' },
    { id: 'b', inSec: 2, outSec: 6, label: 'First' },
    { id: 'c', inSec: 90, outSec: 94, label: 'Later' },
];

/** The track is 1000px wide over a 100 s window from 0, so 10px is a second. */
function mountTrack(view = { viewStart: 0, visibleSpan: 100 }) {
    const onSeek = vi.fn();
    let playhead = 0;
    const hooks = { lines: (_: Segment[]) => {}, selected: (_: string | null) => {} };
    const wrapper = mount(SubtitleTrack, {
        props: {
            modelValue: LINES,
            'onUpdate:modelValue': (next: Segment[]) => hooks.lines(next),
            selected: null,
            'onUpdate:selected': (id: string | null) => hooks.selected(id),
            duration: 120,
            playheadSec: 0,
            getCurrentTime: () => playhead,
            name: 'Français',
            onSeek,
            ...view,
        },
        attachTo: document.body,
    });
    hooks.lines = (next) => void wrapper.setProps({ modelValue: next });
    hooks.selected = (id) => void wrapper.setProps({ selected: id });
    const lane = wrapper.find('[data-test="subtitleTrack"]').element as HTMLElement;
    lane.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
    const lines = () => wrapper.props('modelValue') as Segment[];
    return {
        wrapper,
        onSeek,
        lines,
        line: (id: string) => lines().find((l) => l.id === id),
        keys: wrapper.vm as unknown as {
            markIn(): void;
            markOut(): void;
            removeSelected(): boolean;
            undo(): void;
            redo(): void;
            escape(): void;
        },
        at: (sec: number) => (playhead = sec),
        blocks: () => wrapper.findAll('[data-test="subtitleTrackLine"]'),
    };
}

/**
 * Presses on `el` at x, moves to x + dx, and lets go. jsdom has no PointerEvent;
 * a MouseEvent of the same name reaches the listeners.
 */
async function drag(wrapper: { vm: { $nextTick: () => Promise<void> } }, el: Element, x: number, dx: number) {
    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, button: 0, bubbles: true }));
    if (dx) window.dispatchEvent(new MouseEvent('pointermove', { clientX: x + dx }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: x + dx }));
    await wrapper.vm.$nextTick();
}

afterEach(() => document.body.replaceChildren());

describe('SubtitleTrack', () => {
    it("shows the lines in the timeline's window, in time order, with their words", () => {
        const { wrapper, blocks } = mountTrack({ viewStart: 0, visibleSpan: 50 });
        expect(blocks().map((b) => b.text())).toEqual(['First', 'Second']);
        expect(blocks()[1]!.attributes('style')).toContain('left: 20%; width: 8%');
        expect(wrapper.text()).toContain('Français');
    });

    it('away from the Subtitles tab, only plays from a line: no picking, moving, retiming or drawing', async () => {
        const { wrapper, onSeek, lines, blocks } = mountTrack();
        await wrapper.setProps({ readonly: true });
        expect(wrapper.find('[data-test="subtitleTrackIn"]').exists()).toBe(false);
        await drag(wrapper, blocks()[1]!.element, 120, 25);
        expect(onSeek).toHaveBeenCalledWith(10);
        expect(wrapper.props('selected')).toBeNull();
        expect(lines()).toEqual(LINES);
        const lane = wrapper.find('[data-test="subtitleTrack"]').element;
        await drag(wrapper, lane, 300, 0);
        await drag(wrapper, lane, 300, 45);
        expect(lines()).toEqual(LINES);
    });

    it('picks a line with a click and plays from it', async () => {
        const { wrapper, onSeek, blocks } = mountTrack();
        await drag(wrapper, blocks()[1]!.element, 120, 0);
        expect(wrapper.props('selected')).toBe('a');
        expect(onSeek).toHaveBeenCalledWith(10);
    });

    it('moves a line by dragging it, keeping its length, and not before the start', async () => {
        const { wrapper, line, onSeek, blocks } = mountTrack();
        await drag(wrapper, blocks()[1]!.element, 120, 25);
        expect(line('a')).toMatchObject({ inSec: 12.5, outSec: 16.5 });
        expect(onSeek).not.toHaveBeenCalled();
        await drag(wrapper, blocks()[0]!.element, 40, -500);
        expect(line('b')).toMatchObject({ inSec: 0, outSec: 4 });
    });

    it('retimes a line from either edge, never shorter than a moment or past the video', async () => {
        const { wrapper, line } = mountTrack();
        const edge = (which: 'In' | 'Out', i: number) =>
            wrapper.findAll(`[data-test="subtitleTrack${which}"]`)[i]!.element;
        await drag(wrapper, edge('Out', 1), 140, 20);
        expect(line('a')).toMatchObject({ inSec: 10, outSec: 16 });
        await drag(wrapper, edge('In', 1), 100, 500);
        expect(line('a')).toMatchObject({ inSec: 15.8, outSec: 16 });
        await drag(wrapper, edge('Out', 2), 940, 900);
        expect(line('c')).toMatchObject({ inSec: 90, outSec: 120 });
    });

    it('scrubs the playhead with a press between lines', async () => {
        const { wrapper, onSeek } = mountTrack();
        await drag(wrapper, wrapper.find('[data-test="subtitleTrack"]').element, 500, 100);
        expect(onSeek).toHaveBeenNthCalledWith(1, 50);
        expect(onSeek).toHaveBeenLastCalledWith(60);
    });

    it('draws a new line with a double-press and drag, and opens it', async () => {
        const { wrapper, lines } = mountTrack();
        const lane = wrapper.find('[data-test="subtitleTrack"]').element;
        await drag(wrapper, lane, 300, 0);
        lane.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, button: 0, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 345 }));
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-test="subtitleTrackDrawing"]').exists()).toBe(true);
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: 345 }));
        await wrapper.vm.$nextTick();
        const added = lines().find((l) => !LINES.some((o) => o.id === l.id))!;
        expect(added).toMatchObject({ inSec: 30, outSec: 34.5, label: '' });
        expect(wrapper.props('selected')).toBe(added.id);
    });

    it('adds a line between [ and ] at the playhead, and leaves the keyboard on the timeline', async () => {
        const { wrapper, keys, at, lines } = mountTrack();
        at(20);
        keys.markIn();
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-test="subtitleTrackPending"]').exists()).toBe(true);
        at(23.5);
        keys.markOut();
        await wrapper.vm.$nextTick();
        expect(lines()).toHaveLength(4);
        expect(lines().at(-1)).toMatchObject({ inSec: 20, outSec: 23.5 });
        expect(wrapper.props('selected')).toBe(lines().at(-1)!.id);
        expect(wrapper.find('[data-test="subtitleTrackPending"]').exists()).toBe(false);
        expect(wrapper.element.contains(document.activeElement)).toBe(false);
    });

    it('retimes the line under the playhead with [ and ]', async () => {
        const { wrapper, keys, at, line } = mountTrack();
        at(11);
        keys.markIn();
        await wrapper.vm.$nextTick();
        expect(line('a')).toMatchObject({ inSec: 11, outSec: 14 });
        at(13);
        keys.markOut();
        await wrapper.vm.$nextTick();
        expect(line('a')).toMatchObject({ inSec: 11, outSec: 13 });
    });

    it('makes a short line up to the playhead with ] alone, not over the line before', async () => {
        const { wrapper, keys, at, lines } = mountTrack();
        at(15);
        keys.markOut();
        await wrapper.vm.$nextTick();
        expect(lines().at(-1)).toMatchObject({ inSec: 14, outSec: 15 });
    });

    it('drops a pending [ with Escape', async () => {
        const { wrapper, keys, at, lines } = mountTrack();
        at(20);
        keys.markIn();
        keys.escape();
        at(22);
        keys.markOut();
        await wrapper.vm.$nextTick();
        // ] alone: a short line, not one from the dropped [.
        expect(lines().at(-1)).toMatchObject({ inSec: 20, outSec: 22 });
    });

    it('removes the picked line, and undoes and redoes its own steps only', async () => {
        const { wrapper, keys, line, blocks } = mountTrack();
        expect(keys.removeSelected()).toBe(false);
        await drag(wrapper, blocks()[1]!.element, 120, 25);
        // Words typed in the list since then must survive an undo of the move.
        await wrapper.setProps({
            modelValue: (wrapper.props('modelValue') as Segment[]).map((l) =>
                l.id === 'a' ? { ...l, label: 'Typed' } : l
            ),
        });
        expect(keys.removeSelected()).toBe(true);
        await wrapper.vm.$nextTick();
        expect(line('a')).toBeUndefined();

        keys.undo();
        await wrapper.vm.$nextTick();
        expect(line('a')).toMatchObject({ inSec: 12.5, outSec: 16.5, label: 'Typed' });
        keys.undo();
        await wrapper.vm.$nextTick();
        expect(line('a')).toMatchObject({ inSec: 10, outSec: 14, label: 'Typed' });
        keys.redo();
        await wrapper.vm.$nextTick();
        expect(line('a')).toMatchObject({ inSec: 12.5, outSec: 16.5 });
    });
});
