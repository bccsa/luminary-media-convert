import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

const mockPush = vi.fn();
const mockGetAccessTokenSilently = vi.fn().mockResolvedValue('test-token');

vi.mock('@auth0/auth0-vue', () => ({
    useAuth0: () => ({
        getAccessTokenSilently: mockGetAccessTokenSilently,
    }),
}));

vi.mock('vue-router', () => ({
    useRouter: () => ({
        push: mockPush,
    }),
}));

const mockListAllSessions = vi.fn();
const mockSubscribeSessionEvents = vi.fn();

vi.mock('../api', () => ({
    listAllSessions: (...args: unknown[]) => mockListAllSessions(...args),
    subscribeSessionEvents: (...args: unknown[]) => mockSubscribeSessionEvents(...args),
}));

vi.mock('../utils/status', () => ({
    statusLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
    statusColor: () => 'bg-zinc-800 text-zinc-400',
}));

import SessionsListView from './SessionsListView.vue';

describe('SessionsListView', () => {
    let mockEventSource: { onmessage: any; close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        mockGetAccessTokenSilently.mockReset().mockResolvedValue('test-token');
        mockListAllSessions.mockReset();
        mockSubscribeSessionEvents.mockReset();
        mockPush.mockClear();

        mockEventSource = { onmessage: null, close: vi.fn() };
        mockSubscribeSessionEvents.mockReturnValue(mockEventSource);
    });

    function mountView() {
        return mount(SessionsListView, {
            global: {
                stubs: {
                    'router-link': { template: '<a><slot /></a>', props: ['to'] },
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

    it('displays sessions table after loading', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-abcdef123456',
                    userId: 'user:testuser1234',
                    status: 'completed',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T01:00:00.000Z',
                    completedAt: '2026-01-01T01:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('sess-abcdef1');
        expect(wrapper.text()).toContain('Completed');
    });

    it('shows empty state when no sessions', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [],
            total: 0,
        });

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('No sessions found');
    });

    it('shows error message on failure', async () => {
        mockListAllSessions.mockRejectedValue(new Error('Connection refused'));

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('Connection refused');
    });

    it('handles non-Error exceptions', async () => {
        mockListAllSessions.mockRejectedValue('string error');

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('string error');
    });

    it('navigates to session detail on row click', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-clickable',
                    userId: 'user:testuser1234',
                    status: 'completed',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        await wrapper.find('tbody tr').trigger('click');
        expect(mockPush).toHaveBeenCalledWith('/sessions/sess-clickable');
    });

    it('updates sessions via SSE events', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-1',
                    userId: 'user:testuser1234',
                    status: 'encoding',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        // Extract the callback passed to subscribeSessionEvents
        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        // Simulate SSE event updating existing session
        onEvent({
            sessionId: 'sess-1',
            userId: 'user:testuser1234',
            status: 'completed',
            updatedAt: '2026-01-01T01:00:00.000Z',
            completedAt: '2026-01-01T01:00:00.000Z',
        });

        await flushPromises();
        expect(wrapper.text()).toContain('Completed');
    });

    it('prepends new sessions via SSE on first page', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [],
            total: 0,
        });

        const wrapper = mountView();
        await flushPromises();

        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        onEvent({
            sessionId: 'sess-new',
            userId: 'user:testuser1234',
            status: 'queued',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        await flushPromises();
        expect(wrapper.text()).toContain('sess-new');
    });

    it('closes EventSource on unmount', async () => {
        mockListAllSessions.mockResolvedValue({ sessions: [], total: 0 });

        const wrapper = mountView();
        await flushPromises();

        wrapper.unmount();
        expect(mockEventSource.close).toHaveBeenCalled();
    });

    it('handles SSE connection failure gracefully', async () => {
        mockListAllSessions.mockResolvedValue({ sessions: [], total: 0 });
        mockGetAccessTokenSilently
            .mockResolvedValueOnce('test-token')   // for fetchSessions
            .mockRejectedValueOnce(new Error('token expired'));  // for connectSSE

        const wrapper = mountView();
        await flushPromises();

        // Should not crash — SSE failure is silently caught
        expect(wrapper.text()).toContain('No sessions found');
    });

    it('removes session from list when status no longer matches filter', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-1',
                    userId: 'user:testuser1234',
                    status: 'encoding',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        // Capture the SSE callback before filter change
        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        // Set status filter to 'encoding'
        const select = wrapper.find('select');
        await select.setValue('encoding');
        await flushPromises();

        // Now simulate SSE changing the status to completed (no longer matches filter)
        onEvent({
            sessionId: 'sess-1',
            userId: 'user:testuser1234',
            status: 'completed',
            updatedAt: '2026-01-01T01:00:00.000Z',
            completedAt: '2026-01-01T01:00:00.000Z',
        });

        await flushPromises();
        // Session should be removed since it no longer matches the filter
        expect(wrapper.text()).not.toContain('sess-1');
    });

    it('supports pagination with prevPage and nextPage', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: Array.from({ length: 25 }, (_, i) => ({
                sessionId: `sess-${String(i).padStart(15, '0')}`,
                userId: 'user:testuser1234',
                status: 'completed',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            })),
            total: 50,
        });

        const wrapper = mountView();
        await flushPromises();

        // Pagination should be visible (total > limit)
        expect(wrapper.text()).toContain('Next');

        // Click next page
        const nextBtn = wrapper.findAll('button').find(b => b.text() === 'Next');
        await nextBtn!.trigger('click');
        await flushPromises();

        // Verify second call had skip=25
        const lastCall = mockListAllSessions.mock.calls.at(-1);
        expect(lastCall![1]).toEqual(expect.objectContaining({ skip: 25 }));

        // Click previous page
        const prevBtn = wrapper.findAll('button').find(b => b.text() === 'Previous');
        await prevBtn!.trigger('click');
        await flushPromises();

        const lastCall2 = mockListAllSessions.mock.calls.at(-1);
        expect(lastCall2![1]).toEqual(expect.objectContaining({ skip: 0 }));
    });

    it('trims session list when SSE pushes beyond page limit', async () => {
        const sessions = Array.from({ length: 25 }, (_, i) => ({
            sessionId: `sess-${String(i).padStart(15, '0')}`,
            userId: 'user:testuser1234',
            status: 'completed',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }));
        mockListAllSessions.mockResolvedValue({ sessions, total: 25 });

        const wrapper = mountView();
        await flushPromises();

        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        // Add a new session via SSE — should trigger trim
        onEvent({
            sessionId: 'sess-brandnew12345',
            userId: 'user:testuser1234',
            status: 'queued',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });

        await flushPromises();

        // New session should be at the top (sliced to 12 chars)
        expect(wrapper.text()).toContain('sess-brandne');

        // List should still have at most 25 items (the old last one should be popped)
        const rows = wrapper.findAll('tbody tr');
        expect(rows.length).toBeLessThanOrEqual(25);
    });

    it('handles response without sessions or total fields', async () => {
        mockListAllSessions.mockResolvedValue({});

        const wrapper = mountView();
        await flushPromises();

        expect(wrapper.text()).toContain('No sessions found');
    });

    it('does not prepend SSE events when not on first page', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: Array.from({ length: 25 }, (_, i) => ({
                sessionId: `sess-${String(i).padStart(15, '0')}`,
                userId: 'user:testuser1234',
                status: 'completed',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            })),
            total: 50,
        });

        const wrapper = mountView();
        await flushPromises();

        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        // Navigate to page 2
        const nextBtn = wrapper.findAll('button').find(b => b.text() === 'Next');
        await nextBtn!.trigger('click');
        await flushPromises();

        // SSE event for unknown session while on page 2 should be ignored
        onEvent({
            sessionId: 'sess-newonpage2zzz',
            userId: 'user:testuser1234',
            status: 'queued',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });

        await flushPromises();
        expect(wrapper.text()).not.toContain('sess-newonpage');
    });

    it('SSE filter: session not in list with filter active is ignored', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-existingsess',
                    userId: 'user:testuser1234',
                    status: 'encoding',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        const onEvent = mockSubscribeSessionEvents.mock.calls[0][1];

        // Set filter
        const select = wrapper.find('select');
        await select.setValue('encoding');
        await flushPromises();

        // SSE event for a session NOT in the list with a non-matching status
        onEvent({
            sessionId: 'sess-notinlistzzz',
            userId: 'user:testuser1234',
            status: 'completed',
            updatedAt: '2026-01-01T01:00:00.000Z',
        });

        await flushPromises();
        // Should not crash and session not added
        expect(wrapper.text()).not.toContain('sess-notinli');
    });

    it('formats undefined dates as dash', async () => {
        mockListAllSessions.mockResolvedValue({
            sessions: [
                {
                    sessionId: 'sess-nodates12345',
                    userId: 'user:testuser1234',
                    status: 'encoding',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
            total: 1,
        });

        const wrapper = mountView();
        await flushPromises();

        // The completed date column should show '-' since completedAt is undefined
        expect(wrapper.text()).toContain('-');
    });
});
