import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import LanguageSelect from './LanguageSelect.vue';

const mounted: VueWrapper[] = [];

function mountSelect(modelValue?: string) {
    const wrapper = mount(LanguageSelect, {
        props: { modelValue },
        attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
}

function panel(): HTMLElement | null {
    return document.body.querySelector('.ecf-menu-panel');
}

function search(): HTMLInputElement {
    return document.body.querySelector('[data-menu-search]')!;
}

function optionTexts(): string[] {
    return Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (li) =>
            Array.from(li.querySelectorAll('span'))
                .map((span) => span.textContent!.trim())
                .join(' '),
    );
}

async function typeSearch(value: string) {
    const input = search();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r));
}

afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount();
});

describe('LanguageSelect', () => {
    it('renders no datalist and no options until opened', () => {
        mountSelect('eng');
        expect(document.body.querySelector('datalist')).toBeNull();
        expect(panel()).toBeNull();
    });

    it('opens on click with the search focused and the current code checked', async () => {
        const wrapper = mountSelect('eng');
        await wrapper.find('button').trigger('click');
        await new Promise((r) => setTimeout(r));
        expect(panel()).not.toBeNull();
        expect(document.activeElement).toBe(search());
        const selected = document.body.querySelector('[aria-selected="true"]');
        expect(selected?.textContent).toContain('English');
    });

    it('filters by name and ranks an exact code first', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        await typeSearch('ger');
        const texts = optionTexts();
        expect(texts[0]).toBe('ger German');
        expect(texts).toContain('deu German');

        await typeSearch('french');
        expect(optionTexts().every((t) => /french/i.test(t))).toBe(true);
    });

    it('emits the highlighted code on Enter and closes', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        await typeSearch('afrikaans');
        search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await new Promise((r) => setTimeout(r));
        expect(wrapper.emitted('update:modelValue')).toEqual([['afr']]);
        expect(panel()).toBeNull();
    });

    it('offers a typed local-use code, which the register cannot list', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        await typeSearch('qab');
        expect(optionTexts()[0]).toBe('qab Local use');
    });

    it('says so when nothing matches', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        await typeSearch('xyzzy');
        expect(optionTexts()).toEqual([]);
        expect(panel()!.textContent).toContain('No language matches');
    });

    it('lets a typed letter open the list and start the search', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('keydown', { key: 's' });
        await new Promise((r) => setTimeout(r));
        expect(search().value).toBe('s');
    });

    it('leaves plain arrow keys to the host while closed', async () => {
        const wrapper = mountSelect();
        const ev = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            cancelable: true,
        });
        wrapper.find('button').element.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r));
        expect(ev.defaultPrevented).toBe(false);
        expect(panel()).toBeNull();
    });

    it('marks a code that is not a language', () => {
        const wrapper = mountSelect('zzz');
        expect(wrapper.find('button').classes()).toContain('ecf-input-invalid');
        expect(wrapper.find('button').attributes('title')).toContain(
            'not an ISO 639-2 code',
        );
    });

    it('can clear the language back to unspecified', async () => {
        const wrapper = mountSelect('eng');
        await wrapper.find('button').trigger('click');
        await new Promise((r) => setTimeout(r));
        (document.body.querySelector('[role="option"]') as HTMLElement).click();
        expect(wrapper.emitted('update:modelValue')).toEqual([['']]);
    });
});
