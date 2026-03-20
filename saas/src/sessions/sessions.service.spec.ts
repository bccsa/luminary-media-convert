import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadGatewayException, BadRequestException } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

const mockDatabaseService = {
    find: vi.fn(),
    get: vi.fn(),
    insert: vi.fn().mockResolvedValue({ ok: true, id: 'test', rev: '1-abc' }),
    destroy: vi.fn().mockResolvedValue({ ok: true }),
    upsert: vi.fn().mockResolvedValue({ ok: true }),
};

const mockS3ConfigsService = {
    getById: vi.fn(),
    decryptCredentials: vi.fn(),
};

const mockHlsParserService = {
    parseMasterPlaylist: vi.fn(),
};

const mockS3ClientService = {
    getObject: vi.fn(),
    listObjects: vi.fn(),
    deleteObjects: vi.fn().mockResolvedValue(0),
};

describe('SessionsService', () => {
    let service: SessionsService;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ENCODING_API_URL = 'http://localhost:3000';
        process.env.ENCODING_API_MASTER_KEY = 'test-master-key';
        process.env.SAAS_SERVICE_URL = 'http://localhost:3001';
        process.env.WEBHOOK_SECRET = 'test-webhook-secret';

        service = new SessionsService(
            mockDatabaseService as any,
            mockS3ConfigsService as any,
            mockHlsParserService as any,
            mockS3ClientService as any,
        );
        service.onModuleInit();

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    sessionId: 'sess-123',
                    tusEndpoint: 'http://localhost:3000/api/tus',
                    sessionToken: 'sess_abc',
                    maxUploadSize: 10737418240,
                }),
                { status: 201 },
            ),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.ENCODING_API_URL;
        delete process.env.ENCODING_API_MASTER_KEY;
        delete process.env.SAAS_SERVICE_URL;
        delete process.env.WEBHOOK_SECRET;
    });

    describe('createSession', () => {
        it('should call Encoding API with webhook config and return SaaS response', async () => {
            const dto = { s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any;

            const result = await service.createSession('user:1', dto);

            expect(result).toEqual({
                sessionId: 'sess-123',
                encodingApiUrl: 'http://localhost:3000',
                sessionToken: 'sess_abc',
                maxUploadSize: 10737418240,
            });

            // Verify webhook config is included in the request
            const fetchCall = vi.mocked(fetch).mock.calls[0];
            const body = JSON.parse(fetchCall[1]!.body as string);
            expect(body.webhook).toEqual({
                url: 'http://localhost:3001/saas/webhooks/encoding',
                sessionToken: 'test-webhook-secret',
            });
        });

        it('should store S3 config (non-secret) in session record', async () => {
            const dto = {
                s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's', pathPrefix: 'out' },
            } as any;

            await service.createSession('user:1', dto);

            const record = service.getSessionRecord('sess-123');
            expect(record?.s3Config).toEqual({
                endPoint: 'minio',
                bucket: 'b',
                pathPrefix: 'out',
                port: undefined,
                useSSL: undefined,
            });
            // Ensure secrets are NOT stored
            expect((record?.s3Config as any)?.accessKey).toBeUndefined();
            expect((record?.s3Config as any)?.secretKey).toBeUndefined();
        });

        it('should throw BadGatewayException when Encoding API fails', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Bad request' }), { status: 400 }),
            );

            await expect(
                service.createSession('user:1', { s3: {} } as any),
            ).rejects.toThrow(BadGatewayException);
        });
    });

    describe('deleteSession', () => {
        it('should delete session on Encoding API and CouchDB', async () => {
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123',
                _rev: '1-abc',
            });

            await service.deleteSession('user:1', 'sess-123');

            expect(fetch).toHaveBeenLastCalledWith(
                'http://localhost:3000/api/sessions/sess-123',
                expect.objectContaining({ method: 'DELETE' }),
            );
            expect(mockDatabaseService.destroy).toHaveBeenCalledWith(
                'session:sess-123',
                '1-abc',
            );
        });

        it('should throw NotFoundException for unknown session', async () => {
            await expect(
                service.deleteSession('user:1', 'nonexistent'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException for wrong user', async () => {
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });
            await expect(
                service.deleteSession('user:other', 'sess-123'),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('getSessionRecord', () => {
        it('should return session record from memory', async () => {
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);
            const record = service.getSessionRecord('sess-123');
            expect(record?.userId).toBe('user:1');
        });

        it('should return undefined for unknown session', () => {
            expect(service.getSessionRecord('unknown')).toBeUndefined();
        });
    });

    describe('onModuleInit', () => {
        it('should warn when env vars are not set', () => {
            delete process.env.ENCODING_API_URL;
            delete process.env.ENCODING_API_MASTER_KEY;
            const warnService = new SessionsService(
                mockDatabaseService as any,
                mockS3ConfigsService as any,
                mockHlsParserService as any,
                mockS3ClientService as any,
            );
            // Should not throw
            warnService.onModuleInit();
        });
    });

    describe('listSessions', () => {
        it('should query CouchDB for user sessions', async () => {
            mockDatabaseService.find.mockResolvedValue({ docs: [] });

            await service.listSessions('user:1', { limit: 10 });

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 'session', userId: 'user:1' },
                }),
            );
        });

        it('should filter by status when provided', async () => {
            mockDatabaseService.find.mockResolvedValue({ docs: [] });

            await service.listSessions('user:1', { status: 'completed' });

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 'session', userId: 'user:1', status: 'completed' },
                    use_index: 'sessions-by-user-status',
                }),
            );
        });

        it('should use default limit and skip', async () => {
            mockDatabaseService.find.mockResolvedValue({ docs: [] });

            await service.listSessions('user:1', {});

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    limit: 25,
                    skip: 0,
                }),
            );
        });
    });

    describe('getSession', () => {
        it('should return session for owner', async () => {
            const doc = {
                _id: 'session:sess-1',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
            };
            mockDatabaseService.get
                .mockReset()
                .mockResolvedValue(doc);

            const result = await service.getSession('user:1', 'sess-1');
            expect(result.sessionId).toBe('sess-1');
        });

        it('should augment with token/URL for active sessions', async () => {
            // First create a session to populate the in-memory map
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);

            // Mock the CouchDB get for the getSession call
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123',
                userId: 'user:1',
                sessionId: 'sess-123',
                status: 'uploaded',
            });

            const result = await service.getSession('user:1', 'sess-123');
            expect(result.sessionToken).toBe('sess_abc');
            expect(result.encodingApiUrl).toBe('http://localhost:3000');
        });

        it('should throw ForbiddenException for non-owner', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                userId: 'user:1',
            });

            await expect(
                service.getSession('user:other', 'sess-1'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should throw NotFoundException when not found', async () => {
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });

            await expect(
                service.getSession('user:1', 'unknown'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should rethrow non-404 errors', async () => {
            mockDatabaseService.get.mockRejectedValue(new Error('connection lost'));

            await expect(
                service.getSession('user:1', 'sess-1'),
            ).rejects.toThrow('connection lost');
        });
    });

    describe('listAllSessions', () => {
        it('should query all sessions without filters', async () => {
            mockDatabaseService.find.mockResolvedValue({ docs: [] });

            const result = await service.listAllSessions({});

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 'session' },
                    use_index: 'sessions-by-created',
                    limit: 25,
                    skip: 0,
                }),
            );
            expect(result).toEqual({ sessions: [], total: 0 });
        });

        it('should filter by status and userId', async () => {
            const docs = [{ sessionId: 's1', status: 'completed' }];
            mockDatabaseService.find.mockResolvedValue({ docs });

            const result = await service.listAllSessions({
                status: 'completed',
                userId: 'user:1',
                limit: 10,
                skip: 5,
            });

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 'session', status: 'completed', userId: 'user:1' },
                    limit: 10,
                    skip: 5,
                }),
            );
            expect(result).toEqual({ sessions: docs, total: 1 });
        });

        it('should strip sensitive fields from session documents', async () => {
            const docs = [{
                sessionId: 's1',
                status: 'completed',
                userId: 'user:1',
                s3Config: { endPoint: 'minio.example.com', bucket: 'private-bucket' },
                s3ConfigId: 'config-1',
                files: ['output/master.m3u8', 'output/v0/init.mp4'],
                masterPlaylist: 'output/master.m3u8',
                anglePlaylists: [{ name: 'angle1', key: 'output/angle1.m3u8' }],
                thumbnailsVtt: 'output/thumbs.vtt',
                probeResult: { streams: [] },
                encryptionKeyHex: 'deadbeef',
            }];
            mockDatabaseService.find.mockResolvedValue({ docs });

            const result = await service.listAllSessions({});

            const session = result.sessions[0];
            expect(session.sessionId).toBe('s1');
            expect(session.status).toBe('completed');
            expect(session).not.toHaveProperty('s3Config');
            expect(session).not.toHaveProperty('s3ConfigId');
            expect(session).not.toHaveProperty('files');
            expect(session).not.toHaveProperty('masterPlaylist');
            expect(session).not.toHaveProperty('anglePlaylists');
            expect(session).not.toHaveProperty('thumbnailsVtt');
            expect(session).not.toHaveProperty('probeResult');
            expect(session).not.toHaveProperty('encryptionKeyHex');
        });
    });

    describe('getSessionAdmin', () => {
        it('should return session without ownership check and strip sensitive fields', async () => {
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                userId: 'user:other',
                sessionId: 'sess-1',
                status: 'completed',
                s3Config: { endPoint: 'minio.example.com', bucket: 'private-bucket' },
                files: ['output/master.m3u8'],
                masterPlaylist: 'output/master.m3u8',
                encryptionKeyHex: 'deadbeef',
                probeResult: { streams: [] },
            });

            const result = await service.getSessionAdmin('sess-1');

            expect(result.sessionId).toBe('sess-1');
            expect(result.status).toBe('completed');
            expect(mockDatabaseService.get).toHaveBeenCalledWith('session:sess-1');
            expect(result).not.toHaveProperty('s3Config');
            expect(result).not.toHaveProperty('files');
            expect(result).not.toHaveProperty('masterPlaylist');
            expect(result).not.toHaveProperty('encryptionKeyHex');
            expect(result).not.toHaveProperty('probeResult');
        });

        it('should throw NotFoundException when not found', async () => {
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await expect(service.getSessionAdmin('unknown')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('deleteSession — error handling', () => {
        it('should succeed even when Encoding API delete fails (best-effort)', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }),
            );
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123', _rev: '1-abc', userId: 'user:1',
            });

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).resolves.toBeUndefined();
        });

        it('should succeed when Encoding API returns 404 on delete', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123', _rev: '1-abc', userId: 'user:1',
            });

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).resolves.toBeUndefined();
        });

        it('should delete historical session from CouchDB only (no in-memory record)', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:hist-1', _rev: '2-def', userId: 'user:1',
                sessionId: 'hist-1', status: 'completed',
            });

            await service.deleteSession('user:1', 'hist-1');

            expect(mockDatabaseService.destroy).toHaveBeenCalledWith('session:hist-1', '2-def');
        });

        it('should delete S3 files when deleteFiles=true and session has files + s3ConfigId', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:s3-1', _rev: '1-abc', userId: 'user:1',
                sessionId: 's3-1', status: 'completed',
                files: ['master.m3u8', 'stream/playlist.m3u8'],
                s3ConfigId: 's3config:cfg-1',
            });

            await service.deleteSession('user:1', 's3-1', true);

            expect(mockS3ClientService.deleteObjects).toHaveBeenCalledWith(
                'user:1', 's3config:cfg-1', ['master.m3u8', 'stream/playlist.m3u8'],
            );
        });

        it('should not delete S3 files when deleteFiles=false', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:s3-2', _rev: '1-abc', userId: 'user:1',
                sessionId: 's3-2', status: 'completed',
                files: ['master.m3u8'],
                s3ConfigId: 's3config:cfg-1',
            });

            await service.deleteSession('user:1', 's3-2', false);

            expect(mockS3ClientService.deleteObjects).not.toHaveBeenCalled();
        });

        it('should continue deletion even if S3 file deletion fails', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:s3-3', _rev: '1-abc', userId: 'user:1',
                sessionId: 's3-3', status: 'completed',
                files: ['master.m3u8'],
                s3ConfigId: 's3config:cfg-1',
            });
            mockS3ClientService.deleteObjects.mockRejectedValueOnce(new Error('S3 error'));

            await expect(
                service.deleteSession('user:1', 's3-3', true),
            ).resolves.toBeUndefined();

            expect(mockDatabaseService.destroy).toHaveBeenCalled();
        });
    });

    describe('createSession — error handling', () => {
        it('should handle non-JSON error response from Encoding API', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', {
                    status: 500,
                    headers: { 'Content-Type': 'text/plain' },
                }),
            );

            await expect(
                service.createSession('user:1', { s3: {} } as any),
            ).rejects.toThrow(BadGatewayException);
        });

        it('should use default SAAS_SERVICE_URL when env not set', async () => {
            delete process.env.SAAS_SERVICE_URL;
            process.env.PORT = '4000';

            const svc = new SessionsService(
                mockDatabaseService as any,
                mockS3ConfigsService as any,
                mockHlsParserService as any,
                mockS3ClientService as any,
            );
            svc.onModuleInit();

            await svc.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            const fetchCall = vi.mocked(fetch).mock.calls[0];
            const body = JSON.parse(fetchCall[1]!.body as string);
            expect(body.webhook.url).toBe('http://localhost:4000/saas/webhooks/encoding');

            delete process.env.PORT;
        });

        it('should use default port and empty webhook secret when env not set', async () => {
            delete process.env.SAAS_SERVICE_URL;
            delete process.env.PORT;
            delete process.env.WEBHOOK_SECRET;

            const svc = new SessionsService(
                mockDatabaseService as any,
                mockS3ConfigsService as any,
                mockHlsParserService as any,
                mockS3ClientService as any,
            );
            svc.onModuleInit();

            await svc.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            const fetchCall = vi.mocked(fetch).mock.calls[0];
            const body = JSON.parse(fetchCall[1]!.body as string);
            expect(body.webhook.url).toBe('http://localhost:3001/saas/webhooks/encoding');
            expect(body.webhook.sessionToken).toBe('');
        });
    });

    describe('createSession — CouchDB document', () => {
        it('should insert CouchDB doc with status created', async () => {
            const dto = {
                s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's', pathPrefix: 'out' },
                s3ConfigId: 'cfg-1',
            } as any;

            await service.createSession('user:1', dto);

            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'session:sess-123',
                    docType: 'session',
                    userId: 'user:1',
                    sessionId: 'sess-123',
                    status: 'created',
                    s3Config: {
                        endPoint: 'minio',
                        bucket: 'b',
                        pathPrefix: 'out',
                        port: undefined,
                        useSSL: undefined,
                    },
                    s3ConfigId: 'cfg-1',
                }),
            );
        });

        it('should include encrypted flag in CouchDB doc when encryption is enabled', async () => {
            const dto = {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
                encryption: { enabled: true },
            } as any;

            await service.createSession('user:1', dto);

            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
                expect.objectContaining({
                    encrypted: true,
                }),
            );
        });

        it('should omit encrypted flag from CouchDB doc when encryption is not enabled', async () => {
            const dto = {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any;

            await service.createSession('user:1', dto);

            const insertCall = mockDatabaseService.insert.mock.calls[0][0];
            expect(insertCall).not.toHaveProperty('encrypted');
        });

        it('should still succeed when CouchDB insert fails', async () => {
            mockDatabaseService.insert.mockRejectedValueOnce(new Error('CouchDB down'));

            const dto = {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any;

            // Should not throw — the .catch() swallows the error
            const result = await service.createSession('user:1', dto);
            expect(result.sessionId).toBe('sess-123');
        });

        it('should strip s3ConfigId from the Encoding API payload', async () => {
            const dto = {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
                s3ConfigId: 'cfg-1',
            } as any;

            await service.createSession('user:1', dto);

            const fetchCall = vi.mocked(fetch).mock.calls[0];
            const body = JSON.parse(fetchCall[1]!.body as string);
            expect(body).not.toHaveProperty('s3ConfigId');
        });
    });

    describe('deleteSession — CouchDB document', () => {
        it('should destroy CouchDB doc after successful Encoding API delete', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123',
                _rev: '2-def',
            });

            await service.deleteSession('user:1', 'sess-123');

            expect(mockDatabaseService.destroy).toHaveBeenCalledWith(
                'session:sess-123',
                '2-def',
            );
        });

        it('should succeed even when CouchDB doc does not exist', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });

            // Should not throw — the catch block swallows the error
            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).resolves.toBeUndefined();
        });

        it('should remove the session from in-memory map', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            expect(service.getSessionRecord('sess-123')).toBeDefined();

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });

            await service.deleteSession('user:1', 'sess-123');

            expect(service.getSessionRecord('sess-123')).toBeUndefined();
        });
    });

    describe('getSession — token augmentation', () => {
        it('should not augment with token/URL for historical sessions (not in memory)', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-old',
                userId: 'user:1',
                sessionId: 'sess-old',
                status: 'completed',
            });

            const result = await service.getSession('user:1', 'sess-old');

            expect(result.sessionToken).toBeUndefined();
            expect(result.encodingApiUrl).toBeUndefined();
            expect(result.sessionId).toBe('sess-old');
        });

        it('should merge CouchDB doc fields with active session data', async () => {
            // Create a session to populate in-memory map
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            // Mock CouchDB returning a doc with additional fields (e.g. progress)
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-123',
                userId: 'user:1',
                sessionId: 'sess-123',
                status: 'encoding',
                progress: 45,
            });

            const result = await service.getSession('user:1', 'sess-123');

            // Should have both CouchDB fields and augmented fields
            expect(result.progress).toBe(45);
            expect(result.status).toBe('encoding');
            expect(result.sessionToken).toBe('sess_abc');
            expect(result.encodingApiUrl).toBe('http://localhost:3000');
        });
    });

    describe('updateSessionName', () => {
        it('should update session name and persist to CouchDB', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                _rev: '1-abc',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            });

            const result = await service.updateSessionName('user:1', 'sess-1', 'My Encode');

            expect(result.name).toBe('My Encode');
            expect(result.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
            expect(mockDatabaseService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'session:sess-1',
                    name: 'My Encode',
                }),
            );
        });

        it('should throw ForbiddenException when user does not own the session', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                userId: 'user:1',
                sessionId: 'sess-1',
            });

            await expect(
                service.updateSessionName('user:other', 'sess-1', 'New Name'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should clear name when empty string is provided', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                _rev: '1-abc',
                userId: 'user:1',
                sessionId: 'sess-1',
                name: 'Old Name',
                status: 'completed',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            });

            const result = await service.updateSessionName('user:1', 'sess-1', '');

            expect(result.name).toBeUndefined();
            expect(mockDatabaseService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: undefined,
                }),
            );
        });

        it('should trim whitespace from name', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                _rev: '1-abc',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            });

            const result = await service.updateSessionName('user:1', 'sess-1', '  Trimmed  ');

            expect(result.name).toBe('Trimmed');
        });

        it('should clear name when only whitespace is provided', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 'session:sess-1',
                _rev: '1-abc',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            });

            const result = await service.updateSessionName('user:1', 'sess-1', '   ');

            expect(result.name).toBeUndefined();
        });

        it('should throw NotFoundException for non-existent session', async () => {
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });

            await expect(
                service.updateSessionName('user:1', 'nonexistent', 'Name'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('importSession', () => {
        const baseS3Config = {
            endPoint: 'minio.example.com',
            bucket: 'media',
            port: 9000,
            useSSL: false,
            region: 'us-east-1',
        };

        beforeEach(() => {
            mockS3ConfigsService.getById.mockResolvedValue(baseS3Config);
        });

        it('should import session with explicit masterPlaylistKey', async () => {
            const masterContent = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8';
            mockS3ClientService.getObject.mockResolvedValue(Buffer.from(masterContent));
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
                'output/v0/init.mp4',
                'output/v0/seg0.m4s',
            ]);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            const dto = {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            };

            const result = await service.importSession('user:1', dto);

            expect(result.status).toBe('completed');
            expect(result.progress).toBe(100);
            expect(result.imported).toBe(true);
            expect(result.masterPlaylist).toBe('output/master.m3u8');
            expect(result.files).toEqual([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
                'output/v0/init.mp4',
                'output/v0/seg0.m4s',
            ]);
            expect(result.s3Config).toEqual({
                endPoint: 'minio.example.com',
                bucket: 'media',
                port: 9000,
                useSSL: false,
            });
            expect(result.s3ConfigId).toBe('cfg-1');
            expect(result.userId).toBe('user:1');
            expect(result.docType).toBe('session');
            expect(result.completedAt).toBeDefined();
            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'completed',
                    imported: true,
                }),
            );
        });

        it('should derive folderPrefix from masterPlaylistKey when not provided', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv0/index.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue([
                'my/path/master.m3u8',
                'my/path/v0/index.m3u8',
            ]);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/index.m3u8', bandwidth: 500000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'my/path/master.m3u8',
            });

            // listObjects should be called with derived prefix 'my/path/'
            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith(
                'user:1',
                'cfg-1',
                'my/path/',
            );
            expect(result.masterPlaylist).toBe('my/path/master.m3u8');
        });

        it('should handle masterPlaylistKey with no directory (root level)', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv0/index.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue([
                'master.m3u8',
                'v0/index.m3u8',
            ]);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/index.m3u8', bandwidth: 500000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'master.m3u8',
            });

            // Derived prefix should be empty string
            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith(
                'user:1',
                'cfg-1',
                '',
            );
            expect(result.masterPlaylist).toBe('master.m3u8');
        });

        it('should auto-discover master.m3u8 when folderPrefix provided but no masterPlaylistKey', async () => {
            // listObjects called first for discovery, then again for file listing
            mockS3ClientService.listObjects
                .mockResolvedValueOnce([
                    'output/master.m3u8',
                    'output/v0/playlist.m3u8',
                    'output/v0/init.mp4',
                ])
                .mockResolvedValueOnce([
                    'output/master.m3u8',
                    'output/v0/playlist.m3u8',
                    'output/v0/init.mp4',
                ]);
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8'),
            );
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                folderPrefix: 'output/',
            });

            expect(result.masterPlaylist).toBe('output/master.m3u8');
            expect(result.status).toBe('completed');
        });

        it('should auto-discover master playlist by scanning m3u8 contents when no master.m3u8 exists', async () => {
            // First call: listObjects for discovery
            mockS3ClientService.listObjects
                .mockResolvedValueOnce([
                    'output/index.m3u8',
                    'output/v0/media.m3u8',
                    'output/v0/init.mp4',
                ])
                .mockResolvedValueOnce([
                    'output/index.m3u8',
                    'output/v0/media.m3u8',
                    'output/v0/init.mp4',
                ]);

            // getObject calls: first for index.m3u8 scan (has STREAM-INF so it's master), then for fetching it as master
            mockS3ClientService.getObject
                .mockResolvedValueOnce(Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv0/media.m3u8'))
                .mockResolvedValueOnce(Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv0/media.m3u8'));

            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/media.m3u8', bandwidth: 500000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                folderPrefix: 'output/',
            });

            expect(result.masterPlaylist).toBe('output/index.m3u8');
        });

        it('should throw BadRequestException when neither masterPlaylistKey nor folderPrefix is provided', async () => {
            await expect(
                service.importSession('user:1', {
                    s3ConfigId: 'cfg-1',
                }),
            ).rejects.toThrow(BadRequestException);

            await expect(
                service.importSession('user:1', {
                    s3ConfigId: 'cfg-1',
                }),
            ).rejects.toThrow('Either masterPlaylistKey or folderPrefix must be provided');
        });

        it('should throw BadRequestException when no master playlist is found under prefix', async () => {
            // No .m3u8 files in listing
            mockS3ClientService.listObjects.mockResolvedValueOnce([
                'output/video.mp4',
                'output/audio.aac',
            ]);

            await expect(
                service.importSession('user:1', {
                    s3ConfigId: 'cfg-1',
                    folderPrefix: 'output/',
                }),
            ).rejects.toThrow('No master playlist found under the given prefix');
        });

        it('should throw BadRequestException when m3u8 files exist but none is a master playlist', async () => {
            mockS3ClientService.listObjects.mockResolvedValueOnce([
                'output/v0/media.m3u8',
                'output/v1/media.m3u8',
            ]);

            // Neither has #EXT-X-STREAM-INF
            mockS3ClientService.getObject
                .mockResolvedValueOnce(Buffer.from('#EXTM3U\n#EXTINF:6.0,\nseg0.ts'))
                .mockResolvedValueOnce(Buffer.from('#EXTM3U\n#EXTINF:6.0,\nseg0.ts'));

            await expect(
                service.importSession('user:1', {
                    s3ConfigId: 'cfg-1',
                    folderPrefix: 'output/',
                }),
            ).rejects.toThrow('No master playlist found under the given prefix');
        });

        it('should create angle playlists when multiple variants exist', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nv1/playlist.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
                'output/v1/playlist.m3u8',
            ]);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [
                    { uri: 'v0/playlist.m3u8', bandwidth: 1000000 },
                    { uri: 'v1/playlist.m3u8', bandwidth: 2000000 },
                ],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(result.anglePlaylists).toEqual([
                { name: 'Angle 1', key: 'output/v0/playlist.m3u8' },
                { name: 'Angle 2', key: 'output/v1/playlist.m3u8' },
            ]);
        });

        it('should not create angle playlists for single variant', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
            ]);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(result.anglePlaylists).toBeUndefined();
        });

        it('should set encrypted flag when encryptionKey is provided', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue(['output/master.m3u8']);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
                encryptionKey: 'aabbccdd11223344aabbccdd11223344',
            });

            expect(result.encrypted).toBe(true);
        });

        it('should omit encrypted flag when encryptionKey is not provided', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue(['output/master.m3u8']);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(result).not.toHaveProperty('encrypted');
        });

        it('should pass userId and s3ConfigId to s3ConfigsService.getById for ownership check', async () => {
            mockS3ClientService.getObject.mockResolvedValue(
                Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8'),
            );
            mockS3ClientService.listObjects.mockResolvedValue(['output/master.m3u8']);
            mockHlsParserService.parseMasterPlaylist.mockReturnValue({
                variants: [{ uri: 'v0/playlist.m3u8', bandwidth: 1000000 }],
            });

            await service.importSession('user:42', {
                s3ConfigId: 'cfg-99',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(mockS3ConfigsService.getById).toHaveBeenCalledWith('user:42', 'cfg-99');
        });
    });
});
