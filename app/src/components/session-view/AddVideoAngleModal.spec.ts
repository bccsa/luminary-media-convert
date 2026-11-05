import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const { probe, add } = vi.hoisted(() => ({ probe: vi.fn(), add: vi.fn() }));
vi.mock('../../api', () => ({ probeVideoSource: probe, addVideoAngle: add }));

import AddVideoAngleModal from './AddVideoAngleModal.vue';

const mountForm = (namesMain = false) =>
    mount(AddVideoAngleModal, {
        props: {
            open: true,
            sessionId: 'sess-1',
            sessionToken: 'sess_token',
            etag: 'v1',
            namesMain,
        },
        global: { stubs: { teleport: true } },
    });

async function read(wrapper: ReturnType<typeof mountForm>): Promise<void> {
    await wrapper
        .find('[data-test="angleFilePath"]')
        .setValue('/media/pulpit.mov');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
}

beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { luminary?: unknown }).luminary;
    probe.mockResolvedValue({
        durationSec: 600,
        videoTracks: [{ index: 0, width: 1920, height: 1080, frameRate: 25 }],
    });
    add.mockResolvedValue({ state: 'running', name: 'Pulpit' });
});

describe('AddVideoAngleModal', () => {
    it('reads a typed path, then adds its picture over the version read', async () => {
        const wrapper = mountForm();
        await read(wrapper);
        expect(probe).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            '/media/pulpit.mov'
        );
        expect(wrapper.text()).toContain('pulpit.mov · 600 s');
        // One picture in it: nothing to choose.
        expect(wrapper.find('[data-test="angleSourceTrack"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-test="mainAngleName"]').exists()).toBe(
            false
        );

        const addBtn = () => wrapper.find('[data-test="addVideoAngle"]');
        expect(addBtn().attributes('disabled')).toBeDefined();
        await wrapper.find('[data-test="newAngleName"]').setValue(' Pulpit ');
        await wrapper.find('[data-test="newAngleOffset"]').setValue('-1.5');
        expect(addBtn().attributes('disabled')).toBeUndefined();
        await addBtn().trigger('click');
        await flushPromises();
        expect(add).toHaveBeenCalledWith('sess-1', 'sess_token', {
            path: '/media/pulpit.mov',
            sourceTrackIndex: 0,
            name: 'Pulpit',
            offsetSec: -1.5,
            ifMatch: 'v1',
        });
        expect(wrapper.emitted('started')?.[0]).toEqual([
            { state: 'running', name: 'Pulpit' },
        ]);
        expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
    });

    it("names the video's own picture when it has no angles yet", async () => {
        const wrapper = mountForm(true);
        await read(wrapper);
        const main = wrapper.find('[data-test="mainAngleName"]');
        expect((main.element as HTMLInputElement).value).toBe('Main');
        await main.setValue('Stage');
        await wrapper.find('[data-test="newAngleName"]').setValue('Pulpit');
        await wrapper.find('[data-test="addVideoAngle"]').trigger('click');
        await flushPromises();
        expect(add).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            expect.objectContaining({ name: 'Pulpit', mainName: 'Stage' })
        );
    });

    it('offers the pictures of a file with several, by their source index', async () => {
        probe.mockResolvedValue({
            durationSec: 60,
            videoTracks: [
                { index: 0, width: 1920, height: 1080 },
                { index: 2, width: 1280, height: 720, name: 'Wide' },
            ],
        });
        const wrapper = mountForm();
        await read(wrapper);
        const select = wrapper.findComponent({ name: 'FormSelect' });
        expect(select.props('options')).toEqual([
            { value: 0, label: 'Video 1 · 1920×1080' },
            { value: 2, label: 'Video 2 · 1280×720 · Wide' },
        ]);
    });

    it('says what is wrong with a source, and stays open', async () => {
        probe.mockRejectedValue(new Error('This file has no picture'));
        const wrapper = mountForm();
        await read(wrapper);
        expect(wrapper.text()).toContain('This file has no picture');
        expect(wrapper.emitted('update:open')).toBeUndefined();
    });
});
