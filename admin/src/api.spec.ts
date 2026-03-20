import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock import.meta.env before importing the module
vi.stubEnv('VITE_SAAS_SERVICE_URL', 'http://localhost:3000');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
    };
}

function noContentResponse() {
    return {
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
    };
}

function errorResponse(status: number, message?: string) {
    return {
        ok: false,
        status,
        json: () =>
            Promise.resolve(message ? { message } : {}),
    };
}

// Dynamic import so env stubs are in place
let api: typeof import('./api');

beforeEach(async () => {
    mockFetch.mockReset();
    // Re-import the module fresh each time isn't necessary since
    // the env is stubbed at the module level, but we need to import once
    if (!api) {
        api = await import('./api');
    }
});

describe('api client', () => {
    const token = 'test-token-123';

    describe('getCurrentUser', () => {
        it('sends GET with auth header to /saas/admin/users/me', async () => {
            const userData = {
                id: 'u1',
                email: 'admin@test.com',
                role: 'admin',
            };
            mockFetch.mockResolvedValue(jsonResponse(userData));

            const result = await api.getCurrentUser(token);

            expect(result).toEqual(userData);
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users/me',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    }),
                }),
            );
        });
    });

    describe('listUsers', () => {
        it('sends GET with query params', async () => {
            const data = { users: [], total: 0 };
            mockFetch.mockResolvedValue(jsonResponse(data));

            await api.listUsers(token, {
                limit: 10,
                skip: 20,
                search: 'john',
            });

            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toContain('/saas/admin/users?');
            expect(url).toContain('limit=10');
            expect(url).toContain('skip=20');
            expect(url).toContain('search=john');
        });

        it('omits undefined params', async () => {
            mockFetch.mockResolvedValue(jsonResponse({ users: [] }));

            await api.listUsers(token);

            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toContain('/saas/admin/users?');
            expect(url).not.toContain('limit=');
            expect(url).not.toContain('skip=');
            expect(url).not.toContain('search=');
        });
    });

    describe('getUser', () => {
        it('sends GET to /saas/admin/users/:id', async () => {
            const userData = { id: 'u1', email: 'user@test.com' };
            mockFetch.mockResolvedValue(jsonResponse(userData));

            const result = await api.getUser(token, 'u1');

            expect(result).toEqual(userData);
            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toBe(
                'http://localhost:3000/saas/admin/users/u1',
            );
        });
    });

    describe('createUser', () => {
        it('sends POST with body', async () => {
            const newUser = {
                id: 'u2',
                email: 'new@test.com',
                name: 'New User',
                role: 'user',
            };
            mockFetch.mockResolvedValue(
                jsonResponse(newUser, 201),
            );

            const result = await api.createUser(token, {
                email: 'new@test.com',
                name: 'New User',
                role: 'user',
            });

            expect(result).toEqual(newUser);
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        email: 'new@test.com',
                        name: 'New User',
                        role: 'user',
                    }),
                }),
            );
        });
    });

    describe('updateUser', () => {
        it('sends PATCH with body', async () => {
            mockFetch.mockResolvedValue(
                jsonResponse({ id: 'u1', name: 'Updated' }),
            );

            await api.updateUser(token, 'u1', {
                name: 'Updated',
            });

            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users/u1',
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify({ name: 'Updated' }),
                }),
            );
        });
    });

    describe('disableUser', () => {
        it('sends POST to /disable', async () => {
            mockFetch.mockResolvedValue(noContentResponse());

            const result = await api.disableUser(token, 'u1');

            expect(result).toBeNull();
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users/u1/disable',
                expect.objectContaining({ method: 'POST' }),
            );
        });
    });

    describe('enableUser', () => {
        it('sends POST to /enable', async () => {
            mockFetch.mockResolvedValue(noContentResponse());

            const result = await api.enableUser(token, 'u1');

            expect(result).toBeNull();
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users/u1/enable',
                expect.objectContaining({ method: 'POST' }),
            );
        });
    });

    describe('deleteUser', () => {
        it('sends DELETE to /saas/admin/users/:id', async () => {
            mockFetch.mockResolvedValue(noContentResponse());

            const result = await api.deleteUser(token, 'u1');

            expect(result).toBeNull();
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3000/saas/admin/users/u1',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });
    });

    describe('listAllSessions', () => {
        it('sends GET with query params to /saas/admin/sessions', async () => {
            const data = { sessions: [], total: 0 };
            mockFetch.mockResolvedValue(jsonResponse(data));

            await api.listAllSessions(token, {
                limit: 10,
                skip: 20,
                status: 'completed',
                userId: 'user:1',
            });

            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toContain('/saas/admin/sessions?');
            expect(url).toContain('limit=10');
            expect(url).toContain('skip=20');
            expect(url).toContain('status=completed');
            expect(url).toContain('userId=user%3A1');
        });

        it('omits undefined params', async () => {
            mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }));

            await api.listAllSessions(token);

            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toContain('/saas/admin/sessions?');
            expect(url).not.toContain('limit=');
        });
    });

    describe('getSession', () => {
        it('sends GET to /saas/admin/sessions/:id', async () => {
            const sessionData = { sessionId: 's1', status: 'completed' };
            mockFetch.mockResolvedValue(jsonResponse(sessionData));

            const result = await api.getSession(token, 's1');

            expect(result).toEqual(sessionData);
            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toBe('http://localhost:3000/saas/admin/sessions/s1');
        });
    });

    describe('subscribeSessionEvents', () => {
        let esInstances: any[];

        function setupMockEventSource() {
            esInstances = [];
            const MockEventSource = vi.fn(function (this: any) {
                this.onmessage = null;
                this.onerror = null;
                this.close = vi.fn();
                esInstances.push(this);
            }) as any;
            vi.stubGlobal('EventSource', MockEventSource);
            return MockEventSource;
        }

        function teardownMockEventSource() {
            vi.unstubAllGlobals();
            vi.stubEnv('VITE_SAAS_SERVICE_URL', 'http://localhost:3000');
            vi.stubGlobal('fetch', mockFetch);
        }

        it('creates EventSource with token query param', () => {
            const MockES = setupMockEventSource();

            const onEvent = vi.fn();
            api.subscribeSessionEvents(token, onEvent);

            expect(MockES).toHaveBeenCalledWith(
                `http://localhost:3000/saas/admin/sessions/events?token=${encodeURIComponent(token)}`,
            );

            // Simulate receiving a message
            const event = {
                sessionId: 's1',
                userId: 'u1',
                status: 'encoding',
                updatedAt: '2026-01-01T00:00:00.000Z',
            };
            const instance = esInstances[0];
            instance.onmessage({ data: JSON.stringify(event) });
            expect(onEvent).toHaveBeenCalledWith(event);

            teardownMockEventSource();
        });

        it('ignores parse errors in SSE messages', () => {
            setupMockEventSource();

            const onEvent = vi.fn();
            api.subscribeSessionEvents(token, onEvent);

            // Simulate receiving invalid JSON
            const instance = esInstances[0];
            instance.onmessage({ data: 'not json' });
            expect(onEvent).not.toHaveBeenCalled();

            teardownMockEventSource();
        });
    });

    describe('getDashboard', () => {
        it('sends GET to /saas/admin/dashboard', async () => {
            const data = {
                userCounts: { total: 5, active: 4, disabled: 1 },
                sessionCounts: { total: 10, active: 2, completed: 7, failed: 1 },
                recentActivity: [],
            };
            mockFetch.mockResolvedValue(jsonResponse(data));

            const result = await api.getDashboard(token);

            expect(result).toEqual(data);
            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toBe('http://localhost:3000/saas/admin/dashboard');
        });
    });

    describe('error handling', () => {
        it('throws with server error message', async () => {
            mockFetch.mockResolvedValue(
                errorResponse(400, 'Validation failed'),
            );

            await expect(
                api.getCurrentUser(token),
            ).rejects.toThrow('Validation failed');
        });

        it('throws with HTTP status when no message', async () => {
            mockFetch.mockResolvedValue(errorResponse(500));

            await expect(
                api.getCurrentUser(token),
            ).rejects.toThrow('HTTP 500');
        });

        it('handles non-JSON error responses', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 502,
                json: () => Promise.reject(new Error('not json')),
            });

            await expect(
                api.getCurrentUser(token),
            ).rejects.toThrow('HTTP 502');
        });
    });
});
