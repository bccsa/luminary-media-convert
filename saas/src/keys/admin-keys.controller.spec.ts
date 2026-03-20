import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminKeysController } from './admin-keys.controller.js';
import { KeysService } from './keys.service.js';

describe('AdminKeysController', () => {
    let controller: AdminKeysController;
    let keysService: {
        listKeysByUserId: ReturnType<typeof vi.fn>;
        adminRevokeKey: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        keysService = {
            listKeysByUserId: vi.fn().mockResolvedValue([]),
            adminRevokeKey: vi.fn().mockResolvedValue({ _id: 'apikey:1', status: 'revoked' }),
        };
        controller = new AdminKeysController(
            keysService as unknown as KeysService,
        );
    });

    describe('listUserKeys', () => {
        it('should list keys for a user and map to response DTOs', async () => {
            keysService.listKeysByUserId.mockResolvedValue([
                {
                    _id: 'apikey:1',
                    name: 'Key 1',
                    prefix: 'lmc_abc12345',
                    status: 'active',
                    lastUsedAt: '2026-01-01T00:00:00.000Z',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ]);

            const result = await controller.listUserKeys('user:1');

            expect(keysService.listKeysByUserId).toHaveBeenCalledWith('user:1');
            expect(result).toEqual([
                {
                    id: 'apikey:1',
                    name: 'Key 1',
                    prefix: 'lmc_abc12345',
                    status: 'active',
                    lastUsedAt: '2026-01-01T00:00:00.000Z',
                    createdAt: '2026-01-01T00:00:00.000Z',
                },
            ]);
        });

        it('should return empty array when user has no keys', async () => {
            const result = await controller.listUserKeys('user:1');
            expect(result).toEqual([]);
        });
    });

    describe('revokeUserKey', () => {
        it('should revoke key by ID (ignoring userId param)', async () => {
            await controller.revokeUserKey('user:1', 'apikey:1');

            expect(keysService.adminRevokeKey).toHaveBeenCalledWith('apikey:1');
        });
    });
});
