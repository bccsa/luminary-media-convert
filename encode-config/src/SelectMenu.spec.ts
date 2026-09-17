import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import SelectMenu, { type SelectMenuOption } from './SelectMenu.vue';

const CHANNELS: SelectMenuOption[] = [
    { value: 1, label: 'Mono' },
    { value: 2, label: 'Stereo' },
    { value: 6, label: '5.1', disabled: true },
    { value: 8, label: '7.1' },
];

const mounted: VueWrapper[] = [];

function mountMenu(props: Record<string, unknown> = {}) {
    const wrapper = mount(SelectMenu, {
        props: { modelValue: 2, options: CHANNELS, ...props },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

const tick = () => new Promise((r) => setTimeout(r));

function panel(): HTMLElement | null {
    return document.body.querySelector('.ecf-menu-panel');
}

function key(el: Element, k: string) {
    const ev = new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true });
    el.dispatchEvent(ev);
    return ev;
}

afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount();
});

describe('SelectMenu', () => {
    it('shows the selected label on the trigger and nothing else until opened', () => {
        const wrapper = mountMenu();
        expect(wrapper.find('button').text()).toBe('Stereo');
        expect(panel()).toBeNull();
    });

    it('opens without a search field unless asked for one', async () => {
        const wrapper = mountMenu();
        await wrapper.find('button').trigger('click');
        expect(panel()).not.toBeNull();
        expect(document.body.querySelector('[data-menu-search]')).toBeNull();
        expect(document.body.querySelector('[aria-selected="true"]')?.textContent).toContain('Stereo');
    });

    it('picks with the keyboard from the trigger, skipping disabled rows', async () => {
        const wrapper = mountMenu();
        const button = wrapper.find('button').element;
        key(button, 'Enter');
        await tick();
        key(button, 'ArrowDown');
        await tick();
        key(button, 'Enter');
        await tick();
        expect(wrapper.emitted('update:modelValue')).toEqual([[8]]);
        expect(wrapper.emitted('change')).toEqual([[8]]);
        expect(panel()).toBeNull();
    });

    it('does not report a change when the same option is picked again', async () => {
        const wrapper = mountMenu();
        await wrapper.find('button').trigger('click');
        (document.body.querySelector('[aria-selected="true"]') as HTMLElement).click();
        expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
        expect(wrapper.emitted('change')).toBeUndefined();
    });

    it('ignores clicks on a disabled option', async () => {
        const wrapper = mountMenu();
        await wrapper.find('button').trigger('click');
        (document.body.querySelector('[aria-disabled="true"]') as HTMLElement).click();
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(panel()).not.toBeNull();
    });

    it('leaves plain arrow keys to the host while closed', () => {
        const wrapper = mountMenu();
        expect(key(wrapper.find('button').element, 'ArrowDown').defaultPrevented).toBe(false);
        expect(panel()).toBeNull();
    });

    it('does not open when disabled', async () => {
        const wrapper = mountMenu({ disabled: true });
        await wrapper.find('button').trigger('click');
        expect(panel()).toBeNull();
    });

    it('closes on Escape and hands focus back to the trigger', async () => {
        const wrapper = mountMenu();
        const button = wrapper.find('button').element;
        await wrapper.find('button').trigger('click');
        key(button, 'Escape');
        await tick();
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(button);
    });

    it('filters by label when searchable', async () => {
        const wrapper = mountMenu({ searchable: true });
        await wrapper.find('button').trigger('click');
        const input = document.body.querySelector<HTMLInputElement>('[data-menu-search]')!;
        input.value = 'st';
        input.dispatchEvent(new Event('input'));
        await tick();
        const labels = Array.from(document.body.querySelectorAll('[role="option"]')).map((li) => li.textContent!.trim());
        expect(labels).toEqual(['Stereo']);
    });

    describe('panel alignment', () => {
        function place(wrapper: VueWrapper, left: number, width: number, viewport: number) {
            Object.defineProperty(window, 'innerWidth', { value: viewport, configurable: true });
            Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
            wrapper.find('button').element.getBoundingClientRect = () =>
                ({ left, right: left + width, top: 100, bottom: 130, width, height: 30 }) as DOMRect;
        }

        it('shares the trigger’s left edge and is at least as wide', async () => {
            const wrapper = mountMenu();
            place(wrapper, 400, 88, 1280);
            await wrapper.find('button').trigger('click');
            expect(panel()!.style.left).toBe('400px');
            expect(panel()!.style.minWidth).toBe('88px');
        });

        it('narrows a searchable panel rather than sliding it left near the window edge', async () => {
            const wrapper = mountMenu({ searchable: true });
            place(wrapper, 400, 76, 640);
            await wrapper.find('button').trigger('click');
            expect(panel()!.style.left).toBe('400px');
            expect(panel()!.style.width).toBe('232px');
        });

        it('shares the trigger’s right edge when there is no room to its right', async () => {
            const wrapper = mountMenu({ searchable: true });
            place(wrapper, 500, 76, 640);
            await wrapper.find('button').trigger('click');
            expect(panel()!.style.left).toBe('');
            expect(panel()!.style.right).toBe('64px');
        });
    });
});
