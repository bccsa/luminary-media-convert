import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    NotFoundException,
    ForbiddenException,
    ConflictException,
} from '@nestjs/common';
import { KeysService } from './keys.service.js';
import { DatabaseService } from '../database/database.service.js';

describe('KeysService', () => {
    let service: KeysService;
    let dbService: {
        find: ReturnType<typeof vi.fn>;
        insert: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        dbService = {
            find: vi.fn().mockResolvedValue({ docs: [] }),
            insert: vi
                .fn()
                .mockResolvedValue({ ok: true, id: 'apikey:mock-uuid', rev: '1-abc' }),
            upsert: vi
                .fn()
                .mockResolvedValue({ ok: true, id: 'apikey:mock-uuid', rev: '2-def' }),
            get: vi.fn(),
        };
        service = new KeysService(dbService as unknown as DatabaseService);
    });

    describe('createKey', () => {
        it('should store the client-provided hash and prefix', async () => {
            const keyHash = 'a'.repeat(64);
            const prefix = 'lmc_abc12345';

            const doc = await service.createKey(
                'user:123',
                'My API Key',
                keyHash,
                prefix,
            );

            expect(doc.docType).toBe('apikey');
            expect(doc._id).toMatch(/^apikey:/);
            expect(doc.userId).toBe('user:123');
            expect(doc.name).toBe('My API Key');
            expect(doc.status).toBe('active');
            expect(doc.prefix).toBe(prefix);
            expect(doc.keyHash).toBe(keyHash);
            expect(doc.createdAt).toBeDefined();
            expect(doc.updatedAt).toBeDefined();
            expect(dbService.insert).toHaveBeenCalledWith(doc);
        });

        it('should never store or return the raw key', async () => {
            const doc = await service.createKey(
                'user:123',
                'Test Key',
                'b'.repeat(64),
                'lmc_test1234',
            );

            // The doc should not contain any raw key field
            expect(doc).not.toHaveProperty('rawKey');
            expect(doc).not.toHaveProperty('key');
        });
    });

    describe('listKeys', () => {
        it('should query CouchDB for user API keys', async () => {
            const keys = [
                { _id: 'apikey:1', name: 'Key 1', userId: 'user:123' },
                { _id: 'apikey:2', name: 'Key 2', userId: 'user:123' },
            ];
            dbService.find.mockResolvedValue({ docs: keys });

            const result = await service.listKeys('user:123');

            expect(result).toEqual(keys);
            expect(dbService.find).toHaveBeenCalledWith({
                selector: { docType: 'apikey', userId: 'user:123' },
                use_index: 'apikeys-by-user',
                sort: [{ createdAt: 'desc' }],
                limit: 100,
            });
        });

        it('should return empty array when no keys exist', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            const result = await service.listKeys('user:123');

            expect(result).toEqual([]);
        });
    });

    describe('revokeKey', () => {
        it('should revoke an active key owned by the user', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:123',
                name: 'Key 1',
                status: 'active',
            });

            const result = await service.revokeKey('user:123', 'apikey:1');

            expect(result.status).toBe('revoked');
            expect(result.revokedAt).toBeDefined();
            expect(dbService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'apikey:1',
                    status: 'revoked',
                }),
            );
        });

        it('should throw ForbiddenException when user does not own the key', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:other',
                status: 'active',
            });

            await expect(
                service.revokeKey('user:123', 'apikey:1'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should throw ConflictException when key is already revoked', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:123',
                status: 'revoked',
            });

            await expect(
                service.revokeKey('user:123', 'apikey:1'),
            ).rejects.toThrow(ConflictException);
        });

        it('should throw NotFoundException when key does not exist', async () => {
            dbService.get.mockRejectedValue({ statusCode: 404 });

            await expect(
                service.revokeKey('user:123', 'apikey:missing'),
            ).rejects.toThrow(NotFoundException);
        });

        it('should rethrow non-404 errors', async () => {
            dbService.get.mockRejectedValue(new Error('connection lost'));

            await expect(
                service.revokeKey('user:123', 'apikey:1'),
            ).rejects.toThrow('connection lost');
        });
    });

    describe('adminRevokeKey', () => {
        it('should revoke a key without ownership check', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:other',
                status: 'active',
            });

            const result = await service.adminRevokeKey('apikey:1');

            expect(result.status).toBe('revoked');
            expect(result.revokedAt).toBeDefined();
            expect(dbService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'apikey:1',
                    status: 'revoked',
                }),
            );
        });

        it('should throw ConflictException when key is already revoked', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:123',
                status: 'revoked',
            });

            await expect(service.adminRevokeKey('apikey:1')).rejects.toThrow(
                ConflictException,
            );
        });

        it('should throw NotFoundException when key does not exist', async () => {
            dbService.get.mockRejectedValue({ statusCode: 404 });

            await expect(
                service.adminRevokeKey('apikey:missing'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('findByHash', () => {
        it('should return matching key document', async () => {
            const keyDoc = {
                _id: 'apikey:1',
                docType: 'apikey',
                keyHash: 'abc123',
                status: 'active',
            };
            dbService.find.mockResolvedValue({ docs: [keyDoc] });

            const result = await service.findByHash('abc123');

            expect(result).toEqual(keyDoc);
            expect(dbService.find).toHaveBeenCalledWith({
                selector: { docType: 'apikey', keyHash: 'abc123' },
                use_index: 'apikeys-by-hash',
                limit: 1,
            });
        });

        it('should return null when no match found', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            const result = await service.findByHash('nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('updateLastUsed', () => {
        it('should fire-and-forget update of lastUsedAt', async () => {
            dbService.get.mockResolvedValue({
                _id: 'apikey:1',
                _rev: '1-abc',
                docType: 'apikey',
                userId: 'user:123',
                status: 'active',
            });

            // Should not throw — fire-and-forget
            service.updateLastUsed('apikey:1');

            // Allow the promise chain to resolve
            await new Promise((r) => setTimeout(r, 10));

            expect(dbService.get).toHaveBeenCalledWith('apikey:1');
            expect(dbService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    _id: 'apikey:1',
                    lastUsedAt: expect.any(String),
                }),
            );
        });

        it('should not throw when the update fails', async () => {
            dbService.get.mockRejectedValue(new Error('db error'));

            // Should not throw
            service.updateLastUsed('apikey:missing');

            await new Promise((r) => setTimeout(r, 10));
        });
    });

    describe('listKeysByUserId', () => {
        it('should be an alias for listKeys', async () => {
            const keys = [{ _id: 'apikey:1' }];
            dbService.find.mockResolvedValue({ docs: keys });

            const result = await service.listKeysByUserId('user:123');

            expect(result).toEqual(keys);
            expect(dbService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: { docType: 'apikey', userId: 'user:123' },
                }),
            );
        });
    });
});
