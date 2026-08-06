import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const listOrigins = vi.fn();
const revokeOrigin = vi.fn();

vi.mock('../api', () => ({
    listOrigins: (...args: unknown[]) => listOrigins(...args),
    revokeOrigin: (...args: unknown[]) => revokeOrigin(...args),
}));

import TrustedSitesPanel from './TrustedSitesPanel.vue';

async function render() {
    const wrapper = mount(TrustedSitesPanel);
    await flushPromises();
    return wrapper;
}

const rows = (w: Awaited<ReturnType<typeof render>>) => w.findAll('li');

beforeEach(() => {
    listOrigins.mockReset().mockResolvedValue({ allowed: [], denied: [] });
    revokeOrigin.mockReset().mockResolvedValue(undefined);
});

describe('TrustedSitesPanel', () => {
    it('lists allowed and blocked sites', async () => {
        listOrigins.mockResolvedValue({
            allowed: ['https://cms.test'],
            denied: ['https://evil.test'],
        });

        const wrapper = await render();

        expect(wrapper.text()).toContain('https://cms.test');
        expect(wrapper.text()).toContain('https://evil.test');
        expect(wrapper.text()).toContain('Allowed');
        expect(wrapper.text()).toContain('Blocked');
    });

    it('offers a way out for a site the user blocked', async () => {
        // The reason this panel exists: clicking "Block" on your own CMS left
        // you locked out with only a settings file to edit by hand.
        listOrigins.mockResolvedValue({ allowed: [], denied: ['https://cms.test'] });

        const wrapper = await render();
        await rows(wrapper)[0].find('button').trigger('click');

        expect(revokeOrigin).toHaveBeenCalledWith('https://cms.test');
    });

    it('re-reads from the API rather than editing the list in place', async () => {
        // A decision could have been made in a native dialog since this list
        // was drawn, so the API is the holder of the answer.
        listOrigins
            .mockResolvedValueOnce({ allowed: ['https://cms.test'], denied: [] })
            .mockResolvedValueOnce({ allowed: [], denied: [] });

        const wrapper = await render();
        await rows(wrapper)[0].find('button').trigger('click');
        await flushPromises();

        expect(listOrigins).toHaveBeenCalledTimes(2);
        expect(rows(wrapper)).toHaveLength(0);
    });

    it('says so when nothing has ever asked', async () => {
        const wrapper = await render();

        expect(wrapper.text()).toContain('No site has asked yet');
    });

    it('surfaces a load failure instead of showing an empty list', async () => {
        listOrigins.mockRejectedValue(new Error('Connection refused'));

        const wrapper = await render();

        expect(wrapper.text()).toContain('Connection refused');
        expect(wrapper.text()).not.toContain('No site has asked yet');
    });

    it('surfaces a revoke failure and leaves the row in place', async () => {
        listOrigins.mockResolvedValue({ allowed: ['https://cms.test'], denied: [] });
        revokeOrigin.mockRejectedValue(new Error('Nope'));

        const wrapper = await render();
        await rows(wrapper)[0].find('button').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('Nope');
        expect(wrapper.text()).toContain('https://cms.test');
    });

    it('disables only the row being removed', async () => {
        listOrigins.mockResolvedValue({
            allowed: ['https://a.test', 'https://b.test'],
            denied: [],
        });
        let release!: () => void;
        revokeOrigin.mockReturnValue(new Promise<void>((r) => (release = r)));

        const wrapper = await render();
        await rows(wrapper)[0].find('button').trigger('click');

        expect(rows(wrapper)[0].find('button').attributes('disabled')).toBeDefined();
        expect(rows(wrapper)[1].find('button').attributes('disabled')).toBeUndefined();

        release();
        await flushPromises();
    });
});
