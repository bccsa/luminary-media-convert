import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

const mockDatabaseService = {
    find: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
};

describe('SessionsService', () => {
    let service: SessionsService;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ENCODING_API_URL = 'http://localhost:3000';
        process.env.ENCODING_API_MASTER_KEY = 'test-master-key';
        process.env.SAAS_SERVICE_URL = 'http://localhost:3001';
        process.env.WEBHOOK_SECRET = 'test-webhook-secret';

        service = new SessionsService(mockDatabaseService as any);
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
    });
});
