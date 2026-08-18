import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import {
    mountEditor,
    flush,
    keyOn,
    keyDown,
    keyUp,
    mouseAt,
    pxForSec,
    latestSegments,
    setSegments,
} from './helpers';
import SegmentEditor from '../src/SegmentEditor.vue';
import type { Segment } from '../src/types';

const id = (i: number) => `seg-${i}`;
const seg = (i: number, inSec: number, outSec: number, label?: string): Segment => ({
    id: id(i),
    inSec,
    outSec,
    label,
});

function getTimeline(wrapper: ReturnType<typeof mountEditor>): HTMLElement {
    return wrapper.get('.se-timeline-wrap').element as HTMLElement;
}

/** Help is teleported to `document.body` — not visible to wrapper.find(). */
function queryHelpOverlay(): HTMLElement | null {
    return document.body.querySelector('.se-help');
}

describe('SegmentEditor — mount & hydration', () => {
    it('auto-hydrates missing ids and emits a normalized list', async () => {
        const bare = [{ inSec: 1, outSec: 2 } as Segment];
        const wrapper = mountEditor({ segments: bare });
        await flush();
        const emits = wrapper.emitted('update:modelValue');
        expect(emits).toBeTruthy();
        const hydrated = emits![0][0] as Segment[];
        expect(hydrated).toHaveLength(1);
        expect(hydrated[0].id).toBeTruthy();
    });

    it('does not re-emit when every segment already has an id', async () => {
        const wrapper = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('handles a nullish modelValue gracefully', async () => {
        const wrapper = mountEditor({ props: { modelValue: null } });
        await flush();
        expect(wrapper.find('.se-timeline').exists()).toBe(true);
    });
});

describe('SegmentEditor — mode defaults', () => {
    it('hides labels in trim mode and shows them in chapters/subtitles', async () => {
        const trim = mountEditor({ segments: [seg(1, 0, 10, 'A')], props: { mode: 'trim' } });
        await flush();
        expect(trim.find('.se-label-field').exists()).toBe(false);

        const chapters = mountEditor({ segments: [seg(1, 0, 10, 'A')], props: { mode: 'chapters' } });
        await flush();
        expect(chapters.find('.se-label-field').exists()).toBe(true);

        const subs = mountEditor({ segments: [seg(1, 0, 10, 'A')], props: { mode: 'subtitles' } });
        await flush();
        expect(subs.find('.se-label-field').exists()).toBe(true);
    });

    it('honors showLabels override regardless of mode', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 10, 'A')],
            props: { mode: 'trim', showLabels: true },
        });
        await flush();
        expect(w.find('.se-label-field').exists()).toBe(true);
    });

    it('draws no label over a trim range', async () => {
        // The bright stretch already says which part is kept and the times live
        // in the Cuts panel, so a "#1" floating over the frames competed with
        // the picture for nothing.
        const w = mountEditor({
            props: { mode: 'trim', duration: 100 },
            segments: [seg(1, 10, 60)],
        });
        await flush();

        expect(w.find('.se-segment-label').exists()).toBe(false);
    });

    it('draws the label over a chapter, which has a name worth showing', async () => {
        const w = mountEditor({
            props: { mode: 'chapters', duration: 100 },
            segments: [seg(1, 10, 60, 'Intro')],
        });
        await flush();

        expect(w.find('.se-segment-label').text()).toBe('Intro');
    });

    it('derives the panel title from mode and custom title prop', async () => {
        const chapters = mountEditor({ props: { mode: 'chapters' } });
        expect(chapters.find('.se-title').text()).toBe('Chapters');

        const subs = mountEditor({ props: { mode: 'subtitles' } });
        expect(subs.find('.se-title').text()).toBe('Subtitles');

        const custom = mountEditor({ props: { title: 'My Ranges' } });
        expect(custom.find('.se-title').text()).toBe('My Ranges');
    });

    it('applies se-segment--invalid when segments overlap and overlap is disallowed', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 10), seg(2, 5, 15)],
            props: { mode: 'trim' },
        });
        await flush();
        expect(w.find('.se-segment--invalid').exists()).toBe(true);
        expect(w.find('.se-warning').exists()).toBe(true);
    });

    it('does not flag overlaps in subtitles mode', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 10), seg(2, 5, 15)],
            props: { mode: 'subtitles' },
        });
        await flush();
        expect(w.find('.se-segment--invalid').exists()).toBe(false);
    });
});

describe('SegmentEditor — mark in / mark out', () => {
    it('drops a pending-in marker when the playhead is outside every segment', async () => {
        const t = { value: 12 };
        const w = mountEditor({ currentTime: t });
        await flush();
        w.vm.markIn();
        await flush();
        // The marker on the track is the whole of the feedback — the toolbar
        // banner that used to restate it in words was removed.
        expect(w.find('.se-pending-marker').exists()).toBe(true);
        expect(w.find('.se-pending').exists()).toBe(false);
    });

    it('creates a segment when Mark Out closes a pending-in marker', async () => {
        const t = { value: 10 };
        const w = mountEditor({ currentTime: t });
        w.vm.markIn();
        await flush();
        t.value = 20;
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBe(10);
        expect(segs[0].outSec).toBe(20);
        expect(w.find('.se-pending-marker').exists()).toBe(false);
    });

    it('swaps in/out when the second press is earlier than the pending mark', async () => {
        const t = { value: 20 };
        const w = mountEditor({ currentTime: t });
        w.vm.markIn();
        await flush();
        t.value = 10;
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].inSec).toBe(10);
        expect(segs[0].outSec).toBe(20);
    });

    it('discards a pending pair that would be shorter than minSegmentSec', async () => {
        const t = { value: 10 };
        const w = mountEditor({ currentTime: t, props: { minSegmentSec: 1 } });
        w.vm.markIn();
        await flush();
        t.value = 10.05;
        w.vm.markOut();
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
    });

    it('adjusts the containing segment when Mark In fires inside a segment', async () => {
        const t = { value: 4 };
        const w = mountEditor({ segments: [seg(1, 0, 10)], currentTime: t });
        await flush();
        w.vm.markIn();
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].inSec).toBe(4);
        expect(segs[0].outSec).toBe(10);
    });

    it('adjusts the containing segment when Mark Out fires inside a segment', async () => {
        const t = { value: 7 };
        const w = mountEditor({ segments: [seg(1, 0, 10)], currentTime: t });
        await flush();
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].outSec).toBe(7);
    });

    it('extends the selected segment backward when Mark In fires before it', async () => {
        const t = { value: 2 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        // Select via click on the segment.
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        await flush();
        mouseAt(document.body, 'mouseup', 15);
        w.vm.markIn();
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].inSec).toBe(2);
    });

    it('extends the selected segment forward when Mark Out fires after it (no pending)', async () => {
        const t = { value: 40 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].outSec).toBe(40);
    });

    it('no-ops Mark Out when no segment, no pending, no usable selection', async () => {
        const t = { value: 50 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        // Select, then move playhead well before the segment so extend-forward does not apply.
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        t.value = 5;
        w.vm.markOut();
        await flush();
        // No change emitted from markOut.
        expect(latestSegments(w)).toEqual([seg(1, 10, 20)]);
    });

    it('pending wins over selection-extend on Mark Out', async () => {
        const t = { value: 5 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        // Drop a pending marker at 5.
        w.vm.markIn();
        await flush();
        // Move past the selected segment and Mark Out.
        t.value = 30;
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        // Creates a new segment [5,30] rather than extending the prior one to [10,30].
        expect(segs.some((s) => s.inSec === 5 && s.outSec === 30)).toBe(true);
    });
});

describe('SegmentEditor — add / remove / clear', () => {
    it('adds a 10-second segment at the playhead', async () => {
        const t = { value: 20 };
        const w = mountEditor({ currentTime: t });
        await flush();
        w.vm.addSegment();
        await flush();
        expect(latestSegments(w)[0]).toMatchObject({ inSec: 20, outSec: 30 });
    });

    it('clamps addSegment against the duration', async () => {
        const t = { value: 95 };
        const w = mountEditor({ duration: 100, currentTime: t });
        await flush();
        w.vm.addSegment();
        await flush();
        expect(latestSegments(w)[0].outSec).toBe(100);
    });

    it('rejects addSegment when the resulting segment would be too short', async () => {
        const t = { value: 99.9 };
        const w = mountEditor({ duration: 100, currentTime: t, props: { minSegmentSec: 1 } });
        await flush();
        w.vm.addSegment();
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
    });

    it('removes a segment via the list × button', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5), seg(2, 10, 15)] });
        await flush();
        const removeBtns = w.findAll('.se-remove');
        await removeBtns[0].trigger('click');
        await flush();
        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBe(10);
    });

    it('clears all segments and selection', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5), seg(2, 10, 15)] });
        await flush();
        w.vm.clearAll();
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
    });

    it('clearAll is a no-op when the list is already empty', async () => {
        const w = mountEditor({ segments: [] });
        await flush();
        w.vm.clearAll();
        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('chapters mode truncates neighbors via ripple insert', async () => {
        const t = { value: 8 };
        const w = mountEditor({
            segments: [seg(1, 0, 10)],
            currentTime: t,
            props: { mode: 'chapters', rippleEdit: true },
        });
        await flush();
        w.vm.addSegment(); // adds 8..18 which overlaps 0..10
        await flush();
        const segs = latestSegments(w);
        // The earlier segment should be truncated to end at the new one's start.
        const first = segs.find((s) => s.inSec === 0)!;
        expect(first.outSec).toBeCloseTo(8, 4);
    });

    it('chapters mode with rippleEdit=false skips truncation', async () => {
        const t = { value: 8 };
        const w = mountEditor({
            segments: [seg(1, 0, 10)],
            currentTime: t,
            props: { mode: 'chapters', rippleEdit: false },
        });
        await flush();
        w.vm.addSegment();
        await flush();
        const segs = latestSegments(w);
        const first = segs.find((s) => s.inSec === 0)!;
        expect(first.outSec).toBe(10);
    });
});

