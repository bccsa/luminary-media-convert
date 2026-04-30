import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AdminSessionsController } from './admin-sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { SessionEventsService } from './session-events.service.js';
import { Subject } from 'rxjs';

describe('AdminSessionsController', () => {
    let controller: AdminSessionsController;
    let sessionsService: {
        listAllSessions: ReturnType<typeof vi.fn>;
        getSessionAdmin: ReturnType<typeof vi.fn>;
    };
    let sessionEvents: SessionEventsService;

    beforeEach(() => {
        sessionsService = {
            listAllSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
            getSessionAdmin: vi.fn().mockResolvedValue({ sessionId: 's1', status: 'completed' }),
        };
        sessionEvents = new SessionEventsService();
        controller = new AdminSessionsController(
            sessionsService as unknown as SessionsService,
            sessionEvents,
        );
    });

    describe('listAll', () => {
        it('should list all sessions with default params', async () => {
            await controller.listAll();

            expect(sessionsService.listAllSessions).toHaveBeenCalledWith({
                limit: undefined,
                skip: undefined,
                status: undefined,
                userId: undefined,
            });
        });

        it('should pass query params through', async () => {
            await controller.listAll(10, 20, 'completed', 'user:1');

            expect(sessionsService.listAllSessions).toHaveBeenCalledWith({
                limit: 10,
                skip: 20,
                status: 'completed',
                userId: 'user:1',
            });
        });
    });

    describe('streamSessionEvents', () => {
        it('should return observable of message events for admin', () => {
            const req = { user: { role: 'admin' } };
            const observable = controller.streamSessionEvents(req);
            expect(observable).toBeDefined();
        });

        it('should throw UnauthorizedException for non-admin', () => {
            const req = { user: { role: 'user' } };
            expect(() => controller.streamSessionEvents(req)).toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException when no user role', () => {
            const req = { user: {} };
            expect(() => controller.streamSessionEvents(req)).toThrow(
                UnauthorizedException,
            );
        });

        it('should map session events to MessageEvent format', async () => {
            const req = { user: { role: 'admin' } };
            const observable = controller.streamSessionEvents(req);

            const events: unknown[] = [];
            const subscription = observable.subscribe((event) => events.push(event));

            sessionEvents.emit({
                sessionId: 's1',
                userId: 'u1',
                status: 'encoding',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            expect(events).toEqual([
                {
                    data: {
                        sessionId: 's1',
                        userId: 'u1',
                        status: 'encoding',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            ]);

            subscription.unsubscribe();
        });
    });

    describe('detail', () => {
        it('should return session details', async () => {
            const result = await controller.detail('sess-1');

            expect(sessionsService.getSessionAdmin).toHaveBeenCalledWith('sess-1');
            expect(result).toEqual({ sessionId: 's1', status: 'completed' });
        });
    });

    describe('userSessions', () => {
        it('should list sessions for a specific user', async () => {
            await controller.userSessions('user:1', 10, 5, 'encoding');

            expect(sessionsService.listAllSessions).toHaveBeenCalledWith({
                limit: 10,
                skip: 5,
                status: 'encoding',
                userId: 'user:1',
            });
        });
    });
});
