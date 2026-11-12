import { afterEach, describe, expect, it } from 'vitest';
import { stepBetweenFields } from './fieldWalk';

function fields(...values: string[]): HTMLTextAreaElement[] {
    return values.map((value) => {
        const el = document.createElement('textarea');
        el.value = value;
        document.body.appendChild(el);
        return el;
    });
}

function press(el: HTMLTextAreaElement, key: string, all: HTMLTextAreaElement[], init: KeyboardEventInit = {}) {
    const e = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
    el.dispatchEvent(e);
    return { moved: stepBetweenFields(Object.defineProperty(e, 'target', { value: el }), all), e };
}

afterEach(() => document.body.replaceChildren());

describe('stepBetweenFields', () => {
    it('moves down and up with the caret at the end of the text', () => {
        const all = fields('One', 'Two');
        all[0]!.focus();
        const { moved, e } = press(all[0]!, 'ArrowDown', all);
        expect(moved).toBe(all[1]);
        expect(document.activeElement).toBe(all[1]);
        expect(all[1]!.selectionStart).toBe(3);
        expect(e.defaultPrevented).toBe(true);
        press(all[1]!, 'ArrowUp', all);
        expect(document.activeElement).toBe(all[0]);
    });

    it('stays put at either end', () => {
        const all = fields('One', 'Two');
        expect(press(all[0]!, 'ArrowUp', all).moved).toBeNull();
        expect(press(all[1]!, 'ArrowDown', all).moved).toBeNull();
    });

    it('moves the caret through a two-line subtitle before leaving it', () => {
        const all = fields('One', 'Top line\nbottom line', 'Three');
        const two = all[1]!;
        two.setSelectionRange(3, 3);
        expect(press(two, 'ArrowDown', all).moved).toBeNull();
        expect(press(two, 'ArrowUp', all).moved).toBeNull();
        two.setSelectionRange(two.value.length, two.value.length);
        expect(press(two, 'ArrowDown', all).moved).toBe(all[2]);
        two.setSelectionRange(0, 0);
        expect(press(two, 'ArrowUp', all).moved).toBe(all[0]);
    });

    it('leaves a selection, other keys, and arrows with a modifier to the browser', () => {
        const all = fields('One', 'Two');
        expect(press(all[0]!, 'ArrowDown', all, { shiftKey: true }).moved).toBeNull();
        expect(press(all[0]!, 'ArrowDown', all, { metaKey: true }).moved).toBeNull();
        expect(press(all[0]!, 'Enter', all).moved).toBeNull();
        all[0]!.setSelectionRange(0, 2);
        expect(press(all[0]!, 'ArrowDown', all).moved).toBeNull();
    });
});