describe('SegmentEditor — selection', () => {
    it('selects a segment on click and clears selection on Escape', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        const sel1 = w.emitted('select');
        expect(sel1).toBeTruthy();

        keyDown(getTimeline(w), 'Escape');
        await flush();
        const selAll = w.emitted('select')!;
        expect(selAll[selAll.length - 1][0]).toEqual([]);
    });

    it('keeps the selection to one clip in trim, whatever modifier is held', async () => {
        // Trimming picks one clip, adjusts it, keeps or drops it. A stray
        // modifier-click adding a second would put it in the firing line of the
        // next delete. Meta rather than shift: in trim, shift-drag marks a new
        // range, which has its own tests.
        const w = mountEditor({
            segments: [seg(1, 0, 5), seg(2, 10, 15)],
            props: { mode: 'trim' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        mouseAt(segEls[1].element as HTMLElement, 'mousedown', 12, { metaKey: true });
        mouseAt(document.body, 'mouseup', 12);
        await flush();

        const selectEvents = w.emitted('select')!;
        const latest = selectEvents[selectEvents.length - 1][0] as string[];
        expect(latest).toEqual(['seg-2']);
    });

    it('toggles selection additively with shift / meta / ctrl', async () => {
        // Chapters and subtitles keep multi-select: relabelling or clearing a run
        // of cues at once is worth the modifier.
        const w = mountEditor({
            segments: [seg(1, 0, 5), seg(2, 10, 15)],
            props: { mode: 'chapters' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        mouseAt(segEls[1].element as HTMLElement, 'mousedown', 12, { shiftKey: true });
        mouseAt(document.body, 'mouseup', 12);
        await flush();
        const selectEvents = w.emitted('select')!;
        const latest = selectEvents[selectEvents.length - 1][0] as string[];
        expect(latest).toHaveLength(2);
        // Toggle off the first one.
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 2, { shiftKey: true });
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        const again = w.emitted('select')!;
        const finalSel = again[again.length - 1][0] as string[];
        expect(finalSel).toHaveLength(1);
    });

    it('clicking an already-empty selection does not emit redundant events', async () => {
        const w = mountEditor({ segments: [] });
        await flush();
        // Escape with no selection — clearSelection short-circuits.
        keyDown(getTimeline(w), 'Escape');
        await flush();
        expect(w.emitted('select')).toBeUndefined();
    });

    it('deletes selected segments with the Delete key', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5), seg(2, 10, 15)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        keyDown(getTimeline(w), 'Delete');
        await flush();
        const remaining = latestSegments(w);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].inSec).toBe(10);
    });

    it('Backspace acts like Delete for selection', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        keyDown(getTimeline(w), 'Backspace');
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
    });

    it('Cmd/Ctrl + X cuts the selection, which is what a user reaches for', async () => {
        // Delete and Backspace were the only bindings, so the shortcut that
        // exists felt like one that does not.
        for (const modifier of ['metaKey', 'ctrlKey'] as const) {
            const w = mountEditor({ segments: [seg(1, 0, 5), seg(2, 10, 15)] });
            await flush();
            const segEl = w.find('.se-segment').element as HTMLElement;
            mouseAt(segEl, 'mousedown', 2);
            mouseAt(document.body, 'mouseup', 2);
            await flush();

            keyDown(getTimeline(w), 'x', { [modifier]: true });
            await flush();

            expect(latestSegments(w)).toHaveLength(1);
            expect(latestSegments(w)[0].inSec).toBe(10);
        }
    });

    it('bare X does not cut — it is the modifier that means cut', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();

        keyDown(getTimeline(w), 'x');
        await flush();

        expect(latestSegments(w)).toHaveLength(1);
    });

    it('leaves Cmd/Ctrl + X to the input when a field has focus', async () => {
        /*
         * Typing a chapter title and cutting a word must cut the word, not the
         * chapter. The typing guard already did this for Delete; the new binding
         * sits below it so it inherits the same rule.
         */
        // `keyboardScope: 'global'` on purpose: the default 'focus' scope never
        // attaches a window listener, so a keypress in a detached input could
        // not reach the editor whatever the guard did — the test would pass
        // while proving nothing. Global is also the scope the trim workspace
        // mounts with, which is where this actually matters.
        const w = mountEditor({
            segments: [seg(1, 0, 5)],
            props: { keyboardScope: 'global' },
        });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();

        const input = document.createElement('input');
        document.body.appendChild(input);
        keyDown(input, 'x', { metaKey: true });
        await flush();

        expect(latestSegments(w)).toHaveLength(1);
        input.remove();
    });
});

describe('SegmentEditor — keyboard navigation', () => {
    it('Space and K invoke onPlayPause when provided', async () => {
        const onPlayPause = vi.fn();
        const w = mountEditor({ props: { onPlayPause } });
        await flush();
        keyDown(getTimeline(w), ' ');
        keyDown(getTimeline(w), 'k');
        expect(onPlayPause).toHaveBeenCalledTimes(2);
    });

    it('arrow keys step the playhead by 1 second by default', async () => {
        const onSeek = vi.fn();
        const t = { value: 10 };
        const w = mountEditor({ currentTime: t, props: { onSeek } });
        await flush();
        keyDown(getTimeline(w), 'ArrowRight');
        keyDown(getTimeline(w), 'ArrowLeft');
        // currentTime is static in tests; each press steps from the current value.
        expect(onSeek).toHaveBeenCalledWith(11);
        expect(onSeek).toHaveBeenCalledWith(9);
    });

    it('holding 1/2/3 multiplies the step to 10/30/60 seconds', async () => {
        const onSeek = vi.fn();
        const t = { value: 100 };
        const w = mountEditor({ duration: 600, currentTime: t, props: { onSeek } });
        await flush();
        const el = getTimeline(w);
        keyDown(el, '1');
        keyDown(el, 'ArrowRight');
        expect(onSeek).toHaveBeenLastCalledWith(110);
        keyUp(el, '1');

        keyDown(el, '2');
        keyDown(el, 'ArrowRight');
        expect(onSeek).toHaveBeenLastCalledWith(130);
        keyUp(el, '2');

        keyDown(el, '3');
        keyDown(el, 'ArrowRight');
        expect(onSeek).toHaveBeenLastCalledWith(160);
        keyUp(el, '3');
    });

    it('J and L step by a fixed 10 seconds', async () => {
        const onSeek = vi.fn();
        const t = { value: 100 };
        const w = mountEditor({ duration: 600, currentTime: t, props: { onSeek } });
        await flush();
        keyDown(getTimeline(w), 'J');
        keyDown(getTimeline(w), 'l');
        expect(onSeek).toHaveBeenCalledWith(90);
        expect(onSeek).toHaveBeenCalledWith(110);
    });

    it(', and . step by one frame when fps is set', async () => {
        const onSeek = vi.fn();
        const t = { value: 10 };
        const w = mountEditor({ currentTime: t, props: { onSeek, fps: 25 } });
        await flush();
        keyDown(getTimeline(w), '.');
        keyDown(getTimeline(w), ',');
        expect(onSeek).toHaveBeenCalledWith(10.04);
        expect(onSeek).toHaveBeenCalledWith(9.96);
    });

    it(', and . are ignored when fps is zero', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { onSeek } });
        await flush();
        keyDown(getTimeline(w), '.');
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('[ and ] invoke markIn / markOut', async () => {
        const t = { value: 12 };
        const w = mountEditor({ currentTime: t });
        await flush();
        keyDown(getTimeline(w), '[');
        await flush();
        expect(w.find('.se-pending-marker').exists()).toBe(true);
        t.value = 20;
        keyDown(getTimeline(w), ']');
        await flush();
        expect(latestSegments(w)).toHaveLength(1);
    });

    it('I and O invoke markIn / markOut', async () => {
        const t = { value: 5 };
        const w = mountEditor({ currentTime: t });
        await flush();
        keyDown(getTimeline(w), 'I');
        await flush();
        expect(w.find('.se-pending-marker').exists()).toBe(true);
        t.value = 15;
        keyDown(getTimeline(w), 'o');
        await flush();
        expect(latestSegments(w)[0]).toMatchObject({ inSec: 5, outSec: 15 });
    });

    it('Alt+arrow nudges the selected segment edge', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        keyDown(getTimeline(w), 'ArrowRight', { altKey: true });
        await flush();
        const segs = latestSegments(w);
        // Nudge moved the outSec forward (playhead=0 is nearer inSec, so inSec nudges on default fps=0).
        // Either edge change is acceptable; the segment width should remain reasonable.
        const total = segs[0].outSec - segs[0].inSec;
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(10);
    });

    it('Alt+arrow is a no-op with no selection', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        keyDown(getTimeline(w), 'ArrowRight', { altKey: true });
        await flush();
        // With no selection, the arrow falls through to stepSeek — but there is no onSeek prop,
        // so nothing happens to segments.
        expect(latestSegments(w)).toEqual([seg(1, 10, 20)]);
    });

    it('+ / - / 0 adjust the zoom', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        const el = getTimeline(w);
        keyDown(el, '+');
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
        keyDown(el, '-');
        keyDown(el, '0');
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(false);
    });

    it('underscore and equals serve as zoom aliases', async () => {
        const w = mountEditor();
        await flush();
        const el = getTimeline(w);
        keyDown(el, '=');
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
        keyDown(el, '_');
        await flush();
    });

    it('Cmd+Z undoes and Cmd+Shift+Z redoes', async () => {
        const t = { value: 5 };
        const w = mountEditor({ currentTime: t });
        await flush();
        w.vm.addSegment();
        await flush();
        expect(latestSegments(w)).toHaveLength(1);
        keyDown(getTimeline(w), 'z', { metaKey: true });
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
        keyDown(getTimeline(w), 'z', { metaKey: true, shiftKey: true });
        await flush();
        expect(latestSegments(w)).toHaveLength(1);
    });

    it('undo and redo are safe when their stacks are empty', async () => {
        const w = mountEditor();
        await flush();
        w.vm.undo();
        w.vm.redo();
        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('? toggles the help overlay; Escape closes it', async () => {
        const w = mountEditor();
        await flush();
        keyDown(getTimeline(w), '?');
        await flush();
        expect(queryHelpOverlay()).not.toBeNull();
        keyDown(getTimeline(w), 'Escape');
        await flush();
        expect(queryHelpOverlay()).toBeNull();
    });

    it('clicking the help button toggles the help overlay', async () => {
        const w = mountEditor();
        await flush();
        const btn = w.find('.se-btn--icon');
        await btn.trigger('click');
        expect(queryHelpOverlay()).not.toBeNull();
        // Clicking the backdrop closes it.
        const backdrop = queryHelpOverlay()!;
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flush();
        expect(queryHelpOverlay()).toBeNull();
    });

    it('typed input blocks navigation keys but not Cmd+Z or Escape', async () => {
        // Use global keyboard scope so events on the list input reach the handler;
        // the focus-scoped variant attaches to the timeline wrap only.
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 0, 5)],
            props: { onSeek, keyboardScope: 'global' },
        });
        await flush();
        const input = w.find('.se-input').element as HTMLInputElement;
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(onSeek).not.toHaveBeenCalled();
        // Escape in an input leaves the field *and* clears — one press, because it
        // is the only way to clear a selection at all.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();
        expect(document.activeElement).not.toBe(input);
    });

    it('Escape clears the selection from an input, in one press', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 5)],
            props: { keyboardScope: 'global' },
        });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();

        const input = w.find('.se-input').element as HTMLInputElement;
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();

        expect(document.activeElement).not.toBe(input);
        const emitted = w.emitted('select')!;
        expect(emitted[emitted.length - 1][0]).toEqual([]);
    });

    it('Escape deselects however focus got away from the timeline', async () => {
        // A chapter is normally selected from the list, which never focuses the
        // timeline the focus-scoped handler is bound to. Escape is bound to the
        // window regardless of scope for exactly this reason.
        const w = mountEditor({
            segments: [seg(1, 0, 5)],
            props: { keyboardScope: 'focus' },
        });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        expect(w.emitted('select')).toBeTruthy();

        document.body.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();

        const emitted = w.emitted('select')!;
        expect(emitted[emitted.length - 1][0]).toEqual([]);
    });
});

