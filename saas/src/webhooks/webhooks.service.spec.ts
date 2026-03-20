import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';

const mockDatabaseService = {
    get: vi.fn(),
    insert: vi.fn().mockResolvedValue({ rev: '2-abc' }),
    upsert: vi.fn().mockResolvedValue({ ok: true, id: 'test', rev: '2-abc' }),
    find: vi.fn(),
};

const mockUsersService = {
    findById: vi.fn(),
};

const mockSessionsService = {
    getSessionRecord: vi.fn(),
};

const mockSessionEventsService = {
    emit: vi.fn(),
};

describe('WebhooksService', () => {
    let service: WebhooksService;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.WEBHOOK_SECRET = 'test-secret';
        service = new WebhooksService(
            mockDatabaseService as any,
            mockUsersService as any,
            mockSessionsService as any,
            mockSessionEventsService as any,
        );
    });

    afterEach(() => {
        delete process.env.WEBHOOK_SECRET;
    });

    describe('validateWebhookToken', () => {
        it('should accept valid token', () => {
            expect(() => service.validateWebhookToken('test-secret')).not.toThrow();
        });

        it('should reject invalid token', () => {
            expect(() => service.validateWebhookToken('wrong')).toThrow(UnauthorizedException);
        });

        it('should accept any token when WEBHOOK_SECRET is not set', () => {
            delete process.env.WEBHOOK_SECRET;
            expect(() => service.validateWebhookToken('anything')).not.toThrow();
        });
    });

    describe('processEncodingWebhook', () => {
        it('should create new session doc on first webhook', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({
                userId: 'user:1',
                s3Config: { endPoint: 'minio', bucket: 'b' },
            });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'queued',
                queuePosition: 1,
            });

            expect(mockDatabaseService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'session:sess-1',
                    docType: 'session',
                    userId: 'user:1',
                    status: 'queued',
                    s3Config: { endPoint: 'minio', bucket: 'b' },
                }),
            );
        });

        it('should update existing session doc', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'queued',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 45,
            });

            expect(mockDatabaseService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _rev: '1-abc',
                    status: 'encoding',
                    progress: 45,
                }),
            );
        });

        it('should compact on completed status', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'completed',
                files: ['master.m3u8'],
                masterPlaylist: 'master.m3u8',
            });

            const doc = mockDatabaseService.upsert.mock.calls[0][0];
            expect(doc.completedAt).toBeDefined();
            expect(doc.expiresAt).toBeDefined();
            expect(doc.progress).toBeUndefined();
            expect(doc.queuePosition).toBeUndefined();
            expect(doc.files).toEqual(['master.m3u8']);
        });

        it('should resolve userId from CouchDB when not in memory', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue(undefined);
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'queued',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 10,
            });

            expect(mockDatabaseService.upsert).toHaveBeenCalled();
        });

        it('should skip webhook when userId cannot be resolved', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue(undefined);
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'unknown',
                status: 'encoding',
            });

            expect(mockDatabaseService.upsert).not.toHaveBeenCalled();
        });
    });

    describe('checkAuthorization', () => {
        it('should allow when no userId', async () => {
            const result = await service.checkAuthorization({ action: 'create_session' });
            expect(result).toEqual({ allowed: true });
        });

        it('should allow active users', async () => {
            mockUsersService.findById.mockResolvedValue({ status: 'active' });

            const result = await service.checkAuthorization({
                action: 'create_session',
                userId: 'user:1',
            });

            expect(result).toEqual({ allowed: true });
        });

        it('should deny disabled users', async () => {
            mockUsersService.findById.mockResolvedValue({ status: 'disabled' });

            const result = await service.checkAuthorization({
                action: 'create_session',
                userId: 'user:1',
            });

            expect(result).toEqual({ allowed: false, reason: 'Account disabled' });
        });

        it('should allow when user not found (master key session)', async () => {
            mockUsersService.findById.mockRejectedValue({ statusCode: 404 });

            const result = await service.checkAuthorization({
                action: 'create_session',
                userId: 'unknown',
            });

            expect(result).toEqual({ allowed: true });
        });
    });
});
