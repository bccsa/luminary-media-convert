import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

const mockGetAccessTokenSilently = vi.fn().mockResolvedValue('test-token');

vi.mock('@auth0/auth0-vue', () => ({
    useAuth0: () => ({
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

vi.mock('vue-router', () => ({
    useRoute: () => ({
        params: { id: 'sess-123' },
    }),
}));

const mockGetSession = vi.fn();
vi.mock('../api', () => ({
    getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock('../utils/status', () => ({
    statusLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
    statusColor: () => 'bg-zinc-800 text-zinc-400',
}));

const mockRouterLink = { template: '<a><slot /></a>', props: ['to'] };

import SessionDetailView from './SessionDetailView.vue';

describe('SessionDetailView', () => {
    beforeEach(() => {
        mockGetAccessTokenSilently.mockReset().mockResolvedValue('test-token');
        mockGetSession.mockReset();
    });

    function mountView() {
        return mount(SessionDetailView, {
            global: {
                stubs: {
                    'router-link': mockRouterLink,
                },
            },
        });
    }

    it('shows loading state initially', async () => {
        mockGetAccessTokenSilently.mockReturnValue(new Promise(() => {}));
        const wrapper = mountView();
        await nextTick();
        expect(wrapper.find('svg.animate-spin').exists()).toBe(true);
    });

    it('displays session details after loading', async () => {
        mockGetSession.mockResolvedValue({
            sessionId: 'sess-123456789012',
            userId: 'user:1',
            status: 'completed',
            encoder: 'nvidia',
            segmentFormat: 'fmp4',
            s3Config: { endPoint: 'minio.example.com', bucket: 'output' },
            masterPlaylist: 'master.m3u8',
            files: ['master.m3u8', 'v0/stream.m3u8', 'a0/stream.m3u8'],
            createdAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T01:00:00.000Z',
            expiresAt: '2026-02-01T00:00:00.000Z',
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('sess-123456789012');
        expect(wrapper.text()).toContain('nvidia');
        expect(wrapper.text()).toContain('fmp4');
        expect(wrapper.text()).toContain('minio.example.com/output');
        expect(wrapper.text()).toContain('master.m3u8');
        expect(wrapper.text()).toContain('Output Files (3)');
        expect(wrapper.text()).toContain('v0/stream.m3u8');
    });

    it('shows error message on failure', async () => {
        mockGetSession.mockRejectedValue(new Error('Not found'));

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('Not found');
    });

    it('shows error section for failed sessions', async () => {
        mockGetSession.mockResolvedValue({
            sessionId: 'sess-fail',
            userId: 'user:1',
            status: 'failed',
            error: 'FFmpeg process crashed',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:05:00.000Z',
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('FFmpeg process crashed');
    });

    it('handles non-Error exceptions', async () => {
        mockGetSession.mockRejectedValue('unexpected');

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('unexpected');
    });

    it('displays session without optional fields', async () => {
        mockGetSession.mockResolvedValue({
            sessionId: 'sess-minimal',
            userId: 'user:1',
            status: 'queued',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('sess-minimal');
        expect(wrapper.text()).not.toContain('Encoder');
        expect(wrapper.text()).not.toContain('Output Files');
    });

    it('formats dates with formatDate returning dash for undefined', async () => {
        mockGetSession.mockResolvedValue({
            sessionId: 'sess-nodates',
            userId: 'user:1',
            status: 'encoding',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        const wrapper = mountView();
        await flushPromises();

        // completedAt is undefined, so formatDate returns '-'
        const cells = wrapper.findAll('dd');
        const completedCell = cells.find((c) => c.text() === '-');
        expect(completedCell).toBeDefined();
    });
});