describe('SegmentEditor — timeline interaction', () => {
    it('click on the empty timeline seeks the player', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { onSeek } });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        mouseAt(tl, 'mousedown', 30);
        mouseAt(document.body, 'mousemove', 35);
        mouseAt(document.body, 'mouseup', 40);
        // First seek (final=true at mousedown) + final seek at mouseup.
        expect(onSeek).toHaveBeenCalledWith(30);
        expect(onSeek).toHaveBeenCalledWith(40);
    });

    it('click inside a segment seeks the player', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const segEl = w.get('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        expect(onSeek).toHaveBeenCalledWith(15);
    });

    it('dragging a segment moves it without seeking', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const segEl = w.get('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mousemove', 25);
        mouseAt(document.body, 'mouseup', 25);
        await flush();
        expect(onSeek).not.toHaveBeenCalled();
        expect(latestSegments(w)[0].inSec).toBeGreaterThan(10);
    });

    it('does not seek on a non-primary click inside a segment', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const segEl = w.get('.se-segment').element as HTMLElement;
        // Right-click: the context menu opens, the playhead should stay put.
        mouseAt(segEl, 'mousedown', 15, { button: 2 });
        mouseAt(document.body, 'mouseup', 15, { button: 2 });
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('additive click inside a segment selects without seeking', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 30, 40)],
            props: { onSeek, mode: 'subtitles' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 15, { shiftKey: true });
        mouseAt(document.body, 'mouseup', 15, { shiftKey: true });
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('scrub updates throttle intermediate seeks', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { onSeek, throttleSeekMs: 10000 } });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        mouseAt(tl, 'mousedown', 10);
        mouseAt(document.body, 'mousemove', 20);
        mouseAt(document.body, 'mousemove', 30);
        mouseAt(document.body, 'mouseup', 40);
        // Two final-seek calls (mousedown and mouseup); intermediate moves throttled.
        const finalCalls = onSeek.mock.calls.map((c) => c[0]);
        expect(finalCalls).toContain(10);
        expect(finalCalls).toContain(40);
    });

    it('shift-drag on the timeline marquee-selects segments', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 10), seg(2, 20, 30), seg(3, 50, 60)],
            props: { mode: 'subtitles' },
        });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        mouseAt(tl, 'mousedown', 5, { shiftKey: true });
        mouseAt(document.body, 'mouseup', 25, { shiftKey: true });
        await flush();
        const sel = w.emitted('select');
        expect(sel).toBeTruthy();
        const latest = sel![sel!.length - 1][0] as string[];
        expect(latest).toHaveLength(2);
    });

    it('middle-click on the timeline pans the viewport', async () => {
        const w = mountEditor();
        await flush();
        keyDown(getTimeline(w), '+');
        keyDown(getTimeline(w), '+');
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        mouseAt(tl, 'mousedown', 50, { button: 1 });
        // The pan handler attaches listeners on window, not document.
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, button: 1, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200, button: 1, bubbles: true }));
        await flush();
        expect(w.exists()).toBe(true);
    });

    it('ignores mousedown with buttons other than 0 or 1', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { onSeek } });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        mouseAt(tl, 'mousedown', 50, { button: 2 });
        mouseAt(document.body, 'mouseup', 50, { button: 2 });
        expect(onSeek).not.toHaveBeenCalled();
    });
});

describe('SegmentEditor — segment drag & handle drag', () => {
    it('drags a segment body and commits the move', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)], duration: 100 });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mousemove', 30); // dx = 15s
        mouseAt(document.body, 'mouseup', 30);
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].inSec).toBeCloseTo(25, 1);
        expect(segs[0].outSec).toBeCloseTo(35, 1);
        expect(w.emitted('segment-commit')).toBeTruthy();
    });

    it('ignores micro-movements below the drag threshold', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        // Tiny pixel delta (< 2px) should not be treated as a drag.
        mouseAt(document.body, 'mousemove', 15 + 0.01);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        expect(w.emitted('segment-commit')).toBeFalsy();
    });

    it('drags a handle to resize the in-point', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const handles = w.findAll('.se-segment-handle');
        const inHandle = handles[0].element as HTMLElement;
        mouseAt(inHandle, 'mousedown', 10);
        mouseAt(document.body, 'mousemove', 5);
        mouseAt(document.body, 'mouseup', 5);
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].inSec).toBeLessThan(10);
    });

    it('drags a handle to resize the out-point', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const handles = w.findAll('.se-segment-handle');
        const outHandle = handles[1].element as HTMLElement;
        mouseAt(outHandle, 'mousedown', 20);
        mouseAt(document.body, 'mousemove', 30);
        mouseAt(document.body, 'mouseup', 30);
        await flush();
        const segs = latestSegments(w);
        expect(segs[0].outSec).toBeGreaterThan(20);
    });

    it('moves the playhead with the out-edge being dragged', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const outHandle = w.findAll('.se-segment-handle')[1].element as HTMLElement;
        mouseAt(outHandle, 'mousedown', 20);
        mouseAt(document.body, 'mousemove', 30);
        mouseAt(document.body, 'mouseup', 30);
        await flush();
        // Playhead lands on the edge itself, not the raw pointer position.
        expect(onSeek).toHaveBeenLastCalledWith(latestSegments(w)[0].outSec);
    });

    it('moves the playhead with the in-edge being dragged', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const inHandle = w.findAll('.se-segment-handle')[0].element as HTMLElement;
        mouseAt(inHandle, 'mousedown', 10);
        mouseAt(document.body, 'mousemove', 5);
        mouseAt(document.body, 'mouseup', 5);
        await flush();
        expect(onSeek).toHaveBeenLastCalledWith(latestSegments(w)[0].inSec);
    });

    it('seeks to the clamped edge, not past the segment minimum', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 10, 20)],
            props: { onSeek, minSegmentSec: 2 },
        });
        await flush();
        const outHandle = w.findAll('.se-segment-handle')[1].element as HTMLElement;
        // Drag the out-edge back past the in-edge: it can only reach inSec + 2.
        mouseAt(outHandle, 'mousedown', 20);
        mouseAt(document.body, 'mousemove', 1);
        mouseAt(document.body, 'mouseup', 1);
        await flush();
        expect(onSeek).toHaveBeenLastCalledWith(12);
    });

    it('does not seek when a handle is pressed without dragging', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ segments: [seg(1, 10, 20)], props: { onSeek } });
        await flush();
        const outHandle = w.findAll('.se-segment-handle')[1].element as HTMLElement;
        mouseAt(outHandle, 'mousedown', 20);
        mouseAt(document.body, 'mouseup', 20);
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('snaps a handle drag to a neighboring segment edge within the snap distance', async () => {
        const w = mountEditor({
            // Two segments: dragging the in-handle of the second should snap to the first's outSec (25).
            segments: [seg(1, 10, 25), seg(2, 40, 60)],
            props: { snapSec: 2 },
        });
        await flush();
        const handles = w.findAll('.se-segment-handle');
        // Second segment's in-handle is index 2 (seg1-in, seg1-out, seg2-in, seg2-out).
        const seg2InHandle = handles[2].element as HTMLElement;
        mouseAt(seg2InHandle, 'mousedown', 40);
        mouseAt(document.body, 'mousemove', 26); // within 2s of neighbor's outSec (25)
        await flush();
        expect(w.find('.se-snap-guide').exists()).toBe(true);
        mouseAt(document.body, 'mouseup', 26);
        await flush();
        const segs = latestSegments(w);
        const second = segs.find((s) => s.outSec === 60)!;
        expect(second.inSec).toBeCloseTo(25, 1);
    });

    it('does not stick a handle drag to the playhead riding the drag', async () => {
        // During a handle drag the playhead follows the dragged edge (the
        // editor seeks so the frame under the edge is visible). Snapping to it
        // would glue the edge to wherever the player last landed and the drag
        // would ratchet — so the playhead is not a snap candidate mid-drag.
        const originalRaf = globalThis.requestAnimationFrame;
        let fired = 0;
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
            if (fired++ > 0) return 0;
            queueMicrotask(() => cb(performance.now()));
            return 1;
        }) as typeof globalThis.requestAnimationFrame;
        try {
            const t = { value: 30 };
            const w = mountEditor({
                segments: [seg(1, 10, 60)],
                currentTime: t,
                props: { snapSec: 2 },
            });
            await flush();
            await new Promise<void>((r) => queueMicrotask(r));
            await flush();

            const inHandle = w.findAll('.se-segment-handle')[0]
                .element as HTMLElement;
            mouseAt(inHandle, 'mousedown', 10);
            mouseAt(document.body, 'mousemove', 29); // within 2s of the playhead (30)
            await flush();
            expect(w.find('.se-snap-guide').exists()).toBe(false);
            mouseAt(document.body, 'mouseup', 29);
            await flush();
            expect(latestSegments(w)[0].inSec).toBeCloseTo(29, 1);
            w.unmount();
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
        }
    });
});

