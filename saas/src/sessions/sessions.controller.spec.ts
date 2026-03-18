import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsController', () => {
    let controller: SessionsController;
    let sessionsService: {
        createSession: ReturnType<typeof vi.fn>;
        deleteSession: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        sessionsService = {
            createSession: vi.fn(),
            deleteSession: vi.fn(),
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

    describe('remove', () => {
        it('should delete session', async () => {
            sessionsService.deleteSession.mockResolvedValue(undefined);

            const req = { user: { _id: 'user:1' } };
            await controller.remove('sess-123', req);

            expect(sessionsService.deleteSession).toHaveBeenCalledWith('user:1', 'sess-123');
        });
    });
});
