import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { S3ConfigsService } from './s3-configs.service.js';

const mockDatabaseService = {
    insert: vi.fn().mockResolvedValue({ ok: true, id: 'test', rev: '1-abc' }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    get: vi.fn(),
    upsert: vi.fn().mockResolvedValue({ ok: true, id: 'test', rev: '2-def' }),
    destroy: vi.fn().mockResolvedValue({ ok: true }),
};

const mockCryptoService = {
    encrypt: vi.fn((v: string) => ({ iv: 'iv', tag: 'tag', ciphertext: `enc_${v}` })),
    decrypt: vi.fn((f: any) => f.ciphertext.replace('enc_', '')),
};

describe('S3ConfigsService', () => {
    let service: S3ConfigsService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new S3ConfigsService(
            mockDatabaseService as any,
            mockCryptoService as any,
        );
    });

    describe('create', () => {
        it('should create a config with encrypted credentials', async () => {
            const doc = await service.create('user:1', {
                name: 'Test',
                endPoint: 's3.example.com',
                bucket: 'my-bucket',
                accessKey: 'AKID',
                secretKey: 'SECRET',
            });

            expect(doc._id).toMatch(/^s3config:/);
            expect(doc.docType).toBe('s3config');
            expect(doc.userId).toBe('user:1');
            expect(mockCryptoService.encrypt).toHaveBeenCalledWith('AKID');
            expect(mockCryptoService.encrypt).toHaveBeenCalledWith('SECRET');
            expect(mockDatabaseService.insert).toHaveBeenCalledWith(doc);
        });
    });

    describe('list', () => {
        it('should return configs for user', async () => {
            mockDatabaseService.find.mockResolvedValueOnce({
                docs: [{ _id: 's3config:1', userId: 'user:1', name: 'A' }],
            });

            const result = await service.list('user:1');
            expect(result).toHaveLength(1);
            expect(mockDatabaseService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 's3config', userId: 'user:1' },
                }),
            );
        });
    });

    describe('getById', () => {
        it('should return config for owner', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                _rev: '1-abc',
                userId: 'user:1',
                name: 'Test',
            });

            const doc = await service.getById('user:1', 's3config:1');
            expect(doc.name).toBe('Test');
        });

        it('should throw ForbiddenException for non-owner', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                userId: 'user:1',
            });

            await expect(
                service.getById('user:2', 's3config:1'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should throw NotFoundException when not found', async () => {
            mockDatabaseService.get.mockRejectedValueOnce({ statusCode: 404 });

            await expect(
                service.getById('user:1', 's3config:999'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should rethrow non-404 errors', async () => {
            mockDatabaseService.get.mockRejectedValueOnce(new Error('db error'));

            await expect(
                service.getById('user:1', 's3config:1'),
            ).rejects.toThrow('db error');
        });

        it('should auto-prefix configId without s3config: prefix', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:raw-id',
                userId: 'user:1',
                name: 'Test',
            });

            const doc = await service.getById('user:1', 'raw-id');

            expect(mockDatabaseService.get).toHaveBeenCalledWith('s3config:raw-id');
            expect(doc.name).toBe('Test');
        });
    });

    describe('update', () => {
        it('should update and re-encrypt changed credentials', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                _rev: '1-abc',
                userId: 'user:1',
                name: 'Old',
                accessKey: { iv: 'x', tag: 'y', ciphertext: 'enc_OLD' },
                secretKey: { iv: 'x', tag: 'y', ciphertext: 'enc_OLD' },
                createdAt: '2026-01-01',
                updatedAt: '2026-01-01',
            });

            const doc = await service.update('user:1', 's3config:1', {
                name: 'New',
                accessKey: 'NEW_AKID',
            });

            expect(doc.name).toBe('New');
            expect(mockCryptoService.encrypt).toHaveBeenCalledWith('NEW_AKID');
            expect(mockCryptoService.encrypt).not.toHaveBeenCalledWith('OLD');
        });

        it('should re-encrypt secretKey when changed', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                _rev: '1-abc',
                userId: 'user:1',
                name: 'Test',
                accessKey: { iv: 'x', tag: 'y', ciphertext: 'enc_AKID' },
                secretKey: { iv: 'x', tag: 'y', ciphertext: 'enc_OLD_SECRET' },
                createdAt: '2026-01-01',
                updatedAt: '2026-01-01',
            });

            const doc = await service.update('user:1', 's3config:1', {
                secretKey: 'NEW_SECRET',
            });

            expect(mockCryptoService.encrypt).toHaveBeenCalledWith('NEW_SECRET');
            expect(mockDatabaseService.upsert).toHaveBeenCalled();
        });

        it('should update all optional fields', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                _rev: '1-abc',
                userId: 'user:1',
                name: 'Old',
                endPoint: 'old.endpoint.com',
                port: 80,
                useSSL: false,
                bucket: 'old-bucket',
                region: 'us-east-1',
                accessKey: { iv: 'x', tag: 'y', ciphertext: 'enc_AK' },
                secretKey: { iv: 'x', tag: 'y', ciphertext: 'enc_SK' },
                createdAt: '2026-01-01',
                updatedAt: '2026-01-01',
            });

            const doc = await service.update('user:1', 's3config:1', {
                endPoint: 'new.endpoint.com',
                port: 443,
                useSSL: true,
                bucket: 'new-bucket',
                region: 'eu-west-1',
            });

            expect(doc.endPoint).toBe('new.endpoint.com');
            expect(doc.port).toBe(443);
            expect(doc.useSSL).toBe(true);
            expect(doc.bucket).toBe('new-bucket');
            expect(doc.region).toBe('eu-west-1');
        });
    });

    describe('remove', () => {
        it('should delete the config', async () => {
            mockDatabaseService.get.mockResolvedValueOnce({
                _id: 's3config:1',
                _rev: '1-abc',
                userId: 'user:1',
            });

            await service.remove('user:1', 's3config:1');
            expect(mockDatabaseService.destroy).toHaveBeenCalledWith(
                's3config:1',
                '1-abc',
            );
        });
    });

    describe('decryptCredentials', () => {
        it('should decrypt both fields', () => {
            const result = service.decryptCredentials({
                accessKey: { iv: 'i', tag: 't', ciphertext: 'enc_AK' },
                secretKey: { iv: 'i', tag: 't', ciphertext: 'enc_SK' },
            } as any);

            expect(result.accessKey).toBe('AK');
            expect(result.secretKey).toBe('SK');
        });
    });
});