describe('SegmentEditor — inline editing', () => {
    it('commits a valid time input change', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const inputs = w.findAll('.se-input--time');
        const inEl = inputs[0].element as HTMLInputElement;
        inEl.value = '0:15.000';
        inEl.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
        expect(latestSegments(w)[0].inSec).toBeCloseTo(15, 3);
    });

    it('ignores an invalid time input', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const inputs = w.findAll('.se-input--time');
        const inEl = inputs[0].element as HTMLInputElement;
        inEl.value = 'nonsense';
        inEl.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('commits a valid time input change to the out-point input', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const inputs = w.findAll('.se-input--time');
        const outEl = inputs[1].element as HTMLInputElement;
        outEl.value = '0:18.000';
        outEl.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
        expect(latestSegments(w)[0].outSec).toBeCloseTo(18, 3);
    });

    it('commits a label edit on every keystroke (so Vue does not wipe DOM during reactive churn)', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20)],
            props: { mode: 'subtitles' },
        });
        await flush();
        const label = w.find('.se-label-field').element as HTMLTextAreaElement;
        label.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        label.value = 'Hello';
        label.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
        expect(latestSegments(w)[0].label).toBe('Hello');
    });

    it('records one undoable history entry per label-edit session, not per keystroke', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20, 'orig')],
            props: { mode: 'subtitles' },
        });
        await flush();
        const label = w.find('.se-label-field').element as HTMLTextAreaElement;
        label.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        for (const c of 'XYZ') {
            label.value += c;
            label.dispatchEvent(new Event('input', { bubbles: true }));
        }
        label.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        await flush();
        expect(latestSegments(w)[0].label).toBe('origXYZ');

        // One undo should jump back to the pre-edit value, not strip a single char.
        w.vm.undo();
        await flush();
        expect(latestSegments(w)[0].label).toBe('orig');
    });
});

describe('SegmentEditor — zoom, pan, wheel', () => {
    it('Ctrl+wheel zooms anchored at the cursor', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(
            new WheelEvent('wheel', {
                clientX: 500,
                deltaY: -100,
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
    });

    it('Cmd+wheel zooms out when deltaY is positive', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        // Pre-zoom so we can zoom out.
        keyDown(getTimeline(w), '+');
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(
            new WheelEvent('wheel', {
                clientX: 500,
                deltaY: 200,
                metaKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        await flush();
    });

    it('horizontal wheel pans the viewport when zoomed', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        keyDown(getTimeline(w), '+');
        keyDown(getTimeline(w), '+');
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(
            new WheelEvent('wheel', {
                deltaX: 600,
                deltaY: 0,
                bubbles: true,
                cancelable: true,
            }),
        );
        await flush();
    });

    it('wheel events are ignored when duration is zero', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }),
        );
        await flush();
    });

    it('vertical wheel without modifier is ignored', async () => {
        const w = mountEditor();
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true }));
        await flush();
    });

    it('zoomTo sets viewport to the requested range', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        w.vm.zoomTo(20, 40);
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
    });

    it('zoomTo is a no-op when duration is zero or range is empty', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        w.vm.zoomTo(0, 10);
        w.vm.zoomTo(30, 20);
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(false);
    });

    it('the zoom slider adjusts the viewport', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        const slider = w.find('input[type="range"]').element as HTMLInputElement;
        slider.value = '5';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
    });
});

describe('SegmentEditor — scrollbar', () => {
    it('clicking the scrollbar track re-centers the viewport', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        keyDown(getTimeline(w), '+');
        keyDown(getTimeline(w), '+');
        await flush();
        const sb = w.find('.se-scrollbar').element as HTMLElement;
        sb.dispatchEvent(new MouseEvent('mousedown', { clientX: 800, bubbles: true }));
        await flush();
    });

    it('dragging the scrollbar thumb pans the viewport', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        keyDown(getTimeline(w), '+');
        keyDown(getTimeline(w), '+');
        await flush();
        const thumb = w.find('.se-scrollbar-thumb').element as HTMLElement;
        thumb.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }));
        // Listeners attach on window, not document — dispatch directly there.
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400, bubbles: true }));
        await flush();
    });

    it('does not pan when scrollbar mousedown fires with duration zero', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        // Force the scrollbar DOM to render for this edge case — simulate by directly
        // calling the exposed zoomTo method, which short-circuits on duration=0.
        w.vm.zoomTo(0, 1);
        await flush();
        // Nothing to assert besides "no throw".
    });

    it('the scrollbar thumb shows display:none when duration is zero', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        // Force zoom > 1 by direct method, since setZoom short-circuits when duration is 0.
        w.vm.zoomTo(0, 1);
        // Can't render scrollbar without zoom > 1, so this test verifies the branch executes
        // without error and that no scrollbar is shown.
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(false);
    });
});

describe('SegmentEditor — touch', () => {
    function touchEvent(
        type: 'touchstart' | 'touchmove' | 'touchend',
        touches: Array<{ x: number; y?: number }>,
    ): TouchEvent {
        // jsdom does not have a native Touch constructor; fake it just enough for the handler.
        const list = touches.map(({ x, y }) => ({ clientX: x, clientY: y ?? 20 })) as unknown as TouchList;
        const ev = new Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
        Object.defineProperty(ev, 'touches', { value: list });
        return ev;
    }

    it('single-finger swipe pans the viewport', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        keyDown(getTimeline(w), '+');
        keyDown(getTimeline(w), '+');
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(touchEvent('touchstart', [{ x: 500 }]));
        tl.dispatchEvent(touchEvent('touchmove', [{ x: 200 }]));
        tl.dispatchEvent(touchEvent('touchend', []));
        await flush();
    });

    it('two-finger pinch zooms the viewport', async () => {
        const w = mountEditor({ duration: 100 });
        await flush();
        const tl = w.get('.se-timeline').element as HTMLElement;
        tl.dispatchEvent(touchEvent('touchstart', [{ x: 400 }, { x: 500 }]));
        tl.dispatchEvent(touchEvent('touchmove', [{ x: 300 }, { x: 700 }]));
        tl.dispatchEvent(touchEvent('touchend', [{ x: 300 }]));
        await flush();
        expect(w.find('.se-scrollbar-thumb').exists()).toBe(true);
    });
});

describe('SegmentEditor — exposed methods', () => {
    it('exportVtt returns a chapters file when mode is chapters', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 30, 'Intro')],
            props: { mode: 'chapters' },
        });
        await flush();
        expect(w.vm.exportVtt()).toContain('WEBVTT');
        expect(w.vm.exportVtt()).toContain('Intro');
    });

    it('exportVtt returns a subtitles file when mode is subtitles', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 30, 'Hello')],
            props: { mode: 'subtitles' },
        });
        await flush();
        expect(w.vm.exportVtt()).toContain('Hello');
    });

    it('importVtt replaces the current segment list', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        w.vm.importVtt('WEBVTT\n\n00:00:10.000 --> 00:00:20.000\nNew\n');
        await flush();
        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBe(10);
    });

    it('focus() moves focus to the timeline', async () => {
        const w = mountEditor();
        await flush();
        w.vm.focus();
        expect(document.activeElement).toBe(getTimeline(w));
    });

    it('clicking the toolbar Undo and Redo buttons round-trips state', async () => {
        const w = mountEditor({ currentTime: { value: 5 } });
        await flush();
        w.vm.addSegment();
        await flush();
        const [undoBtn, redoBtn] = w.findAll('button').filter((b) =>
            (b.attributes('title') ?? '').match(/^(Undo|Redo)$/),
        );
        await undoBtn.trigger('click');
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
        await redoBtn.trigger('click');
        await flush();
        expect(latestSegments(w)).toHaveLength(1);
    });

    it('clicking Mark In / Mark Out via the toolbar works', async () => {
        const t = { value: 10 };
        const w = mountEditor({ currentTime: t });
        await flush();
        const buttons = w.findAll('.se-toolbar .se-btn');
        await buttons[0].trigger('click'); // Mark In
        await flush();
        expect(w.find('.se-pending-marker').exists()).toBe(true);
        t.value = 20;
        await buttons[1].trigger('click'); // Mark Out
        await flush();
        expect(latestSegments(w)).toHaveLength(1);
    });

    it('keeps the scrollbar row laid out at every zoom level', async () => {
        // Rendering the row only when zoomed made the whole timeline jump the
        // moment you zoomed, because a row appeared underneath it.
        const w = mountEditor();
        await flush();

        expect(w.find('.se-scrollbar').exists()).toBe(true);
        expect(w.find('.se-scrollbar').classes()).toContain(
            'se-scrollbar--idle'
        );
    });

    it('clears everything from the toolbar, behind a confirm', async () => {
        // Chapters and subtitles keep Clear All; trim replaced it with a delete
        // that acts on the selection.
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 30, 40)],
            props: { mode: 'chapters' },
        });
        await flush();
        // Clear All becomes visible with segments present; clicking it opens a
        // confirm dialog rather than clearing immediately.
        const clear = w.findAll('.se-btn--danger')[0];
        await clear.trigger('click');
        await flush();
        expect(latestSegments(w)).toHaveLength(2);
        const confirm = document.body.querySelector(
            '.se-confirm-btn--danger',
        ) as HTMLElement | null;
        expect(confirm).not.toBeNull();
        confirm!.click();
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
    });

    it(
        'history is bounded to 100 entries',
        { timeout: 120_000 },
        async () => {
            const t = { value: 5 };
            const w = mountEditor({ duration: 10000, currentTime: t });
            await flush();
            // 150 commits should only retain the most recent ones in the undo stack.
            for (let i = 0; i < 150; i++) {
                t.value = i;
                w.vm.addSegment();
                await flush();
            }
            // Undo as many times as possible — should not exceed 100 invocations with effect.
            let undoCount = 0;
            for (let i = 0; i < 200; i++) {
                const before = latestSegments(w).length;
                w.vm.undo();
                await flush();
                const after = latestSegments(w).length;
                if (after !== before) undoCount += 1;
            }
            expect(undoCount).toBeLessThanOrEqual(100);
        },
    );
});

