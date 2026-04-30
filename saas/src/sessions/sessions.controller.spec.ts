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
        moveSessionFiles: ReturnType<typeof vi.fn>;
        renameSessionPrefix: ReturnType<typeof vi.fn>;
        checkPrefix: ReturnType<typeof vi.fn>;
        startUrlUpload: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        sessionsService = {
            createSession: vi.fn(),
            deleteSession: vi.fn(),
            listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
            getSession: vi.fn().mockResolvedValue({ sessionId: 's1', status: 'completed' }),
            importSession: vi.fn(),
            updateSessionName: vi.fn(),
            moveSessionFiles: vi.fn(),
            renameSessionPrefix: vi.fn(),
            checkPrefix: vi.fn(),
            startUrlUpload: vi.fn(),
        };
        controller = new SessionsController(
            sessionsService as unknown as SessionsService,
        );
    });

    describe('startUrlUpload', () => {
        it('forwards the URL upload to the service with the JWT user id', async () => {
            sessionsService.startUrlUpload.mockResolvedValue({
                sessionId: 'sess-1',
                status: 'uploading',
            });

            const dto = { url: 'https://example.com/clip.mp4', filename: 'meeting.mp4' };
            const req = { user: { _id: 'user:1' } };

            const result = await controller.startUrlUpload('sess-1', dto as any, req);

            expect(sessionsService.startUrlUpload).toHaveBeenCalledWith(
                'user:1',
                'sess-1',
                dto,
            );
            expect(result).toEqual({ sessionId: 'sess-1', status: 'uploading' });
        });
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

    describe('moveFiles', () => {
        it('should call sessionsService.moveSessionFiles with correct args', async () => {
            const updatedDoc = { sessionId: 'sess-1', status: 'completed', files: ['new/master.m3u8'] };
            sessionsService.moveSessionFiles.mockResolvedValue(updatedDoc);

            const req = { user: { _id: 'user:1' } };
            const dto = { targetS3ConfigId: 'cfg-2', newPathPrefix: 'new/' };
            const result = await controller.moveFiles('sess-1', dto as any, req);

            expect(result).toEqual(updatedDoc);
            expect(sessionsService.moveSessionFiles).toHaveBeenCalledWith('user:1', 'sess-1', dto);
        });
    });

    describe('renamePrefix', () => {
        it('should call sessionsService.renameSessionPrefix with correct args', async () => {
            const updatedDoc = { sessionId: 'sess-1', status: 'completed' };
            sessionsService.renameSessionPrefix.mockResolvedValue(updatedDoc);

            const req = { user: { _id: 'user:1' } };
            const dto = { newPathPrefix: 'renamed/' };
            const result = await controller.renamePrefix('sess-1', dto as any, req);

            expect(result).toEqual(updatedDoc);
            expect(sessionsService.renameSessionPrefix).toHaveBeenCalledWith('user:1', 'sess-1', dto);
        });
    });

    describe('checkPrefix', () => {
        it('should call sessionsService.checkPrefix with correct args', async () => {
            sessionsService.checkPrefix.mockResolvedValue({ exists: true, count: 5 });

            const req = { user: { _id: 'user:1' } };
            const result = await controller.checkPrefix('cfg-1', 'output/', req);

            expect(result).toEqual({ exists: true, count: 5 });
            expect(sessionsService.checkPrefix).toHaveBeenCalledWith('user:1', 'cfg-1', 'output/');
        });

        it('should return exists=false when no objects at prefix', async () => {
            sessionsService.checkPrefix.mockResolvedValue({ exists: false, count: 0 });

            const req = { user: { _id: 'user:1' } };
            const result = await controller.checkPrefix('cfg-1', 'empty/', req);

            expect(result).toEqual({ exists: false, count: 0 });
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
