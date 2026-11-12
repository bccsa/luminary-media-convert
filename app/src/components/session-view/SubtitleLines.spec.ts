import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Segment } from '../segment-editor';
import SubtitleLines from './SubtitleLines.vue';

const LINES: Segment[] = [
    { id: 'a', inSec: 6, outSec: 10, label: 'Second' },
    { id: 'b', inSec: 0, outSec: 4, label: 'First' },
];

function mountLines(at = 0, lines = LINES) {
    const onSeek = vi.fn();
    const wrapper = mount(SubtitleLines, {
        props: {
            modelValue: lines,
            'onUpdate:modelValue': (next: Segment[]) => wrapper.setProps({ modelValue: next }),
            duration: 60,
            getCurrentTime: () => at,
            onSeek,
        },
        attachTo: document.body,
    });
    return { wrapper, onSeek, lines: () => wrapper.props('modelValue') as Segment[] };
}

describe('SubtitleLines', () => {
    it('lists the lines in time order, with when each shows', () => {
        const { wrapper } = mountLines();
        const rows = wrapper.findAll('[data-test="subtitleLine"]');
        expect(rows.map((r) => r.text())).toEqual([
            expect.stringContaining('0:00.0 – 0:04.0'),
            expect.stringContaining('0:06.0 – 0:10.0'),
        ]);
        expect(wrapper.findAll('[data-test="lineWords"]').map((t) => (t.element as HTMLTextAreaElement).value)).toEqual([
            'First',
            'Second',
        ]);
    });

    it('opens a line chosen in the list, seeks to it, and times it from the playhead', async () => {
        const { wrapper, onSeek, lines } = mountLines(7);
        await wrapper.findAll('[data-test="subtitleLine"]')[1]!.trigger('click');
        expect(onSeek).toHaveBeenCalledWith(6);

        await wrapper.find('[data-test="startHere"]').trigger('click');
        expect(lines().find((l) => l.id === 'a')).toMatchObject({ inSec: 7, outSec: 10 });
        // An end before the start is not a line: it is left as it was.
        await wrapper.find('[data-test="lineEnd"]').setValue('0:05.0');
        await wrapper.find('[data-test="lineEnd"]').trigger('change');
        expect(lines().find((l) => l.id === 'a')).toMatchObject({ inSec: 7, outSec: 10 });
        await wrapper.find('[data-test="lineEnd"]').setValue('0:12.5');
        await wrapper.find('[data-test="lineEnd"]').trigger('change');
        expect(lines().find((l) => l.id === 'a')).toMatchObject({ inSec: 7, outSec: 12.5 });
    });

    it('opens a line picked on the timeline without taking the keyboard', async () => {
        const { wrapper } = mountLines();
        await wrapper.setProps({ selected: 'a' });
        expect(wrapper.find('[data-test="lineStart"]').element).toMatchObject({ value: '0:06.0' });
        expect(wrapper.element.contains(document.activeElement)).toBe(false);
    });

    it('shares the line opened in the list', async () => {
        const { wrapper } = mountLines();
        await wrapper.findAll('[data-test="subtitleLine"]')[0]!.trigger('click');
        expect(wrapper.emitted('update:selected')).toEqual([['b']]);
    });

    it('adds a line at the playhead, up to the next one, ready for its words', async () => {
        const { wrapper, lines } = mountLines(5);
        await wrapper.find('[data-test="addLine"]').trigger('click');
        const added = lines().find((l) => !['a', 'b'].includes(l.id))!;
        expect(added).toMatchObject({ inSec: 5, outSec: 6, label: '' });
        expect(document.activeElement).toBe(wrapper.findAll('[data-test="lineWords"]')[1]!.element);
    });

    it('moves every line together with Shift all', async () => {
        const { wrapper, lines } = mountLines();
        await wrapper.find('[data-test="shiftBy"]').setValue(1.5);
        await wrapper.find('[data-test="shiftLater"]').trigger('click');
        expect(lines().map((l) => [l.id, l.inSec, l.outSec])).toEqual([
            ['a', 7.5, 11.5],
            ['b', 1.5, 5.5],
        ]);
        await wrapper.find('[data-test="shiftEarlier"]').trigger('click');
        expect(lines().map((l) => [l.inSec, l.outSec])).toEqual([[6, 10], [0, 4]]);
    });

    it('walks the lines with Up and Down, in time order', async () => {
        const { wrapper } = mountLines();
        const words = () => wrapper.findAll('[data-test="lineWords"]');
        const [first, second] = words().map((w) => w.element as HTMLTextAreaElement);
        expect([first!.value, second!.value]).toEqual(['First', 'Second']);
        first!.focus();
        await words()[0]!.trigger('keydown', { key: 'ArrowDown' });
        expect(document.activeElement).toBe(second);
        await words()[1]!.trigger('keydown', { key: 'ArrowUp' });
        expect(document.activeElement).toBe(first);
    });

    it('removes a line', async () => {
        const { wrapper, lines } = mountLines();
        await wrapper.findAll('[data-test="removeLine"]')[0]!.trigger('click');
        expect(lines().map((l) => l.id)).toEqual(['a']);
    });
});
