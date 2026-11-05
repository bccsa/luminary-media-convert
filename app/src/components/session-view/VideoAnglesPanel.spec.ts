import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const { media, save } = vi.hoisted(() => ({ media: vi.fn(), save: vi.fn() }));

vi.mock('../../api', () => ({
    getEncodedMedia: media,
    putVideoAngles: save,
    probeVideoSource: vi.fn(),
    addVideoAngle: vi.fn(),
}));

import VideoAnglesPanel from './VideoAnglesPanel.vue';

const ANGLES = {
    tracks: [],
    angles: [
        { id: 'main', name: 'Main', default: true, renditions: 3 },
        { id: 'pulpit', name: 'Pulpit', default: false, renditions: 3 },
    ],
    chapterLanguages: [],
    etag: 'v1',
    encrypted: false,
};
const SINGLE = {
    ...ANGLES,
    angles: [{ id: '', name: '', default: true, renditions: 3 }],
};

const names = (w: ReturnType<typeof mount>) =>
    w.findAll('[data-test="videoAnglesPanel"] input[type="text"]');

const mountPanel = () =>
    mount(VideoAnglesPanel, {
        props: { sessionId: 'sess-1', sessionToken: 'sess_token' },
        global: { stubs: { teleport: true } },
    });

beforeEach(() => {
    vi.clearAllMocks();
    media.mockResolvedValue(ANGLES);
    save.mockResolvedValue({ ...ANGLES, etag: 'v2' });
});
afterEach(() => vi.useRealTimers());

describe('VideoAnglesPanel', () => {
    it("lists the video's angles, the first-playing one marked", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(
            names(wrapper).map((n) => (n.element as HTMLInputElement).value)
        ).toEqual(['Main', 'Pulpit']);
        const rows = wrapper.findAll('[data-test="videoAngleRow"]');
        expect(rows[0].text()).toContain('Plays first');
        expect(rows[1].text()).not.toContain('Plays first');
        expect(
            wrapper.find('[data-test="saveVideoAngles"]').attributes('disabled')
        ).toBeDefined();
    });

    it('saves a rename and a removal together, against the version it read', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await names(wrapper)[1].setValue('Pulpit camera');
        await wrapper
            .findAll('[data-test="removeVideoAngle"]')[0]
            .trigger('click');
        await wrapper.find('[data-test="saveVideoAngles"]').trigger('click');
        await flushPromises();
        expect(save).toHaveBeenCalledWith(
            'sess-1',
            'sess_token',
            'v1',
            [{ id: 'pulpit', name: 'Pulpit camera' }],
            ['main']
        );
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('keeps one angle: the last one cannot be removed', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper
            .findAll('[data-test="removeVideoAngle"]')[0]
            .trigger('click');
        const left = wrapper.findAll('[data-test="removeVideoAngle"]');
        expect(left).toHaveLength(1);
        expect(left[0].attributes('disabled')).toBeDefined();
    });

    it('shows a single picture as one row with nothing to rename, and asks to name it when adding', async () => {
        media.mockResolvedValue(SINGLE);
        const wrapper = mountPanel();
        await flushPromises();
        expect(names(wrapper)).toHaveLength(0);
        expect(wrapper.text()).toContain("This video's picture");
        expect(wrapper.find('[data-test="saveVideoAngles"]').exists()).toBe(
            false
        );
        await wrapper.find('[data-test="showAddVideoAngle"]').trigger('click');
        expect(
            wrapper
                .findComponent({ name: 'AddVideoAngleModal' })
                .props('namesMain')
        ).toBe(true);
    });

    it('shows the angle being added, then the video as it is once it is in', async () => {
        vi.useFakeTimers();
        media.mockResolvedValueOnce({
            ...ANGLES,
            addingAngle: {
                state: 'running',
                phase: 'encoding',
                progress: 42,
                name: 'Choir',
            },
        });
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-test="addingVideoAngle"]').text()).toContain(
            'Encoding 42%'
        );
        expect(
            wrapper
                .find('[data-test="showAddVideoAngle"]')
                .attributes('disabled')
        ).toBeDefined();

        media.mockResolvedValue({
            ...ANGLES,
            angles: [
                ...ANGLES.angles,
                { id: 'Choir', name: 'Choir', default: false, renditions: 3 },
            ],
            etag: 'v3',
            addingAngle: {
                state: 'done',
                phase: 'done',
                progress: 100,
                name: 'Choir',
            },
        });
        await vi.advanceTimersByTimeAsync(1000);
        await flushPromises();
        expect(wrapper.find('[data-test="addingVideoAngle"]').exists()).toBe(
            false
        );
        expect(names(wrapper)).toHaveLength(3);
        expect(wrapper.text()).toContain('“Choir” was added');
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('reloads the player once when the add is done, however slow the reads are', async () => {
        vi.useFakeTimers();
        const running = {
            ...ANGLES,
            addingAngle: { state: 'running', phase: 'saving', progress: 99, name: 'Choir' },
        };
        const done = {
            ...ANGLES,
            etag: 'v3',
            addingAngle: { state: 'done', phase: 'done', progress: 100, name: 'Choir' },
        };
        media.mockResolvedValueOnce(running);
        const wrapper = mountPanel();
        await flushPromises();

        // Each read takes 2.5 s, longer than the interval between them.
        media.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve(done), 2500))
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await flushPromises();

        expect(media).toHaveBeenCalledTimes(2);
        expect(wrapper.emitted('saved')).toHaveLength(1);
    });

    it('waits while an audio track is being added', async () => {
        media.mockResolvedValue({
            ...ANGLES,
            adding: {
                state: 'running',
                phase: 'encoding',
                progress: 1,
                language: 'fra',
                name: 'Français',
            },
        });
        const wrapper = mountPanel();
        await flushPromises();
        expect(
            wrapper
                .find('[data-test="showAddVideoAngle"]')
                .attributes('disabled')
        ).toBeDefined();
    });

    it('says why an angle was not added', async () => {
        media.mockResolvedValue({
            ...ANGLES,
            addingAngle: {
                state: 'failed',
                phase: 'encoding',
                progress: 3,
                name: 'Choir',
                error: 'The angle could not be encoded: boom',
            },
        });
        const wrapper = mountPanel();
        await flushPromises();
        expect(
            wrapper.find('[data-test="addVideoAngleFailed"]').text()
        ).toContain(
            'The angle “Choir” was not added: The angle could not be encoded'
        );
    });
});
