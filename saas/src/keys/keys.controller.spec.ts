import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeysController } from './keys.controller.js';
import { KeysService } from './keys.service.js';

describe('KeysController', () => {
    let controller: KeysController;
    let keysService: {
        createKey: ReturnType<typeof vi.fn>;
        listKeys: ReturnType<typeof vi.fn>;
        revokeKey: ReturnType<typeof vi.fn>;
    };

    const mockUser = { user: { _id: 'user:123' } };

    beforeEach(() => {
        keysService = {
            createKey: vi.fn(),
            listKeys: vi.fn(),
            revokeKey: vi.fn(),
        };
        controller = new KeysController(keysService as unknown as KeysService);
    });

    describe('POST /saas/keys', () => {
        it('should store client-provided hash and return KeyResponseDto (no raw key)', async () => {
            const keyHash = 'a'.repeat(64);
            keysService.createKey.mockResolvedValue({
                _id: 'apikey:1',
                name: 'My Key',
                prefix: 'lmc_abc12345',
                status: 'active',
                createdAt: '2026-01-01T00:00:00.000Z',
            });

            const result = await controller.create(
                { name: 'My Key', keyHash, prefix: 'lmc_abc12345' },
                mockUser,
            );

            expect(result).toEqual({
                id: 'apikey:1',
                name: 'My Key',
                prefix: 'lmc_abc12345',
                status: 'active',
                lastUsedAt: undefined,
                createdAt: '2026-01-01T00:00:00.000Z',
            });
            // No raw key in response
            expect((result as any).key).toBeUndefined();
            expect((result as any).rawKey).toBeUndefined();
            expect(keysService.createKey).toHaveBeenCalledWith(
                'user:123',
                'My Key',
                keyHash,
                'lmc_abc12345',
            );
        });
    });

    describe('GET /saas/keys', () => {
        it('should list user keys as KeyResponseDto[]', async () => {
            keysService.listKeys.mockResolvedValue([
                {
                    _id: 'apikey:1',
                    name: 'Key 1',
                    prefix: 'lmc_abc12345',
                    status: 'active',
                    lastUsedAt: '2026-01-01T12:00:00.000Z',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
                {
                    _id: 'apikey:2',
                    name: 'Key 2',
                    prefix: 'lmc_def67890',
                    status: 'revoked',
                    createdAt: '2025-12-01T00:00:00.000Z',
                },
            ]);

            const result = await controller.list(mockUser);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'apikey:1',
                name: 'Key 1',
                prefix: 'lmc_abc12345',
                status: 'active',
                lastUsedAt: '2026-01-01T12:00:00.000Z',
                createdAt: '2026-01-01T00:00:00.000Z',
            });
            expect(result[1].status).toBe('revoked');
            // Ensure raw key hash is not exposed
            expect((result[0] as any).keyHash).toBeUndefined();
        });
    });

    describe('DELETE /saas/keys/:keyId', () => {
        it('should revoke the key', async () => {
            keysService.revokeKey.mockResolvedValue({
                _id: 'apikey:1',
                status: 'revoked',
            });

            await controller.revoke('apikey:1', mockUser);

            expect(keysService.revokeKey).toHaveBeenCalledWith(
                'user:123',
                'apikey:1',
            );
        });
    });
});