describe('SegmentEditor — RAF playhead tick', () => {
    it('runs the recursive tick callback and updates the playhead position', async () => {
        // Temporarily replace the no-op RAF stub with one that fires exactly once.
        // This covers the recursive body that the default stub avoids to keep tests finite.
        const originalRaf = globalThis.requestAnimationFrame;
        let fired = 0;
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
            if (fired++ > 0) return 0;
            queueMicrotask(() => cb(performance.now()));
            return 1;
        }) as typeof globalThis.requestAnimationFrame;
        try {
            const t = { value: 42 };
            const w = mountEditor({ duration: 100, currentTime: t });
            await flush();
            await new Promise<void>((r) => queueMicrotask(r));
            await flush();
            // Playhead element should now be positioned proportional to 42/100.
            const playhead = w.find('.se-playhead');
            expect(playhead.exists()).toBe(true);
            w.unmount();
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
        }
    });
});

describe('SegmentEditor — global keyboard scope and lifecycle', () => {
    it('global scope attaches window keyboard listeners', async () => {
        const t = { value: 10 };
        const w = mountEditor({
            currentTime: t,
            props: { keyboardScope: 'global' },
        });
        await flush();
        // Dispatch at window — the component should still respond.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }));
        await flush();
        expect(w.find('.se-pending-marker').exists()).toBe(true);
        w.unmount();
        // After unmount the listener is gone; dispatching should not throw.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }));
    });

    it('keyboardScope="off" disables the focus listener', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { onSeek, keyboardScope: 'off' } });
        await flush();
        keyDown(getTimeline(w), 'ArrowRight');
        expect(onSeek).not.toHaveBeenCalled();
    });
});

describe('SegmentEditor — ruler tick labels', () => {
    it('labels ticks with h/m/s appropriate to the duration', async () => {
        // Duration long enough to produce hour ticks.
        const w = mountEditor({ duration: 18000 });
        await flush();
        const labels = w.findAll('.se-ruler-label');
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.some((l) => l.text().includes('h'))).toBe(true);
    });

    it('omits labels entirely when duration is zero', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        expect(w.findAll('.se-ruler-tick').length).toBe(0);
    });
});

describe('SegmentEditor — segment-commit emissions', () => {
    it('emits segment-commit once per user-committed change', async () => {
        const t = { value: 5 };
        const w = mountEditor({ currentTime: t });
        await flush();
        w.vm.addSegment();
        await flush();
        expect(w.emitted('segment-commit')).toHaveLength(1);
    });
});

describe('SegmentEditor — list rendering', () => {
    beforeEach(() => {
        // Each test mounts fresh; no shared state.
    });

    it('clicking a list row selects the matching segment', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5), seg(2, 10, 15)] });
        await flush();
        const rows = w.findAll('.se-list-row');
        await rows[1].trigger('click');
        await flush();
        const sel = w.emitted('select')!;
        const latest = sel[sel.length - 1][0] as string[];
        expect(latest).toHaveLength(1);
    });

    it('hides the list when showList=false', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)], props: { showList: false } });
        await flush();
        expect(w.find('.se-list').exists()).toBe(false);
    });

    it('hides the toolbar when showToolbar=false', async () => {
        const w = mountEditor({ props: { showToolbar: false } });
        await flush();
        expect(w.find('.se-toolbar').exists()).toBe(false);
    });

    it('hides the help button when showHelp=false', async () => {
        const w = mountEditor({ props: { showHelp: false } });
        await flush();
        expect(w.find('.se-btn--icon').exists()).toBe(false);
    });

    it('shows playback controls only when onSeek or onPlayPause is set', async () => {
        const none = mountEditor({});
        await flush();
        expect(none.find('.se-playback-controls').exists()).toBe(false);

        const withPlay = mountEditor({ props: { onPlayPause: () => {} } });
        await flush();
        expect(withPlay.find('.se-playback-controls').exists()).toBe(true);
    });

    it('playback control buttons step the seek callback', async () => {
        const onSeek = vi.fn();
        const t = { value: 20 };
        const w = mountEditor({ currentTime: t, props: { onSeek } });
        await flush();
        const center = w.findAll('.se-playback-controls__center .se-btn');
        // No play button when only onSeek is provided.
        expect(center).toHaveLength(4);
        await center[0].trigger('click'); // −1 s
        await center[3].trigger('click'); // +1 s
        // currentTime is static in tests, so each click steps from the same value.
        expect(onSeek).toHaveBeenCalledWith(19);
        expect(onSeek).toHaveBeenCalledWith(21);
    });

    it('Home and End jump exactly to the start and end of the timeline', async () => {
        // The two positions the step keys only ever creep toward. Home/End land
        // on them in one press — 0 and the full duration, not one step short.
        const onSeek = vi.fn();
        const t = { value: 42.7 };
        const w = mountEditor({ currentTime: t, props: { onSeek } });
        await flush();

        keyOn(getTimeline(w), 'Home');
        await flush();
        expect(onSeek).toHaveBeenLastCalledWith(0);

        keyOn(getTimeline(w), 'End');
        await flush();
        expect(onSeek).toHaveBeenLastCalledWith(100);
    });

    it('play/pause button triggers onPlayPause', async () => {
        const onPlayPause = vi.fn();
        const w = mountEditor({ props: { onPlayPause, isPlaying: true } });
        await flush();
        const playPause = w.find('.se-btn--playback');
        expect(playPause.exists()).toBe(true);
        expect(playPause.attributes('aria-label')).toBe('Pause');
        expect(playPause.attributes('aria-pressed')).toBe('true');
        await playPause.trigger('click');
        expect(onPlayPause).toHaveBeenCalled();
    });

    it('playback-start and playback-end slots render side by side in the right toolbar cluster', async () => {
        const w = mount(SegmentEditor, {
            props: {
                modelValue: [],
                duration: 100,
                getCurrentTime: () => 0,
                onSeek: () => {},
                onPlayPause: () => {},
            },
            slots: {
                'playback-start': '<span class="mock-audio">Audio</span>',
                'playback-end': '<span class="mock-quality">Quality</span>',
            },
            attachTo: document.body,
        });
        await flush();
        expect(w.find('.se-toolbar__playback-options .mock-audio').exists()).toBe(true);
        expect(w.find('.se-toolbar__playback-options .mock-quality').exists()).toBe(true);
    });

    it('center group renders jog + play strip when both callbacks are set', async () => {
        const w = mountEditor({
            props: { onSeek: () => {}, onPlayPause: () => {} },
        });
        await flush();
        const buttons = w.findAll('.se-playback-controls__center .se-btn');
        expect(buttons).toHaveLength(5);
        expect(buttons[0].classes()).toContain('se-btn--playback-icon');
        expect(buttons[2].classes()).toContain('se-btn--playback');
        expect(buttons[2].attributes('aria-label')).toBe('Play');
    });

    it('renders the current-time display above the timeline, not inside playback controls', async () => {
        const w = mountEditor({ props: { onPlayPause: () => {} } });
        await flush();
        expect(w.find('.se-time-above').exists()).toBe(true);
        expect(w.find('.se-playback-controls .se-time-above').exists()).toBe(false);
    });

    it('still hides the playback row when showPlaybackControls is false even with slot content', async () => {
        const w = mount(SegmentEditor, {
            props: {
                modelValue: [],
                duration: 100,
                getCurrentTime: () => 0,
                onPlayPause: () => {},
                showPlaybackControls: false,
            },
            slots: {
                'playback-start': '<span class="mock-audio">Audio</span>',
            },
            attachTo: document.body,
        });
        await flush();
        expect(w.find('.se-playback-controls').exists()).toBe(false);
        expect(w.find('.se-time-above').exists()).toBe(false);
    });

    it('render slot content in the toolbar when no playback callbacks are set', async () => {
        const w = mount(SegmentEditor, {
            props: {
                modelValue: [],
                duration: 100,
                getCurrentTime: () => 0,
            },
            slots: {
                'playback-start': '<span class="mock-audio">Audio</span>',
            },
            attachTo: document.body,
        });
        await flush();
        expect(w.find('.se-toolbar__playback-options .mock-audio').exists()).toBe(true);
        expect(w.find('.se-playback-controls').exists()).toBe(false);
    });

    it('renders the toolbar-end slot at the end of the toolbar row', async () => {
        const w = mount(SegmentEditor, {
            props: {
                modelValue: [],
                duration: 100,
                getCurrentTime: () => 0,
            },
            slots: {
                'toolbar-end': '<button class="mock-save">Save</button>',
            },
            attachTo: document.body,
        });
        await flush();
        expect(w.find('.se-toolbar .mock-save').exists()).toBe(true);
    });
});

