// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import AccountMenu from './AccountMenu.vue';

/**
 * `useTheme` asks the browser what the system scheme is; jsdom has no
 * `matchMedia`, so the component cannot mount without this.
 */
function stubMatchMedia(prefersDark = false): void {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
            matches: prefersDark,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }),
    });
}

/** Open the panel and hand back the three theme rows. */
async function openMenu() {
    const wrapper = mount(AccountMenu);
    await wrapper.find('button[aria-label="Appearance"]').trigger('click');
    return { wrapper, rows: wrapper.findAll('[role="menuitemradio"]') };
}

describe('AccountMenu', () => {
    beforeEach(() => {
        stubMatchMedia();
        localStorage.clear();
        document.documentElement.classList.remove('dark');
    });

    it('offers the three appearance choices as one radio group', async () => {
        /*
         * The visible checkmark is gone — selection is carried by the row fill
         * and the icon colour now — so `menuitemradio` + `aria-checked` is the
         * only thing left saying these are three states of one setting rather
         * than three unrelated buttons.
         */
        const { rows } = await openMenu();

        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.text())).toEqual(['Light', 'Auto', 'Dark']);
    });

    it('marks exactly the current preference as checked', async () => {
        const { wrapper, rows } = await openMenu();

        // Default preference is 'system', the middle row.
        expect(rows.map((r) => r.attributes('aria-checked'))).toEqual([
            'false',
            'true',
            'false',
        ]);

        await rows[2]!.trigger('click');
        await wrapper.find('button[aria-label="Appearance"]').trigger('click');

        expect(
            wrapper
                .findAll('[role="menuitemradio"]')
                .map((r) => r.attributes('aria-checked'))
        ).toEqual(['false', 'false', 'true']);
    });

    it('keeps the description as the accessible name, having dropped the second line', async () => {
        // "Auto" alone does not say what it does; losing the description line
        // from the panel should not lose the explanation entirely.
        const { rows } = await openMenu();

        expect(rows[1]!.attributes('aria-label')).toBe('Auto — Match system');
        expect(rows[1]!.attributes('title')).toBe('Match system');
    });

    it('closes on selection', async () => {
        // Three mutually exclusive options: after the click there is nothing
        // left to choose, and staying open read as though it had not registered.
        const { wrapper, rows } = await openMenu();

        await rows[0]!.trigger('click');

        expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    });

    it('applies the choice', async () => {
        const { rows } = await openMenu();

        await rows[2]!.trigger('click');

        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
});
