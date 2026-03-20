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
        importSession: ReturnType<typeof vi.fn>;
        updateSessionName: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        sessionsService = {
            createSession: vi.fn(),
            deleteSession: vi.fn(),
            listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
            getSession: vi.fn().mockResolvedValue({ sessionId: 's1', status: 'completed' }),
            importSession: vi.fn(),
            updateSessionName: vi.fn(),
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
        it('should delete session without S3 files by default', async () => {
            sessionsService.deleteSession.mockResolvedValue(undefined);

            const req = { user: { _id: 'user:1' } };
            await controller.remove('sess-123', undefined, req);

            expect(sessionsService.deleteSession).toHaveBeenCalledWith('user:1', 'sess-123', false);
        });

        it('should delete session with S3 files when deleteFiles=true', async () => {
            sessionsService.deleteSession.mockResolvedValue(undefined);

            const req = { user: { _id: 'user:1' } };
            await controller.remove('sess-123', 'true', req);

            expect(sessionsService.deleteSession).toHaveBeenCalledWith('user:1', 'sess-123', true);
        });
    });

    describe('importSession', () => {
        it('should import session and return document', async () => {
            const importedDoc = {
                _id: 'session:sess-new',
                sessionId: 'sess-new',
                status: 'completed',
                imported: true,
            };
            sessionsService.importSession.mockResolvedValue(importedDoc);

            const dto = {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            };
            const req = { user: { _id: 'user:1' } };

            const result = await controller.importSession(dto as any, req);

            expect(result).toEqual(importedDoc);
            expect(sessionsService.importSession).toHaveBeenCalledWith('user:1', dto);
        });

        it('should pass userId from request to service', async () => {
            sessionsService.importSession.mockResolvedValue({});

            const dto = { s3ConfigId: 'cfg-1', folderPrefix: 'output/' };
            const req = { user: { _id: 'user:42' } };

            await controller.importSession(dto as any, req);

            expect(sessionsService.importSession).toHaveBeenCalledWith('user:42', dto);
        });
    });

    describe('updateName', () => {
        it('should update session name and return updated document', async () => {
            const updatedDoc = {
                _id: 'session:sess-1',
                sessionId: 'sess-1',
                name: 'My Encode',
                status: 'completed',
            };
            sessionsService.updateSessionName.mockResolvedValue(updatedDoc);

            const req = { user: { _id: 'user:1' } };
            const result = await controller.updateName('sess-1', { name: 'My Encode' }, req);

            expect(result).toEqual(updatedDoc);
            expect(sessionsService.updateSessionName).toHaveBeenCalledWith(
                'user:1',
                'sess-1',
                'My Encode',
            );
        });

        it('should pass empty string when name is not provided in body', async () => {
            sessionsService.updateSessionName.mockResolvedValue({});

            const req = { user: { _id: 'user:1' } };
            await controller.updateName('sess-1', {} as any, req);

            // The controller does `body.name ?? ''` so undefined name becomes ''
            expect(sessionsService.updateSessionName).toHaveBeenCalledWith(
                'user:1',
                'sess-1',
                '',
            );
        });

        it('should pass userId from request to service', async () => {
            sessionsService.updateSessionName.mockResolvedValue({});

            const req = { user: { _id: 'user:77' } };
            await controller.updateName('sess-5', { name: 'Test' }, req);

            expect(sessionsService.updateSessionName).toHaveBeenCalledWith(
                'user:77',
                'sess-5',
                'Test',
            );
        });
    });
});