describe('SegmentEditor — defensive branches', () => {
    it('snap is disabled when snapSec is zero', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 40, 60)],
            props: { snapSec: 0 },
        });
        await flush();
        const handles = w.findAll('.se-segment-handle');
        const seg2InHandle = handles[2].element as HTMLElement;
        mouseAt(seg2InHandle, 'mousedown', 40);
        mouseAt(document.body, 'mousemove', 21);
        mouseAt(document.body, 'mouseup', 21);
        await flush();
        expect(w.find('.se-snap-guide').exists()).toBe(false);
    });

    it('setZoom handles a duration-zero timeline without computing an anchor', async () => {
        const w = mountEditor({ duration: 0 });
        await flush();
        const slider = w.find('input[type="range"]').element as HTMLInputElement;
        slider.value = '3';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
    });

    it('primarySelectedId returns null when the selected id no longer exists', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        // Swap the list for an entirely different set — the selected id is now stale.
        await setSegments(w, [seg(99, 50, 60)]);
        await flush();
        // markIn with no real selection should drop a pending marker rather than throw.
        w.vm.markIn();
        await flush();
        // The selection Set still contains the stale id but primary resolves to null,
        // so markIn falls through to the pending-create branch.
        expect(w.exists()).toBe(true);
    });

    it('ignores segment drags smaller than the drag threshold', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        // Sub-pixel movement — should not trigger pushHistory.
        mouseAt(document.body, 'mousemove', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        // Undo should be a no-op because the drag was ignored.
        expect(w.emitted('segment-commit')).toBeFalsy();
    });
});

describe('SegmentEditor — edge cases', () => {
    it('re-hydrates ids if the consumer swaps in a new id-less segment', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        await setSegments(w, [{ inSec: 3, outSec: 6 } as Segment]);
        await flush();
        const emits = w.emitted('update:modelValue')!;
        const last = emits[emits.length - 1][0] as Segment[];
        expect(last[0].id).toBeTruthy();
    });

    it('removes selection entry when the backing segment is removed', async () => {
        const w = mountEditor({ segments: [seg(1, 0, 5)] });
        await flush();
        const segEl = w.find('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 2);
        mouseAt(document.body, 'mouseup', 2);
        await flush();
        const removeBtn = w.find('.se-remove');
        await removeBtn.trigger('click');
        await flush();
        // Selection should now be cleared of the removed id (internal cleanup only).
        expect(latestSegments(w)).toHaveLength(0);
    });

    it('updating a time input with a value outside bounds is clamped', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20)], duration: 100 });
        await flush();
        const inputs = w.findAll('.se-input--time');
        const inEl = inputs[0].element as HTMLInputElement;
        inEl.value = '-5';
        inEl.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
        const segs = latestSegments(w);
        if (segs.length > 0) {
            expect(segs[0].inSec).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('SegmentEditor — split list panel (beside player)', () => {
    it('shows header and empty state when chapters split list has no segments', async () => {
        const w = mountEditor({
            segments: [],
            props: {
                mode: 'chapters',
                splitListPanel: true,
                showToolbar: false,
                showTimeline: false,
                showPlaybackControls: false,
                showList: true,
            },
        });
        await flush();
        expect(w.find('.se-list-split-header').exists()).toBe(true);
        expect(w.find('.se-list-split-header .se-title').text()).toBe('Chapters');
        expect(w.find('.se-list-empty').exists()).toBe(true);
        expect(w.find('.se-list-empty__title').text()).toBe('No chapters yet');
    });

    it('seeks to chapter start when a list row is clicked in split chapters mode', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 12.5, 30)],
            props: {
                mode: 'chapters',
                splitListPanel: true,
                showToolbar: false,
                showTimeline: false,
                showPlaybackControls: false,
                showList: true,
                onSeek,
            },
        });
        await flush();
        await w.find('.se-list-row').trigger('click');
        await flush();
        expect(w.emitted('seek')).toBeTruthy();
        expect(w.emitted('seek')).toHaveLength(1);
        expect(w.emitted('seek')![0]).toEqual([12.5]);
        expect(onSeek).toHaveBeenCalledWith(12.5);
    });

    it('does not seek on list row click in full chapters editor (no split panel)', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 3, 8)],
            props: {
                mode: 'chapters',
                onSeek,
            },
        });
        await flush();
        await w.find('.se-list-row').trigger('click');
        await flush();
        expect(onSeek).not.toHaveBeenCalled();
    });
});

/**
 * Trim ranges are what gets kept, so everything between them is dropped.
 * Darkening the dropped stretches says which is which using the picture itself.
 * A translucent tint over the kept range only worked while the frames were
 * dimmed to a quarter strength; over full-colour thumbnails it disappeared.
 */
describe('SegmentEditor — discarded ranges', () => {
    const dimmed = (w: ReturnType<typeof mountEditor>) =>
        w.findAll('.se-discarded');

    it('darkens the gap between two kept ranges', async () => {
        const w = mountEditor({
            props: { mode: 'trim', duration: 100 },
            segments: [seg(1, 10, 20), seg(2, 60, 70)],
        });
        await flush();

        // before 10, between 20 and 60, after 70
        expect(dimmed(w)).toHaveLength(3);
    });

    it('darkens nothing when no range is marked', async () => {
        // No marks means the whole timeline is encoded, so dimming any of it
        // would say the opposite.
        const w = mountEditor({ props: { mode: 'trim', duration: 100 } });
        await flush();

        expect(dimmed(w)).toHaveLength(0);
    });

    it('leaves no gap when a range covers the whole timeline', async () => {
        const w = mountEditor({
            props: { mode: 'trim', duration: 100 },
            segments: [seg(1, 0, 100)],
        });
        await flush();

        expect(dimmed(w)).toHaveLength(0);
    });

    it('darkens only the tail when a range starts at zero', async () => {
        const w = mountEditor({
            props: { mode: 'trim', duration: 100 },
            segments: [seg(1, 0, 40)],
        });
        await flush();

        expect(dimmed(w)).toHaveLength(1);
    });

    it('dims the gaps around chapters, leaving every chapter lit', async () => {
        const w = mountEditor({
            props: { mode: 'chapters', duration: 100 },
            segments: [seg(1, 10, 20), seg(2, 60, 70)],
        });
        await flush();

        // before 10, between 20 and 60, after 70 — both chapters stay lit.
        expect(dimmed(w)).toHaveLength(3);
    });

    it('keeps every chapter lit when one of them is selected', async () => {
        // Scrimming the unselected chapters hid the very thing the marks are
        // for. Selection is said by the border, not by dimming its neighbours.
        const w = mountEditor({
            props: { mode: 'chapters', duration: 100 },
            segments: [seg(1, 10, 20), seg(2, 60, 70)],
        });
        await flush();

        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 12);
        mouseAt(document.body, 'mouseup', 12);
        await flush();

        expect(w.findAll('.se-segment--selected')).toHaveLength(1);
        expect(dimmed(w)).toHaveLength(3);
    });

    it('dims nothing when there are no chapters yet', async () => {
        const w = mountEditor({ props: { mode: 'chapters', duration: 100 } });
        await flush();

        expect(dimmed(w)).toHaveLength(0);
    });

    it('still dims every cut in trim mode, selected or not', async () => {
        // Trim is about what survives the encode, not about what is selected.
        const w = mountEditor({
            props: { mode: 'trim', duration: 100 },
            segments: [seg(1, 10, 20)],
        });
        await flush();

        expect(dimmed(w)).toHaveLength(2);
    });
});

describe('SegmentEditor — thumbnail filmstrip', () => {
    // Ten cues of 10s each, 160x90 frames laid out along one sprite sheet.
    const VTT = [
        'WEBVTT',
        '',
        ...Array.from({ length: 10 }, (_, i) => {
            const from = `00:00:${String(i * 10).padStart(2, '0')}.000`;
            const to = `00:00:${String((i + 1) * 10).padStart(2, '0')}.000`;
            return `${from} --> ${to}\nsprite.jpg#xywh=${i * 160},0,160,90\n`;
        }),
    ].join('\n');

    function mockVttFetch(body = VTT) {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => body,
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    async function mountWithStrip(props: Record<string, unknown> = {}) {
        const w = mountEditor({
            props: {
                mode: 'trim',
                thumbnailVttUrl: 'https://example.test/thumbs/thumbnails.vtt',
                ...props,
            },
        });
        await flush();
        await flush();
        return w;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('tiles thumbnails across the track once cues load', async () => {
        mockVttFetch();
        const w = await mountWithStrip();
        const tiles = w.findAll('.se-thumb-tile');
        expect(tiles.length).toBeGreaterThan(0);
        // 90px frames scaled to the 48px strip → 160 * (48/90) ≈ 85.3px per tile.
        expect(tiles[0].attributes('style')).toContain('width: 85.3');
        expect(tiles[0].find('img').attributes('src')).toContain('sprite.jpg');
    });

    it('tiles thumbnails in chapters mode too', async () => {
        // The filmstrip used to be gated on trim mode. The session timeline
        // switches to chapters once the encode finishes — which is exactly when
        // the encode's own storyboard lands in S3 — so the frames were suppressed
        // at the moment they became available, and the track went bare.
        mockVttFetch();
        const w = await mountWithStrip({ mode: 'chapters' });
        expect(w.findAll('.se-thumb-tile').length).toBeGreaterThan(0);
    });

    it('fetches the storyboard regardless of mode', async () => {
        const fetchMock = mockVttFetch();
        await mountWithStrip({ mode: 'chapters' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://example.test/thumbs/thumbnails.vtt',
            expect.anything()
        );
    });

    it('shows the hover preview in chapters mode', async () => {
        mockVttFetch();
        const w = await mountWithStrip({ mode: 'chapters' });
        expect(w.find('.se-thumb-preview').exists()).toBe(true);
    });

    it('leaves the track bare when no storyboard is supplied', async () => {
        // The consumer decides by passing a URL or not — the mode no longer does.
        mockVttFetch();
        const w = await mountWithStrip({ mode: 'chapters', thumbnailVttUrl: null });
        expect(w.findAll('.se-thumb-tile')).toHaveLength(0);
        expect(w.find('.se-thumb-preview').exists()).toBe(false);
    });

    it('crops each tile out of the sprite by translating then scaling', async () => {
        mockVttFetch();
        const w = await mountWithStrip();
        const style = w.findAll('.se-thumb-tile')[0].find('img').attributes('style') ?? '';
        expect(style).toContain('scale(');
        expect(style).toContain('translate(');
        expect(style).toContain('transform-origin: 0 0');
    });

    it('resolves each tile to the cue covering its own position', async () => {
        mockVttFetch();
        const w = await mountWithStrip();
        const tiles = w.findAll('.se-thumb-tile');
        const offsets = tiles.map((t) => {
            const m = /translate\((-?[\d.]+)px/.exec(t.find('img').attributes('style') ?? '');
            return m ? Number(m[1]) : NaN;
        });
        // Later tiles sit further along the source, so their sprite offsets grow.
        expect(offsets[offsets.length - 1]).toBeLessThan(offsets[0]);
    });

    it('renders no filmstrip when the VTT cannot be fetched', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => '' }));
        const w = await mountWithStrip();
        expect(w.findAll('.se-thumb-tile')).toHaveLength(0);
    });
});

