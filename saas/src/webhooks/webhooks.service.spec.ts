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
    update: vi.fn().mockResolvedValue({}),
};

const mockSessionsService = {
    getSessionRecord: vi.fn(),
};

const mockSessionEventsService = {
    emit: vi.fn(),
};

const mockKeysService = {
    findByHash: vi.fn(),
    updateLastUsed: vi.fn(),
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
            mockKeysService as any,
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

        it('should reject all tokens when WEBHOOK_SECRET is not set', () => {
            delete process.env.WEBHOOK_SECRET;
            expect(() => service.validateWebhookToken('anything')).toThrow(UnauthorizedException);
        });

        it('should reject when no token provided and WEBHOOK_SECRET is not set', () => {
            delete process.env.WEBHOOK_SECRET;
            expect(() => service.validateWebhookToken(undefined)).toThrow(UnauthorizedException);
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

            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
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

            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
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

            const doc = mockDatabaseService.insert.mock.calls[0][0];
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

            expect(mockDatabaseService.insert).toHaveBeenCalled();
        });

        it('should reject stale status updates', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'encrypting',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 99,
            });

            expect(mockDatabaseService.insert).not.toHaveBeenCalled();
            expect(mockSessionEventsService.emit).not.toHaveBeenCalled();
        });

        it('should reject same-order different-status updates', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'completed',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            // failed has the same order as completed (both 7)
            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'failed',
            });

            expect(mockDatabaseService.insert).not.toHaveBeenCalled();
        });

        it('should allow same-status updates (progress within a phase)', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 10,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 50,
            });

            expect(mockDatabaseService.insert).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'encoding',
                    progress: 50,
                }),
            );
        });

        it('should set anglePlaylists and thumbnailsVtt from webhook', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'completed',
                files: ['master.m3u8'],
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [{ name: 'angle1', key: 'angle1.m3u8' }],
                thumbnailsVtt: 'thumbs.vtt',
            });

            const doc = mockDatabaseService.insert.mock.calls[0][0];
            expect(doc.anglePlaylists).toEqual([{ name: 'angle1', key: 'angle1.m3u8' }]);
            expect(doc.thumbnailsVtt).toBe('thumbs.vtt');
        });

        it('should handle unknown status values with fallback ordering', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockResolvedValue({
                _id: 'session:sess-1',
                _rev: '1-abc',
                docType: 'session',
                userId: 'user:1',
                sessionId: 'sess-1',
                status: 'unknown_status',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'another_unknown',
            });

            // Both unknown statuses have order 0, but they're different statuses
            // so isStale = true (same order, different status)
            expect(mockDatabaseService.insert).not.toHaveBeenCalled();
        });

        it('should set encryptionKeyHex on session doc when webhook includes it', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'completed',
                files: ['master.m3u8'],
                masterPlaylist: 'master.m3u8',
                encryptionKeyHex: 'deadbeef1234567890abcdef12345678',
            });

            const doc = mockDatabaseService.insert.mock.calls[0][0];
            expect(doc.encrypted).toBe(true);
            expect(doc.encryptionKeyHex).toBe('deadbeef1234567890abcdef12345678');
        });

        it('should retry on 409 conflict and succeed', async () => {
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

            // First insert fails with 409, second succeeds
            mockDatabaseService.insert
                .mockRejectedValueOnce({ statusCode: 409 })
                .mockResolvedValueOnce({ rev: '3-def' });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'encoding',
                progress: 50,
            });

            // get is called once for userId resolution, then once per attempt in the CAS loop
            expect(mockDatabaseService.insert).toHaveBeenCalledTimes(2);
            expect(mockSessionEventsService.emit).toHaveBeenCalled();
        });

        it('should throw on non-409 insert error', async () => {
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

            mockDatabaseService.insert.mockRejectedValueOnce(new Error('Database unavailable'));

            await expect(
                service.processEncodingWebhook({
                    sessionId: 'sess-1',
                    status: 'encoding',
                    progress: 50,
                }),
            ).rejects.toThrow('Database unavailable');
        });

        it('should create doc without s3Config when memRecord has no s3Config', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'queued',
            });

            const doc = mockDatabaseService.insert.mock.calls[0][0];
            expect(doc.s3Config).toBeUndefined();
        });

        it('should compact on failed status', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'failed',
                error: 'FFmpeg crashed',
            });

            const doc = mockDatabaseService.insert.mock.calls[0][0];
            expect(doc.completedAt).toBeDefined();
            expect(doc.expiresAt).toBeDefined();
            expect(doc.progress).toBeUndefined();
            expect(doc.error).toBe('FFmpeg crashed');
        });

        it('should use custom SESSION_RETENTION_DAYS', async () => {
            process.env.SESSION_RETENTION_DAYS = '7';
            mockSessionsService.getSessionRecord.mockReturnValue({ userId: 'user:1' });
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'sess-1',
                status: 'completed',
            });

            const doc = mockDatabaseService.insert.mock.calls[0][0];
            const expiresAt = new Date(doc.expiresAt);
            const now = new Date();
            const diffDays = (expiresAt.getTime() - now.getTime()) / 86400000;
            expect(diffDays).toBeGreaterThan(6);
            expect(diffDays).toBeLessThan(8);

            delete process.env.SESSION_RETENTION_DAYS;
        });

        it('should skip webhook when userId cannot be resolved', async () => {
            mockSessionsService.getSessionRecord.mockReturnValue(undefined);
            mockDatabaseService.get.mockRejectedValue({ statusCode: 404 });

            await service.processEncodingWebhook({
                sessionId: 'unknown',
                status: 'encoding',
            });

            expect(mockDatabaseService.insert).not.toHaveBeenCalled();
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

    describe('validateApiKey', () => {
        beforeEach(() => {
            process.env.SAAS_SERVICE_URL = 'http://localhost:3001';
        });

        afterEach(() => {
            delete process.env.SAAS_SERVICE_URL;
        });

        it('should return valid with metadata for active key and active user', async () => {
            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:1',
                status: 'active',
            });
            mockUsersService.findById.mockResolvedValue({ status: 'active' });

            const result = await service.validateApiKey('lmc_test-key');

            expect(result.valid).toBe(true);
            expect(result.metadata).toEqual({
                userId: 'user:1',
                webhookUrl: 'http://localhost:3001/saas/webhooks/encoding',
                authorizationUrl: 'http://localhost:3001/saas/webhooks/authorize',
            });
            expect(mockKeysService.updateLastUsed).toHaveBeenCalledWith('apikey:1');
        });

        it('should return invalid for nonexistent key', async () => {
            mockKeysService.findByHash.mockResolvedValue(null);

            const result = await service.validateApiKey('lmc_nonexistent');

            expect(result.valid).toBe(false);
        });

        it('should return invalid for revoked key', async () => {
            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:1',
                status: 'revoked',
            });

            const result = await service.validateApiKey('lmc_revoked');

            expect(result.valid).toBe(false);
        });

        it('should return invalid for disabled user', async () => {
            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:1',
                status: 'active',
            });
            mockUsersService.findById.mockResolvedValue({ status: 'disabled' });

            const result = await service.validateApiKey('lmc_disabled-user');

            expect(result.valid).toBe(false);
        });

        it('should return invalid when user not found', async () => {
            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:missing',
                status: 'active',
            });
            mockUsersService.findById.mockRejectedValue({ statusCode: 404 });

            const result = await service.validateApiKey('lmc_orphan-key');

            expect(result.valid).toBe(false);
        });

        it('should use default SAAS_SERVICE_URL when env not set', async () => {
            delete process.env.SAAS_SERVICE_URL;

            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:1',
                status: 'active',
            });
            mockUsersService.findById.mockResolvedValue({ status: 'active' });

            const result = await service.validateApiKey('lmc_test-key');

            expect(result.valid).toBe(true);
            expect(result.metadata).toEqual({
                userId: 'user:1',
                webhookUrl: 'http://localhost:3001/saas/webhooks/encoding',
                authorizationUrl: 'http://localhost:3001/saas/webhooks/authorize',
            });
        });

        it('should silently catch user update errors', async () => {
            mockKeysService.findByHash.mockResolvedValue({
                _id: 'apikey:1',
                userId: 'user:1',
                status: 'active',
            });
            mockUsersService.findById.mockResolvedValue({ status: 'active' });
            mockUsersService.update.mockRejectedValue(new Error('db error'));

            const result = await service.validateApiKey('lmc_test-key');

            expect(result.valid).toBe(true);

            // Allow fire-and-forget to settle
            await new Promise((r) => setTimeout(r, 10));
        });
    });
});
