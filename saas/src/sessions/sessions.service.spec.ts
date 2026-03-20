import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

const mockDatabaseService = {
    find: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
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
        it('should delete session on Encoding API', async () => {
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await service.deleteSession('user:1', 'sess-123');

            expect(fetch).toHaveBeenLastCalledWith(
                'http://localhost:3000/api/sessions/sess-123',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('should throw NotFoundException for unknown session', async () => {
            await expect(
                service.deleteSession('user:1', 'nonexistent'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException for wrong user', async () => {
            await service.createSession('user:1', { s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any);
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
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
            });

            const result = await service.getSession('user:1', 'sess-1');
            expect(result.sessionId).toBe('sess-1');
        });

        it('should throw ForbiddenException for non-owner', async () => {
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                userId: 'user:1',
            });

            await expect(
                service.getSession('user:other', 'sess-1'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should throw NotFoundException when not found', async () => {
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

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
        it('should throw BadGatewayException when Encoding API delete fails', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }),
            );

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).rejects.toThrow(BadGatewayException);
        });

        it('should succeed when Encoding API returns 404 on delete', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).resolves.toBeUndefined();
        });

        it('should handle non-JSON error response from Encoding API delete', async () => {
            await service.createSession('user:1', {
                s3: { endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' },
            } as any);

            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', {
                    status: 502,
                    headers: { 'Content-Type': 'text/plain' },
                }),
            );

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).rejects.toThrow(BadGatewayException);
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
});
