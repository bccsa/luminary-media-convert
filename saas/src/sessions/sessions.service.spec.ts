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
    copyObjectSameBucket: vi.fn().mockResolvedValue(undefined),
    transferObject: vi.fn().mockResolvedValue(undefined),
};

const mockHlsEditClient = {
    read: vi.fn(),
    mutate: vi.fn(),
    discover: vi.fn(),
    readChapters: vi.fn(),
    writeChapters: vi.fn(),
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
            mockHlsEditClient as any,
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
                publicUrl: undefined,
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

    describe('startUrlUpload', () => {
        async function createOwnedSession(userId = 'user:1') {
            await service.createSession(userId, {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);
        }

        it('proxies the URL upload to the Encoding API with master key auth', async () => {
            await createOwnedSession();
            vi.mocked(fetch).mockResolvedValueOnce(
                new Response(JSON.stringify({ sessionId: 'sess-123', status: 'uploading' }), {
                    status: 202,
                }),
            );

            const result = await service.startUrlUpload('user:1', 'sess-123', {
                url: 'https://example.com/clip.mp4',
                filename: 'meeting.mp4',
            } as any);

            expect(result).toEqual({ sessionId: 'sess-123', status: 'uploading' });
            expect(fetch).toHaveBeenLastCalledWith(
                'http://localhost:3000/api/sessions/sess-123/url-upload',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'X-API-Key': 'test-master-key',
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify({
                        url: 'https://example.com/clip.mp4',
                        filename: 'meeting.mp4',
                    }),
                }),
            );
        });

        it('throws NotFoundException for unknown session', async () => {
            await expect(
                service.startUrlUpload('user:1', 'nonexistent', {
                    url: 'https://example.com/x.mp4',
                } as any),
            ).rejects.toThrow(NotFoundException);
        });

        it('throws ForbiddenException for sessions owned by a different user', async () => {
            await createOwnedSession('user:1');
            await expect(
                service.startUrlUpload('user:other', 'sess-123', {
                    url: 'https://example.com/x.mp4',
                } as any),
            ).rejects.toThrow(ForbiddenException);
        });

        it('surfaces non-2xx Encoding API responses as BadGatewayException', async () => {
            await createOwnedSession();
            vi.mocked(fetch).mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'invalid url' }), { status: 400 }),
            );

            await expect(
                service.startUrlUpload('user:1', 'sess-123', {
                    url: 'http://169.254.169.254/',
                } as any),
            ).rejects.toThrow(BadGatewayException);
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
                mockHlsEditClient as any,
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

        it('should escape regex special characters in name filter', async () => {
            mockDatabaseService.find.mockResolvedValue({ docs: [] });

            await service.listSessions('user:1', { name: 'test(.*)+' });

            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: expect.objectContaining({
                        name: { $regex: '(?i)test\\(\\.\\*\\)\\+' },
                    }),
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

        /**
         * `publicUrl` is how a browser reaches the output, not a record of where
         * it was written. Served from the creation-time snapshot, correcting a
         * storage config left every existing session unplayable with no remedy
         * short of encoding again.
         */
        describe('publicUrl', () => {
            const storedSession = () => ({
                _id: 'session:sess-1',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
                s3ConfigId: 'cfg-1',
                s3Config: {
                    endPoint: 'https://acct.r2.cloudflarestorage.com',
                    bucket: 'medias',
                    pathPrefix: 'test/',
                    publicUrl: undefined as string | undefined,
                },
            });

            it('takes the current value from the storage config', async () => {
                mockDatabaseService.get.mockReset().mockResolvedValue(storedSession());
                mockS3ConfigsService.getById.mockResolvedValue({
                    publicUrl: 'https://pub-new.r2.dev',
                });

                const result = await service.getSession('user:1', 'sess-1');

                expect(result.s3Config?.publicUrl).toBe('https://pub-new.r2.dev');
            });

            it('leaves the location fields as they were written', async () => {
                // Refreshing these would point the session at objects that were
                // never there — only the delivery URL may follow the config.
                mockDatabaseService.get.mockReset().mockResolvedValue(storedSession());
                mockS3ConfigsService.getById.mockResolvedValue({
                    endPoint: 'https://moved.r2.cloudflarestorage.com',
                    bucket: 'somewhere-else',
                    pathPrefix: 'moved/',
                    publicUrl: 'https://pub-new.r2.dev',
                });

                const result = await service.getSession('user:1', 'sess-1');

                expect(result.s3Config?.endPoint).toBe(
                    'https://acct.r2.cloudflarestorage.com',
                );
                expect(result.s3Config?.bucket).toBe('medias');
                expect(result.s3Config?.pathPrefix).toBe('test/');
            });

            it('keeps the snapshot when the config is gone', async () => {
                const doc = storedSession();
                doc.s3Config.publicUrl = 'https://pub-old.r2.dev';
                mockDatabaseService.get.mockReset().mockResolvedValue(doc);
                mockS3ConfigsService.getById.mockRejectedValue(
                    new NotFoundException('S3 config not found'),
                );

                const result = await service.getSession('user:1', 'sess-1');

                expect(result.s3Config?.publicUrl).toBe('https://pub-old.r2.dev');
            });

            it('does not look up a config the session was not created with', async () => {
                const doc = storedSession();
                delete (doc as { s3ConfigId?: string }).s3ConfigId;
                mockDatabaseService.get.mockReset().mockResolvedValue(doc);

                await service.getSession('user:1', 'sess-1');

                expect(mockS3ConfigsService.getById).not.toHaveBeenCalled();
            });
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
                mockHlsEditClient as any,
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
                mockHlsEditClient as any,
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
            mockS3ConfigsService.decryptCredentials.mockReturnValue({
                accessKey: 'plain-key',
                secretKey: 'plain-secret',
            });
            mockHlsEditClient.discover.mockResolvedValue({
                masterPlaylistKey: 'output/master.m3u8',
                folderPrefix: 'output/',
            });
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
            ]);
        });

        it('forwards decrypted credentials and input to the API /api/hls/discover', async () => {
            await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'http://localhost:9000/media/output/master.m3u8',
            });

            expect(mockHlsEditClient.discover).toHaveBeenCalledTimes(1);
            const [s3, input] = mockHlsEditClient.discover.mock.calls[0];
            expect(s3).toMatchObject({
                bucket: 'media',
                accessKey: 'plain-key',
                secretKey: 'plain-secret',
            });
            expect(input).toEqual({
                masterPlaylistKey: 'http://localhost:9000/media/output/master.m3u8',
            });
        });

        it('forwards folderPrefix when that is what the caller provided', async () => {
            await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                folderPrefix: 'output/',
            });

            const [, input] = mockHlsEditClient.discover.mock.calls[0];
            expect(input).toEqual({ folderPrefix: 'output/' });
        });

        it('stores the discovered master + angles on the session document', async () => {
            mockHlsEditClient.discover.mockResolvedValue({
                masterPlaylistKey: 'output/main.m3u8',
                folderPrefix: 'output/',
                anglePlaylists: [
                    { name: 'main', key: 'output/main.m3u8' },
                    { name: 'pulpit', key: 'output/pulpit.m3u8' },
                ],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                folderPrefix: 'output/',
            });

            expect(result.masterPlaylist).toBe('output/main.m3u8');
            expect(result.anglePlaylists).toEqual([
                { name: 'main', key: 'output/main.m3u8' },
                { name: 'pulpit', key: 'output/pulpit.m3u8' },
            ]);
        });

        it('stores the full file list (via SaaS S3ClientService) on the document', async () => {
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
                'output/v0/seg0.m4s',
            ]);

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith(
                'user:1', 'cfg-1', 'output/',
            );
            expect(result.files).toEqual([
                'output/master.m3u8',
                'output/v0/playlist.m3u8',
                'output/v0/seg0.m4s',
            ]);
        });

        it('sets status=completed and imported=true', async () => {
            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });
            expect(result.status).toBe('completed');
            expect(result.imported).toBe(true);
            expect(result.progress).toBe(100);
        });

        it('throws BadRequestException when neither masterPlaylistKey nor folderPrefix is provided', async () => {
            await expect(
                service.importSession('user:1', { s3ConfigId: 'cfg-1' }),
            ).rejects.toThrow(BadRequestException);
            expect(mockHlsEditClient.discover).not.toHaveBeenCalled();
        });

        it('propagates errors from the discover call', async () => {
            mockHlsEditClient.discover.mockRejectedValue(
                new BadRequestException('No HLS master playlist found under the given prefix'),
            );

            await expect(
                service.importSession('user:1', {
                    s3ConfigId: 'cfg-1',
                    folderPrefix: 'output/',
                }),
            ).rejects.toThrow('No HLS master playlist');
        });

        it('persists encryptionKeyHex when an encryption key is supplied', async () => {
            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
                encryptionKey: 'AABBCCDD11223344AABBCCDD11223344',
            });

            expect(result.encrypted).toBe(true);
            expect(result.encryptionKeyHex).toBe('aabbccdd11223344aabbccdd11223344');
        });

        it('omits encryptionKeyHex when no key is supplied', async () => {
            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(result.encrypted).toBeUndefined();
            expect(result.encryptionKeyHex).toBeUndefined();
        });

        it('passes userId and s3ConfigId to s3ConfigsService.getById (ownership check)', async () => {
            await service.importSession('user:42', {
                s3ConfigId: 'cfg-99',
                masterPlaylistKey: 'output/master.m3u8',
            });
            expect(mockS3ConfigsService.getById).toHaveBeenCalledWith('user:42', 'cfg-99');
        });

        it('surfaces chaptersLanguages from discover without persisting them', async () => {
            mockHlsEditClient.discover.mockResolvedValue({
                masterPlaylistKey: 'output/master.m3u8',
                folderPrefix: 'output/',
                chaptersLanguages: ['en', 'fr'],
            });

            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                folderPrefix: 'output/',
            });

            expect(result.chaptersLanguages).toEqual(['en', 'fr']);
            // The persisted document (the value handed to insert) must not include this field.
            const persisted = mockDatabaseService.insert.mock.calls.at(-1)?.[0] as Record<string, unknown>;
            expect(persisted).toBeDefined();
            expect(persisted!.chaptersLanguages).toBeUndefined();
        });

        it('does not include chaptersLanguages when discover finds none', async () => {
            const result = await service.importSession('user:1', {
                s3ConfigId: 'cfg-1',
                masterPlaylistKey: 'output/master.m3u8',
            });
            expect(result.chaptersLanguages).toBeUndefined();
        });
    });


    describe('moveSessionFiles', () => {
        const completedDoc = {
            _id: 'session:sess-move',
            _rev: '1-abc',
            docType: 'session' as const,
            userId: 'user:1',
            sessionId: 'sess-move',
            status: 'completed',
            files: ['prefix/master.m3u8', 'prefix/v0/seg0.m4s'],
            masterPlaylist: 'prefix/master.m3u8',
            anglePlaylists: [{ name: 'Angle 1', key: 'prefix/angle1.m3u8' }],
            thumbnailsVtt: 'prefix/thumbs.vtt',
            s3Config: { endPoint: 'minio', bucket: 'src-bucket', pathPrefix: 'prefix/' },
            s3ConfigId: 'cfg-src',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
        };

        const targetConfig = {
            _id: 's3config:cfg-dest',
            endPoint: 's3.amazonaws.com',
            bucket: 'dest-bucket',
            port: undefined,
            useSSL: true,
            publicUrl: undefined,
        };

        it('should transfer all files and update session document', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...completedDoc });
            mockS3ConfigsService.getById.mockResolvedValue(targetConfig);

            const result = await service.moveSessionFiles('user:1', 'sess-move', {
                targetS3ConfigId: 'cfg-dest',
                newPathPrefix: 'new/',
            });

            // Should transfer each file
            expect(mockS3ClientService.transferObject).toHaveBeenCalledTimes(2);
            expect(mockS3ClientService.transferObject).toHaveBeenCalledWith(
                'user:1', 'cfg-src', 'prefix/master.m3u8', 'cfg-dest', 'new/master.m3u8',
            );

            // Should delete originals
            expect(mockS3ClientService.deleteObjects).toHaveBeenCalledWith(
                'user:1', 'cfg-src', completedDoc.files,
            );

            // Should update session doc
            expect(result.s3ConfigId).toBe('cfg-dest');
            expect(result.s3Config?.bucket).toBe('dest-bucket');
            expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            expect(result.masterPlaylist).toBe('new/master.m3u8');
            expect(mockDatabaseService.upsert).toHaveBeenCalled();
        });

        it('should reject non-completed sessions', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...completedDoc, status: 'encoding' });

            await expect(
                service.moveSessionFiles('user:1', 'sess-move', { targetS3ConfigId: 'cfg-dest', newPathPrefix: 'dest/' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject if user does not own session', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...completedDoc });

            await expect(
                service.moveSessionFiles('user:other', 'sess-move', { targetS3ConfigId: 'cfg-dest', newPathPrefix: 'dest/' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should throw BadRequestException when session has no files', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...completedDoc, files: [] });

            await expect(
                service.moveSessionFiles('user:1', 'sess-move', { targetS3ConfigId: 'cfg-dest', newPathPrefix: 'dest/' }),
            ).rejects.toThrow('Session has no files or S3 config');
        });

        it('should throw BadRequestException when session has no s3ConfigId', async () => {
            const doc = { ...completedDoc };
            delete (doc as any).s3ConfigId;
            mockDatabaseService.get.mockResolvedValue(doc);

            await expect(
                service.moveSessionFiles('user:1', 'sess-move', { targetS3ConfigId: 'cfg-dest', newPathPrefix: 'dest/' }),
            ).rejects.toThrow('Session has no files or S3 config');
        });

        it('should not produce double slash when stored pathPrefix has no trailing slash', async () => {
            // s3.service strips trailing slashes before upload, so the stored
            // pathPrefix may be "prefix" while the keys are "prefix/..."
            mockDatabaseService.get.mockResolvedValue({
                ...completedDoc,
                s3Config: { endPoint: 'minio', bucket: 'src-bucket', pathPrefix: 'prefix' },
            });
            mockS3ConfigsService.getById.mockResolvedValue(targetConfig);

            const result = await service.moveSessionFiles('user:1', 'sess-move', {
                targetS3ConfigId: 'cfg-dest',
                newPathPrefix: 'new/',
            });

            expect(mockS3ClientService.transferObject).toHaveBeenCalledWith(
                'user:1', 'cfg-src', 'prefix/master.m3u8', 'cfg-dest', 'new/master.m3u8',
            );
            expect(mockS3ClientService.transferObject).toHaveBeenCalledWith(
                'user:1', 'cfg-src', 'prefix/v0/seg0.m4s', 'cfg-dest', 'new/v0/seg0.m4s',
            );
            expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            expect(result.masterPlaylist).toBe('new/master.m3u8');
        });
    });

    describe('hlsRead / hlsMutate', () => {
        const baseDoc = {
            _id: 'session:sess-hls',
            _rev: '1-abc',
            docType: 'session' as const,
            userId: 'user:1',
            sessionId: 'sess-hls',
            status: 'completed',
            files: ['out/master.m3u8'],
            masterPlaylist: 'out/master.m3u8',
            s3Config: { endPoint: 'minio', bucket: 'media', pathPrefix: 'out/' },
            s3ConfigId: 'cfg-1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
        };

        beforeEach(() => {
            mockS3ConfigsService.getById.mockResolvedValue({
                endPoint: 'minio', port: 9000, useSSL: false, bucket: 'media',
                accessKey: 'enc', secretKey: 'enc',
            });
            mockS3ConfigsService.decryptCredentials.mockReturnValue({
                accessKey: 'plain-key', secretKey: 'plain-secret',
            });
        });

        it('hlsRead forwards the resolved S3 config to the client and returns its result', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            mockHlsEditClient.read.mockResolvedValue({
                master: { variants: [], media: [], audioGroups: [] },
                etag: 'etag-1',
                folderPrefix: 'out/',
                masterPlaylistKey: 'out/master.m3u8',
            });

            const result = await service.hlsRead('user:1', 'sess-hls');

            expect(mockHlsEditClient.read).toHaveBeenCalledWith(
                expect.objectContaining({ bucket: 'media', accessKey: 'plain-key', secretKey: 'plain-secret' }),
                'out/master.m3u8',
            );
            expect(result.etag).toBe('etag-1');
        });

        it('hlsRead rejects when the session is not owned by the user', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            await expect(service.hlsRead('user:other', 'sess-hls'))
                .rejects.toThrow(ForbiddenException);
        });

        it('hlsRead rejects when the session has no master playlist', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc, masterPlaylist: undefined });
            await expect(service.hlsRead('user:1', 'sess-hls'))
                .rejects.toThrow(BadRequestException);
        });

        it('hlsMutate calls the client, increments editVersion, reconciles subtitles, and upserts the doc', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc, editVersion: 2 });
            mockHlsEditClient.mutate.mockResolvedValue({
                master: {
                    variants: [],
                    media: [
                        { type: 'SUBTITLES', groupId: 'subs', name: 'English', language: 'en', uri: 'subtitles/en.vtt', default: true },
                    ],
                    audioGroups: [],
                },
                etag: 'etag-2',
                writtenKeys: ['out/subtitles/en.vtt', 'out/master.m3u8'],
            });

            const result = await service.hlsMutate(
                'user:1', 'sess-hls', 'etag-1',
                [{ type: 'upsertSubtitle', language: 'en', name: 'English', vttBase64: 'V0VCVlRU' }],
            );

            expect(mockHlsEditClient.mutate).toHaveBeenCalledWith(
                expect.objectContaining({ bucket: 'media' }),
                'out/master.m3u8',
                'etag-1',
                expect.any(Array),
            );
            expect(result.editVersion).toBe(3);
            expect(result.subtitles).toEqual([
                expect.objectContaining({
                    language: 'en',
                    name: 'English',
                    key: 'out/subtitles/en.vtt',
                    default: true,
                }),
            ]);
            expect(mockDatabaseService.upsert).toHaveBeenCalled();
        });

        it('hlsMutate removes subtitles from the doc when the master has none', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...baseDoc,
                subtitles: [{ language: 'en', name: 'English', key: 'out/subtitles/en.vtt', updatedAt: '…' }],
            });
            mockHlsEditClient.mutate.mockResolvedValue({
                master: { variants: [], media: [], audioGroups: [] },
                etag: 'etag-2',
                writtenKeys: ['out/master.m3u8'],
            });

            const result = await service.hlsMutate('user:1', 'sess-hls', 'etag-1', []);
            expect(result.subtitles).toBeUndefined();
        });

        it('hlsMutate propagates ConflictException from the client', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            mockHlsEditClient.mutate.mockRejectedValue(
                new (await import('@nestjs/common')).ConflictException({ code: 'ETAG_MISMATCH' }),
            );

            await expect(
                service.hlsMutate('user:1', 'sess-hls', 'stale', []),
            ).rejects.toBeInstanceOf((await import('@nestjs/common')).ConflictException);
        });

        it('readChapters forwards the resolved S3 config and the master folder prefix', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            mockHlsEditClient.readChapters.mockResolvedValue({ vtt: 'WEBVTT\n' });

            const result = await service.readChapters('user:1', 'sess-hls', 'en');

            expect(mockHlsEditClient.readChapters).toHaveBeenCalledWith(
                expect.objectContaining({ bucket: 'media', accessKey: 'plain-key' }),
                'out/',
                'en',
            );
            expect(result?.vtt).toMatch(/^WEBVTT/);
        });

        it('readChapters returns null when the client reports no file', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            mockHlsEditClient.readChapters.mockResolvedValue(null);
            await expect(service.readChapters('user:1', 'sess-hls', 'en')).resolves.toBeNull();
        });

        it('readChapters falls back to s3Config.pathPrefix when the session has no master playlist', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...baseDoc,
                masterPlaylist: undefined,
                s3Config: { ...baseDoc.s3Config, pathPrefix: 'imported/abc' },
            });
            mockHlsEditClient.readChapters.mockResolvedValue(null);
            await service.readChapters('user:1', 'sess-hls', 'en');
            expect(mockHlsEditClient.readChapters).toHaveBeenCalledWith(
                expect.anything(),
                'imported/abc/',
                'en',
            );
        });

        it('readChapters rejects when the session has neither a master playlist nor a path prefix', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...baseDoc,
                masterPlaylist: undefined,
                s3Config: { endPoint: 'minio', bucket: 'media' },
            });
            await expect(service.readChapters('user:1', 'sess-hls', 'en'))
                .rejects.toBeInstanceOf(BadRequestException);
        });

        it('readChapters rejects when the session is not owned by the user', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            await expect(service.readChapters('user:other', 'sess-hls', 'en'))
                .rejects.toThrow(ForbiddenException);
        });

        it('writeChapters forwards lang + body to the client', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            mockHlsEditClient.writeChapters.mockResolvedValue(undefined);

            await service.writeChapters('user:1', 'sess-hls', 'en', 'WEBVTT\n');

            expect(mockHlsEditClient.writeChapters).toHaveBeenCalledWith(
                expect.objectContaining({ bucket: 'media' }),
                'out/',
                'en',
                'WEBVTT\n',
            );
        });

        it('writeChapters rejects ownership-mismatch sessions', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...baseDoc });
            await expect(service.writeChapters('user:other', 'sess-hls', 'en', 'WEBVTT'))
                .rejects.toThrow(ForbiddenException);
        });
    });

    describe('renameSessionPrefix', () => {
        function makeRenameDoc() {
            return {
                _id: 'session:sess-rename',
                _rev: '1-abc',
                docType: 'session' as const,
                userId: 'user:1',
                sessionId: 'sess-rename',
                status: 'completed',
                files: ['old/master.m3u8', 'old/v0/seg0.m4s'],
                masterPlaylist: 'old/master.m3u8',
                thumbnailsVtt: 'old/thumbs.vtt',
                s3Config: { endPoint: 'minio', bucket: 'bucket', pathPrefix: 'old/' },
                s3ConfigId: 'cfg-1',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
            };
        }

        it('should copy files with new prefix and delete originals', async () => {
            mockDatabaseService.get.mockResolvedValue(makeRenameDoc());

            const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                newPathPrefix: 'new/',
            });

            // Should copy each file within the same bucket
            expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledTimes(2);
            expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledWith(
                'user:1', 'cfg-1', 'old/master.m3u8', 'new/master.m3u8',
            );
            expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledWith(
                'user:1', 'cfg-1', 'old/v0/seg0.m4s', 'new/v0/seg0.m4s',
            );

            // Should delete originals
            expect(mockS3ClientService.deleteObjects).toHaveBeenCalledWith(
                'user:1', 'cfg-1', ['old/master.m3u8', 'old/v0/seg0.m4s'],
            );

            // Should update keys
            expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            expect(result.masterPlaylist).toBe('new/master.m3u8');
            expect(result.thumbnailsVtt).toBe('new/thumbs.vtt');
            expect(result.s3Config?.pathPrefix).toBe('new/');
        });

        it('should no-op when prefix is unchanged', async () => {
            mockDatabaseService.get.mockResolvedValue(makeRenameDoc());

            const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                newPathPrefix: 'old/',
            });

            expect(mockS3ClientService.copyObjectSameBucket).not.toHaveBeenCalled();
            expect(mockS3ClientService.deleteObjects).not.toHaveBeenCalled();
            expect(result.files).toEqual(['old/master.m3u8', 'old/v0/seg0.m4s']);
        });

        /**
         * A leading slash is not part of the key as S3 addresses it, so "/old/"
         * and "old/" name the same objects. Compared as plain strings the no-op
         * guard missed, the copy went ahead, and the backend rejected it as
         * copying an object onto itself — reaching the user as a bare 500.
         */
        describe('prefixes that name the same objects', () => {
            function makeSlashedDoc() {
                return {
                    ...makeRenameDoc(),
                    files: ['/old/master.m3u8', '/old/v0/seg0.m4s'],
                    masterPlaylist: '/old/master.m3u8',
                    thumbnailsVtt: '/old/thumbs.vtt',
                    s3Config: {
                        endPoint: 'minio',
                        bucket: 'bucket',
                        pathPrefix: '/old/',
                    },
                };
            }

            it('touches no storage when only the leading slash differs', async () => {
                mockDatabaseService.get.mockResolvedValue(makeSlashedDoc());

                await service.renameSessionPrefix('user:1', 'sess-rename', {
                    newPathPrefix: 'old/',
                });

                expect(mockS3ClientService.copyObjectSameBucket).not.toHaveBeenCalled();
                expect(mockS3ClientService.deleteObjects).not.toHaveBeenCalled();
            });

            it('rewrites the recorded keys to the canonical form', async () => {
                // What the user was asking for: the same objects, addressed
                // without the empty leading segment that produced `//` in URLs.
                mockDatabaseService.get.mockResolvedValue(makeSlashedDoc());

                const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                    newPathPrefix: 'old/',
                });

                expect(result.files).toEqual(['old/master.m3u8', 'old/v0/seg0.m4s']);
                expect(result.masterPlaylist).toBe('old/master.m3u8');
                expect(result.thumbnailsVtt).toBe('old/thumbs.vtt');
                expect(result.s3Config?.pathPrefix).toBe('old/');
            });

            it('still moves objects for a genuine rename off a slashed prefix', async () => {
                mockDatabaseService.get.mockResolvedValue(makeSlashedDoc());

                await service.renameSessionPrefix('user:1', 'sess-rename', {
                    newPathPrefix: 'new/',
                });

                expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledWith(
                    'user:1', 'cfg-1', '/old/master.m3u8', 'new/master.m3u8',
                );
                expect(mockS3ClientService.deleteObjects).toHaveBeenCalledWith(
                    'user:1', 'cfg-1', ['/old/master.m3u8', '/old/v0/seg0.m4s'],
                );
            });

            it('normalizes a slashed target rather than copying onto itself', async () => {
                mockDatabaseService.get.mockResolvedValue(makeRenameDoc());

                const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                    newPathPrefix: '/old',
                });

                expect(mockS3ClientService.copyObjectSameBucket).not.toHaveBeenCalled();
                expect(result.s3Config?.pathPrefix).toBe('old/');
            });

            it('accepts a target given without a trailing slash', async () => {
                mockDatabaseService.get.mockResolvedValue(makeRenameDoc());

                const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                    newPathPrefix: 'new',
                });

                expect(result.s3Config?.pathPrefix).toBe('new/');
                expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            });
        });

        it('should reject if user does not own session', async () => {
            mockDatabaseService.get.mockResolvedValue(makeRenameDoc());

            await expect(
                service.renameSessionPrefix('user:other', 'sess-rename', { newPathPrefix: 'new/' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should reject non-completed sessions', async () => {
            mockDatabaseService.get.mockResolvedValue({ ...makeRenameDoc(), status: 'queued' });

            await expect(
                service.renameSessionPrefix('user:1', 'sess-rename', { newPathPrefix: 'new/' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when session has no files', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...makeRenameDoc(),
                files: [],
            });

            await expect(
                service.renameSessionPrefix('user:1', 'sess-rename', { newPathPrefix: 'new/' }),
            ).rejects.toThrow('Session has no files or S3 config');
        });

        it('should throw BadRequestException when session has no s3ConfigId', async () => {
            const doc = makeRenameDoc();
            delete (doc as any).s3ConfigId;
            mockDatabaseService.get.mockResolvedValue(doc);

            await expect(
                service.renameSessionPrefix('user:1', 'sess-rename', { newPathPrefix: 'new/' }),
            ).rejects.toThrow('Session has no files or S3 config');
        });

        it('should not produce double slash when stored pathPrefix has no trailing slash', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...makeRenameDoc(),
                s3Config: { endPoint: 'minio', bucket: 'bucket', pathPrefix: 'old' },
            });

            const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                newPathPrefix: 'new/',
            });

            expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledWith(
                'user:1', 'cfg-1', 'old/master.m3u8', 'new/master.m3u8',
            );
            expect(mockS3ClientService.copyObjectSameBucket).toHaveBeenCalledWith(
                'user:1', 'cfg-1', 'old/v0/seg0.m4s', 'new/v0/seg0.m4s',
            );
            expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            expect(result.masterPlaylist).toBe('new/master.m3u8');
        });

        it('should prepend new prefix when old prefix is empty', async () => {
            mockDatabaseService.get.mockResolvedValue({
                ...makeRenameDoc(),
                files: ['master.m3u8', 'v0/seg0.m4s'],
                masterPlaylist: 'master.m3u8',
                thumbnailsVtt: 'thumbs.vtt',
                s3Config: { endPoint: 'minio', bucket: 'bucket', pathPrefix: undefined },
            });

            const result = await service.renameSessionPrefix('user:1', 'sess-rename', {
                newPathPrefix: 'new/',
            });

            // When oldPrefix is empty, rewriteKey prepends the new prefix
            expect(result.files).toEqual(['new/master.m3u8', 'new/v0/seg0.m4s']);
            expect(result.masterPlaylist).toBe('new/master.m3u8');
            expect(result.thumbnailsVtt).toBe('new/thumbs.vtt');
        });
    });

    describe('checkPrefix', () => {
        it('should return exists=true with count when objects are found', async () => {
            mockS3ConfigsService.getById.mockResolvedValue({
                _id: 's3config:cfg-1',
                userId: 'user:1',
            });
            mockS3ClientService.listObjects.mockResolvedValue([
                'output/master.m3u8',
                'output/v0/seg0.m4s',
                'output/v0/seg1.m4s',
            ]);

            const result = await service.checkPrefix('user:1', 'cfg-1', 'output/');

            expect(result).toEqual({ exists: true, count: 3 });
            expect(mockS3ConfigsService.getById).toHaveBeenCalledWith('user:1', 'cfg-1');
            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith('user:1', 'cfg-1', 'output/');
        });

        it('should return exists=false with count 0 when no objects found', async () => {
            mockS3ConfigsService.getById.mockResolvedValue({
                _id: 's3config:cfg-1',
                userId: 'user:1',
            });
            mockS3ClientService.listObjects.mockResolvedValue([]);

            const result = await service.checkPrefix('user:1', 'cfg-1', 'empty/');

            expect(result).toEqual({ exists: false, count: 0 });
        });

        it('should normalize prefix by appending trailing slash', async () => {
            mockS3ConfigsService.getById.mockResolvedValue({
                _id: 's3config:cfg-1',
                userId: 'user:1',
            });
            mockS3ClientService.listObjects.mockResolvedValue([]);

            await service.checkPrefix('user:1', 'cfg-1', 'no-slash');

            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith('user:1', 'cfg-1', 'no-slash/');
        });

        it('should not double-append slash when prefix already ends with slash', async () => {
            mockS3ConfigsService.getById.mockResolvedValue({
                _id: 's3config:cfg-1',
                userId: 'user:1',
            });
            mockS3ClientService.listObjects.mockResolvedValue([]);

            await service.checkPrefix('user:1', 'cfg-1', 'has-slash/');

            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith('user:1', 'cfg-1', 'has-slash/');
        });

        it('should pass empty prefix through without modification', async () => {
            mockS3ConfigsService.getById.mockResolvedValue({
                _id: 's3config:cfg-1',
                userId: 'user:1',
            });
            mockS3ClientService.listObjects.mockResolvedValue([]);

            await service.checkPrefix('user:1', 'cfg-1', '');

            expect(mockS3ClientService.listObjects).toHaveBeenCalledWith('user:1', 'cfg-1', '');
        });
    });
});