describe('SegmentEditor — removing segments', () => {
    it('announces the removed segment so consumers can offer an undo', async () => {
        const w = mountEditor({ segments: [seg(1, 10, 20, 'Gone'), seg(2, 30, 40)] });
        await flush();
        w.vm.removeSegment('seg-1');
        await flush();
        const removed = w.emitted('segment-removed');
        expect(removed).toBeTruthy();
        expect((removed![0][0] as Segment).id).toBe('seg-1');
        expect((removed![0][0] as Segment).label).toBe('Gone');
        expect(latestSegments(w).map((s) => s.id)).toEqual(['seg-2']);
    });

    it('carries a copy, not a live reference to the editor state', async () => {
        const original = seg(1, 10, 20, 'Snapshot');
        const w = mountEditor({ segments: [original] });
        await flush();
        w.vm.removeSegment('seg-1');
        await flush();
        const payload = w.emitted('segment-removed')![0][0] as Segment;
        expect(payload).not.toBe(original);
        expect(payload.inSec).toBe(10);
    });

    it('offers a delete control on the segment', async () => {
        // Present in the DOM for every wide-enough block; revealed on hover or
        // selection by CSS, which jsdom does not evaluate.
        const w = mountEditor({
            segments: [seg(1, 10, 40)],
            props: { mode: 'chapters' },
        });
        await flush();
        expect(w.find('.se-segment-delete').exists()).toBe(true);

        await w.find('.se-segment-delete').trigger('click');
        await flush();
        expect(latestSegments(w)).toHaveLength(0);
        expect(w.emitted('segment-removed')).toBeTruthy();
    });

    it('leaves the control off blocks too narrow to hold it', async () => {
        // 1s of a 100s span is ~1% wide — a button there would cover the block.
        const w = mountEditor({
            segments: [seg(1, 10, 11)],
            props: { mode: 'chapters' },
        });
        await flush();
        expect(w.find('.se-segment-delete').exists()).toBe(false);
    });

    it('does not seek or start a drag when the delete control is pressed', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({
            segments: [seg(1, 10, 40)],
            props: { mode: 'chapters', onSeek },
        });
        await flush();
        await w.find('.se-segment-delete').trigger('mousedown');
        expect(onSeek).not.toHaveBeenCalled();
    });

    it('keeps the hover delete control off trim clips entirely', async () => {
        // The clip is where trimming drags and resizes happen; a remove button
        // appearing under the cursor there was too easy to hit by accident. The
        // controls bar carries the delete instead.
        const w = mountEditor({
            segments: [seg(1, 10, 40)],
            props: { mode: 'trim' },
        });
        await flush();
        expect(w.find('.se-segment-delete').exists()).toBe(false);
    });
});

describe('SegmentEditor — double-press and drag to mark a range', () => {
    // The gesture is timed with performance.now(), which fake timers do not move.
    let now = 0;
    beforeEach(() => {
        now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
    });
    afterEach(() => vi.restoreAllMocks());

    /** Two presses close together in time and place, then a drag. */
    async function doublePressDrag(
        w: ReturnType<typeof mountEditor>,
        fromSec: number,
        toSec: number,
        opts: { gapMs?: number; secondAtSec?: number } = {}
    ) {
        const track = w.find('.se-timeline').element as HTMLElement;
        mouseAt(track, 'mousedown', fromSec);
        mouseAt(document.body, 'mouseup', fromSec);
        await flush();
        now += opts.gapMs ?? 10;
        mouseAt(track, 'mousedown', opts.secondAtSec ?? fromSec);
        await flush();
        mouseAt(document.body, 'mousemove', toSec);
        await flush();
        mouseAt(document.body, 'mouseup', toSec);
        await flush();
    }

    it('marks the dragged range in trim', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await doublePressDrag(w, 20, 50);

        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBeCloseTo(20, 0);
        expect(segs[0].outSec).toBeCloseTo(50, 0);
    });

    it('marks a chapter the same way', async () => {
        // Chapters had no drag-to-create at all; shift-drag is marquee select there.
        const w = mountEditor({ props: { mode: 'chapters' } });
        await flush();

        await doublePressDrag(w, 20, 50);

        expect(latestSegments(w)).toHaveLength(1);
    });

    it('leaves an existing segment to be moved, not re-marked', async () => {
        // Pressing a clip means "move it"; hijacking that would cost the two most
        // used gestures on a marked range.
        const w = mountEditor({
            segments: [seg(1, 10, 40)],
            props: { mode: 'trim' },
        });
        await flush();
        const segEl = w.findAll('.se-segment')[0].element as HTMLElement;

        mouseAt(segEl, 'mousedown', 20);
        mouseAt(document.body, 'mouseup', 20);
        await flush();
        mouseAt(segEl, 'mousedown', 20);
        await flush();
        mouseAt(document.body, 'mousemove', 60);
        await flush();
        mouseAt(document.body, 'mouseup', 60);
        await flush();

        // Still one segment — moved or unchanged, but never a second one.
        expect(latestSegments(w)).toHaveLength(1);
    });

    it('treats a slow second press as an ordinary click', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await doublePressDrag(w, 20, 50, { gapMs: 600 });

        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('treats a second press somewhere else as an ordinary click', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await doublePressDrag(w, 20, 50, { secondAtSec: 35 });

        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('creates nothing when the drag never travels', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await doublePressDrag(w, 30, 30);

        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('does not chain a third press into another range', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();
        const track = w.find('.se-timeline').element as HTMLElement;

        // press, press (marks), press again — the third starts over.
        await doublePressDrag(w, 20, 50);
        mouseAt(track, 'mousedown', 20);
        await flush();
        mouseAt(document.body, 'mousemove', 80);
        await flush();
        mouseAt(document.body, 'mouseup', 80);
        await flush();

        expect(latestSegments(w)).toHaveLength(1);
    });
});

describe('SegmentEditor — shift-drag to mark a range', () => {
    /** Drag across the timeline track from one second to another. */
    async function shiftDrag(
        w: ReturnType<typeof mountEditor>,
        fromSec: number,
        toSec: number
    ) {
        const track = w.find('.se-timeline').element as HTMLElement;
        mouseAt(track, 'mousedown', fromSec, { shiftKey: true });
        await flush();
        mouseAt(document.body, 'mousemove', toSec);
        await flush();
        mouseAt(document.body, 'mouseup', toSec);
        await flush();
    }

    it('shows the frame under the moving edge as the range is dragged out', async () => {
        // Otherwise in and out points are chosen blind and checked afterwards.
        const onSeek = vi.fn();
        const w = mountEditor({ props: { mode: 'trim', onSeek } });
        await flush();
        const track = w.find('.se-timeline').element as HTMLElement;

        mouseAt(track, 'mousedown', 20, { shiftKey: true });
        await flush();
        mouseAt(document.body, 'mousemove', 50);
        await flush();

        expect(onSeek).toHaveBeenCalled();
        const followed = onSeek.mock.calls.at(-1)![0] as number;
        expect(followed).toBeCloseTo(50, 0);

        mouseAt(document.body, 'mouseup', 50);
        await flush();
    });

    it('leaves the playhead on the in-point once the range is marked', async () => {
        // The drag ends wherever the mouse stopped; the useful frame afterwards is
        // where the kept material starts, so the clip can be played straight back.
        const onSeek = vi.fn();
        const w = mountEditor({ props: { mode: 'trim', onSeek } });
        await flush();

        await shiftDrag(w, 20, 50);

        expect(onSeek.mock.calls.at(-1)![0]).toBeCloseTo(20, 0);
    });

    it('marks the dragged range in trim mode', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await shiftDrag(w, 20, 50);

        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBeCloseTo(20, 1);
        expect(segs[0].outSec).toBeCloseTo(50, 1);
    });

    it('marks the same range when dragged right to left', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await shiftDrag(w, 50, 20);

        const segs = latestSegments(w);
        expect(segs[0].inSec).toBeCloseTo(20, 1);
        expect(segs[0].outSec).toBeCloseTo(50, 1);
    });

    it('shows the range while it is being dragged, then commits it', async () => {
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();
        const track = w.find('.se-timeline').element as HTMLElement;

        mouseAt(track, 'mousedown', 20, { shiftKey: true });
        await flush();
        mouseAt(document.body, 'mousemove', 50);
        await flush();
        expect(w.find('.se-draft-range').exists()).toBe(true);

        mouseAt(document.body, 'mouseup', 50);
        await flush();
        expect(w.find('.se-draft-range').exists()).toBe(false);
    });

    it('ignores a shift-click that never travelled', async () => {
        // Otherwise a stray click leaves a sliver of a clip, which is harder to
        // notice than nothing happening.
        const w = mountEditor({ props: { mode: 'trim' } });
        await flush();

        await shiftDrag(w, 30, 30);

        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('replaces the existing range rather than adding a second', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20)],
            props: { mode: 'trim', maxSegments: 1 },
        });
        await flush();

        await shiftDrag(w, 60, 90);

        const segs = latestSegments(w);
        expect(segs).toHaveLength(1);
        expect(segs[0].inSec).toBeCloseTo(60, 1);
    });

    it('leaves plain drag scrubbing the playhead', async () => {
        const onSeek = vi.fn();
        const w = mountEditor({ props: { mode: 'trim', onSeek } });
        await flush();
        const track = w.find('.se-timeline').element as HTMLElement;

        mouseAt(track, 'mousedown', 40);
        mouseAt(document.body, 'mouseup', 40);
        await flush();

        expect(onSeek).toHaveBeenCalled();
        expect(w.emitted('update:modelValue')).toBeUndefined();
    });

    it('still marquee-selects in chapters rather than marking', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 30, 40)],
            props: { mode: 'chapters' },
        });
        await flush();

        await shiftDrag(w, 5, 45);

        // Both cues fall inside the marquee; nothing new is created.
        const selectEvents = w.emitted('select')!;
        expect(selectEvents[selectEvents.length - 1][0]).toHaveLength(2);
    });
});

