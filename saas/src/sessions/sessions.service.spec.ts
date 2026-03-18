import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

describe('SessionsService', () => {
    let service: SessionsService;

    beforeEach(() => {
        process.env.ENCODING_API_URL = 'http://localhost:3000';
        process.env.ENCODING_API_MASTER_KEY = 'test-master-key';

        service = new SessionsService();
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
    });

    describe('createSession', () => {
        it('should call Encoding API and return SaaS response', async () => {
            const dto = { s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any;

            const result = await service.createSession('user:1', dto);

            expect(result).toEqual({
                sessionId: 'sess-123',
                encodingApiUrl: 'http://localhost:3000',
                sessionToken: 'sess_abc',
                maxUploadSize: 10737418240,
            });

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:3000/api/sessions',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': 'test-master-key',
                    },
                }),
            );
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
            // First create a session to populate the map
            await service.createSession('user:1', { s3: {} } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await service.deleteSession('user:1', 'sess-123');

            expect(fetch).toHaveBeenLastCalledWith(
                'http://localhost:3000/api/sessions/sess-123',
                expect.objectContaining({
                    method: 'DELETE',
                    headers: { 'X-API-Key': 'test-master-key' },
                }),
            );
        });

        it('should throw NotFoundException for unknown session', async () => {
            await expect(
                service.deleteSession('user:1', 'nonexistent'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException for wrong user', async () => {
            await service.createSession('user:1', { s3: {} } as any);

            await expect(
                service.deleteSession('user:other', 'sess-123'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should not throw when Encoding API returns 404', async () => {
            await service.createSession('user:1', { s3: {} } as any);

            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).resolves.toBeUndefined();
        });

        it('should throw BadGatewayException when Encoding API returns error', async () => {
            await service.createSession('user:1', { s3: {} } as any);

            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Server error' }), { status: 500 }),
            );

            await expect(
                service.deleteSession('user:1', 'sess-123'),
            ).rejects.toThrow(BadGatewayException);
        });
    });
});
