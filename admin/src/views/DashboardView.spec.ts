import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

const mockGetAccessTokenSilently = vi.fn().mockResolvedValue('test-token');

vi.mock('@auth0/auth0-vue', () => ({
    useAuth0: () => ({
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

const mockGetDashboard = vi.fn();
vi.mock('../api', () => ({
    getDashboard: (...args: unknown[]) => mockGetDashboard(...args),
}));

vi.mock('../utils/status', () => ({
    statusLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
    statusColor: () => 'bg-zinc-800 text-zinc-400',
}));

const mockRouterLink = { template: '<a><slot /></a>', props: ['to'] };

import DashboardView from './DashboardView.vue';

describe('DashboardView', () => {
    beforeEach(() => {
        mockGetAccessTokenSilently.mockReset().mockResolvedValue('test-token');
        mockGetDashboard.mockReset();
    });

    function mountView() {
        return mount(DashboardView, {
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

    it('displays dashboard stats after loading', async () => {
        mockGetDashboard.mockResolvedValue({
            userCounts: { total: 10, active: 8, disabled: 2 },
            sessionCounts: { total: 50, active: 3, completed: 45, failed: 2 },
            recentActivity: [
                {
                    sessionId: 'sess-abc123456789',
                    userId: 'u1',
                    status: 'completed',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    completedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('10');
        expect(wrapper.text()).toContain('8');
        expect(wrapper.text()).toContain('50');
        expect(wrapper.text()).toContain('3');
        expect(wrapper.text()).toContain('sess-abc1234');
    });

    it('shows error message on failure', async () => {
        mockGetDashboard.mockRejectedValue(new Error('Server error'));

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('Server error');
    });

    it('shows no recent activity message when empty', async () => {
        mockGetDashboard.mockResolvedValue({
            userCounts: { total: 0, active: 0, disabled: 0 },
            sessionCounts: { total: 0, active: 0, completed: 0, failed: 0 },
            recentActivity: [],
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('No recent activity');
    });

    it('handles non-Error exceptions', async () => {
        mockGetDashboard.mockRejectedValue('string error');

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('string error');
    });

    it('formats undefined completedAt as dash in recent activity', async () => {
        mockGetDashboard.mockResolvedValue({
            userCounts: { total: 1, active: 1, disabled: 0 },
            sessionCounts: { total: 1, active: 0, completed: 1, failed: 0 },
            recentActivity: [
                {
                    sessionId: 'sess-nodates12345',
                    userId: 'u1',
                    status: 'failed',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    // completedAt is undefined
                },
            ],
        });

        const wrapper = mountView();
        await flushPromises();

        // The Completed column should show '-'
        expect(wrapper.text()).toContain('-');
    });
});