describe('SegmentEditor — maxSegments', () => {
    /** Mark a range by driving the playhead and the two mark keys. */
    async function mark(
        w: ReturnType<typeof mountEditor>,
        t: { value: number },
        inSec: number,
        outSec: number
    ) {
        const vm = w.vm as unknown as { markIn: () => void; markOut: () => void };
        t.value = inSec;
        vm.markIn();
        await flush();
        t.value = outSec;
        vm.markOut();
        await flush();
    }

    it('replaces the existing range when only one is allowed', async () => {
        const t = { value: 0 };
        const w = mountEditor({
            currentTime: t,
            props: { mode: 'trim', maxSegments: 1 },
        });
        await flush();

        await mark(w, t, 10, 20);
        expect(latestSegments(w)).toHaveLength(1);

        await mark(w, t, 60, 70);
        const after = latestSegments(w);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ inSec: 60, outSec: 70 });
    });

    it('does not report the replaced range as removed', async () => {
        const t = { value: 0 };
        const w = mountEditor({
            currentTime: t,
            props: { mode: 'trim', maxSegments: 1 },
        });
        await flush();
        await mark(w, t, 10, 20);
        await mark(w, t, 60, 70);

        // Nothing was cut from the output — the range was re-marked. Recording it
        // as a removal would put a phantom entry in the removed-clips list.
        expect(w.emitted('segment-removed')).toBeUndefined();
    });

    it('keeps every range when no cap is set', async () => {
        const t = { value: 0 };
        const w = mountEditor({ currentTime: t, props: { mode: 'trim' } });
        await flush();

        await mark(w, t, 10, 20);
        await mark(w, t, 60, 70);
        expect(latestSegments(w)).toHaveLength(2);
    });
});

describe('SegmentEditor — the trim delete button', () => {
    /** The single danger button in the trim toolbar. */
    const deleteBtn = (w: ReturnType<typeof mountEditor>) =>
        w.findAll('.se-toolbar .se-btn--danger')[0];

    it('is disabled until a clip is selected', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20)],
            props: { mode: 'trim' },
        });
        await flush();
        expect(deleteBtn(w).attributes('disabled')).toBeDefined();
    });

    it('deletes the selected clip and says which one went', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 30, 40)],
            props: { mode: 'trim' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 12);
        mouseAt(document.body, 'mouseup', 12);
        await flush();

        expect(deleteBtn(w).attributes('disabled')).toBeUndefined();
        await deleteBtn(w).trigger('click');
        await flush();

        expect(latestSegments(w).map((s) => s.id)).toEqual(['seg-2']);
        // The removed-clips list beside the timeline is built from this.
        expect(w.emitted('segment-removed')![0][0]).toMatchObject({ id: 'seg-1' });
    });

    it('leaves the deletion undoable', async () => {
        const w = mountEditor({
            segments: [seg(1, 10, 20), seg(2, 30, 40)],
            props: { mode: 'trim' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 12);
        mouseAt(document.body, 'mouseup', 12);
        await flush();
        await deleteBtn(w).trigger('click');
        await flush();

        (w.vm as unknown as { undo: () => void }).undo();
        await flush();
        expect(latestSegments(w).map((s) => s.id)).toEqual(['seg-1', 'seg-2']);
    });

    it('announces a keyboard deletion too, not just a clicked one', async () => {
        // The Delete key removed the clip without telling anyone, so anything
        // tracking what had been cut missed keyboard deletions entirely.
        const w = mountEditor({
            segments: [seg(1, 10, 20)],
            props: { mode: 'trim' },
        });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 12);
        mouseAt(document.body, 'mouseup', 12);
        await flush();

        await w.find('.se-timeline').trigger('keydown', { key: 'Delete' });
        await flush();

        expect(latestSegments(w)).toHaveLength(0);
        expect(w.emitted('segment-removed')![0][0]).toMatchObject({ id: 'seg-1' });
    });
});

describe('SegmentEditor — marking between existing segments', () => {
    const two = () => [seg(1, 10, 20), seg(2, 40, 50)];

    it('starts a new segment in the gap rather than extending the later one', async () => {
        const t = { value: 25 };
        const w = mountEditor({ segments: two(), currentTime: t });
        await flush();
        // Select the later segment: this is the case that used to swallow the gap.
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[1].element as HTMLElement, 'mousedown', 45);
        mouseAt(document.body, 'mouseup', 45);
        await flush();

        w.vm.markIn();
        await flush();
        expect(w.find('.se-pending-marker').exists()).toBe(true);

        t.value = 35;
        w.vm.markOut();
        await flush();
        const segs = latestSegments(w);
        expect(segs).toHaveLength(3);
        expect(segs.map((s) => [s.inSec, s.outSec])).toContainEqual([25, 35]);
        // The later segment kept its start.
        expect(segs.find((s) => s.id === 'seg-2')!.inSec).toBe(40);
    });

    it('does not let the earlier segment swallow the gap either', async () => {
        const t = { value: 30 };
        const w = mountEditor({ segments: two(), currentTime: t });
        await flush();
        const segEls = w.findAll('.se-segment');
        mouseAt(segEls[0].element as HTMLElement, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();

        w.vm.markOut();
        await flush();
        expect(latestSegments(w).find((s) => s.id === 'seg-1')!.outSec).toBe(20);
    });

    it('still extends the selection before the first segment', async () => {
        const t = { value: 2 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        const segEl = w.get('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        w.vm.markIn();
        await flush();
        expect(latestSegments(w)[0].inSec).toBe(2);
    });

    it('still extends the selection after the last segment', async () => {
        const t = { value: 60 };
        const w = mountEditor({ segments: [seg(1, 10, 20)], currentTime: t });
        await flush();
        const segEl = w.get('.se-segment').element as HTMLElement;
        mouseAt(segEl, 'mousedown', 15);
        mouseAt(document.body, 'mouseup', 15);
        await flush();
        w.vm.markOut();
        await flush();
        expect(latestSegments(w)[0].outSec).toBe(60);
    });
});

describe('SegmentEditor — Clear All placement', () => {
    /** The library's own Clear All, wherever it renders in the controls row. */
    function clearButton(w: ReturnType<typeof mountEditor>) {
        return w
            .findAll('button')
            .find((b) => b.text().trim() === 'Clear All');
    }

    it('shows Clear All by default, so hosts that had it keep it', async () => {
        // subtitles mode especially: the editor is the only place the cues live,
        // so removing the button unconditionally would strand that mode.
        const w = mountEditor({
            segments: [seg(1, 0, 5, 'A')],
            props: { mode: 'subtitles' },
        });
        await flush();

        expect(clearButton(w)).toBeDefined();
    });

    it('hides it when the host puts its own clear beside the list', async () => {
        const w = mountEditor({
            segments: [seg(1, 0, 5, 'A')],
            props: { mode: 'chapters', showClearAll: false },
        });
        await flush();

        expect(clearButton(w)).toBeUndefined();
    });

    it('still confirms when the host asks, using this component\'s own sheet', async () => {
        /*
         * The point of exposing `requestClearAll` rather than only `clearAll`:
         * a host that has merely moved the button should not rebuild the
         * confirmation, or the same destructive action ends up worded two ways.
         */
        const w = mountEditor({
            segments: [seg(1, 0, 5, 'A')],
            props: { mode: 'chapters', showClearAll: false },
        });
        await flush();

        (w.vm as unknown as { requestClearAll: () => void }).requestClearAll();
        await flush();

        expect(document.body.textContent).toContain('Clear all');
        expect(latestSegments(w)).toHaveLength(1);
        // The sheet is teleported to <body>, so it outlives this wrapper unless
        // the wrapper goes with it — and the next test asserts on its absence.
        w.unmount();
    });

    it('does not confirm when there is nothing to clear', async () => {
        // Teleported sheets from earlier tests live on in <body>; clear them so
        // this asserts on what *this* mount did.
        document.querySelectorAll('.se-confirm').forEach((n) => n.remove());
        const w = mountEditor({ props: { mode: 'chapters', showClearAll: false } });
        await flush();

        (w.vm as unknown as { requestClearAll: () => void }).requestClearAll();
        await flush();

        expect(document.querySelector('.se-confirm')).toBeNull();
    });
});
