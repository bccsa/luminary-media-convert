import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsController', () => {
    let controller: SessionsController;
    let sessionsService: {
        createSession: ReturnType<typeof vi.fn>;
        deleteSession: ReturnType<typeof vi.fn>;
        listSessions: ReturnType<typeof vi.fn>;
        getSession: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        sessionsService = {
            createSession: vi.fn(),
            deleteSession: vi.fn(),
            listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
            getSession: vi.fn().mockResolvedValue({ sessionId: 's1', status: 'completed' }),
        };
        controller = new SessionsController(
            sessionsService as unknown as SessionsService,
        );
    });

    describe('create', () => {
        it('should create session and return response', async () => {
            const response = {
                sessionId: 'sess-123',
                encodingApiUrl: 'http://localhost:3000',
                sessionToken: 'sess_abc',
                maxUploadSize: 10737418240,
            };
            sessionsService.createSession.mockResolvedValue(response);

            const dto = { s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any;
            const req = { user: { _id: 'user:1' } };

            const result = await controller.create(dto, req);

            expect(result).toEqual(response);
            expect(sessionsService.createSession).toHaveBeenCalledWith('user:1', dto);
        });
    });

    describe('list', () => {
        it('should list user sessions', async () => {
            const req = { user: { _id: 'user:1' } };
            const result = await controller.list(req, 10, 5, 'completed');

            expect(sessionsService.listSessions).toHaveBeenCalledWith('user:1', {
                limit: 10,
                skip: 5,
                status: 'completed',
            });
            expect(result).toEqual({ sessions: [], total: 0 });
        });
    });

    describe('detail', () => {
        it('should return session detail', async () => {
            const req = { user: { _id: 'user:1' } };
            const result = await controller.detail('sess-1', req);

            expect(sessionsService.getSession).toHaveBeenCalledWith('user:1', 'sess-1');
            expect(result.sessionId).toBe('s1');
        });
    });

    describe('remove', () => {
        it('should delete session', async () => {
            sessionsService.deleteSession.mockResolvedValue(undefined);

            const req = { user: { _id: 'user:1' } };
            await controller.remove('sess-123', req);

            expect(sessionsService.deleteSession).toHaveBeenCalledWith('user:1', 'sess-123');
        });
    });
});
