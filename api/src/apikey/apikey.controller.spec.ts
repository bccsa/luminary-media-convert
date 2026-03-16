import { NotFoundException } from '@nestjs/common';
import { ApiKeyController } from './apikey.controller';
import { ApiKeyService } from './apikey.service';

describe('ApiKeyController', () => {
    let controller: ApiKeyController;
    let service: ApiKeyService;

    beforeEach(() => {
        service = new ApiKeyService();
        controller = new ApiKeyController(service);
    });

    describe('createKey', () => {
        it('should create a key and return the full key once', () => {
            const result = controller.createKey({ name: 'Production' });

            expect(result.key).toMatch(/^lmc_/);
            expect(result.name).toBe('Production');
            expect(result.id).toBeDefined();
            expect(result.keyPrefix).toMatch(/^lmc_[0-9a-f]{8}$/);
            expect(result.createdAt).toBeDefined();
        });

        it('should include optional fields when provided', () => {
            const result = controller.createKey({
                name: 'With Options',
                webhookUrl: 'https://example.com/hook',
                authorizationUrl: 'https://example.com/auth',
                expiresAt: '2027-06-01T00:00:00Z',
            });

            expect(result.webhookUrl).toBe('https://example.com/hook');
            expect(result.authorizationUrl).toBe('https://example.com/auth');
            expect(result.expiresAt).toBe('2027-06-01T00:00:00.000Z');
        });
    });

    describe('listKeys', () => {
        it('should return all active keys', () => {
            controller.createKey({ name: 'Key A' });
            controller.createKey({ name: 'Key B' });

            const keys = controller.listKeys();
            expect(keys).toHaveLength(2);
            expect(keys.map((k) => k.name).sort()).toEqual(['Key A', 'Key B']);
        });

        it('should exclude revoked keys', () => {
            const created = controller.createKey({ name: 'Will Revoke' });
            controller.createKey({ name: 'Stays' });

            controller.revokeKey(created.id);

            const keys = controller.listKeys();
            expect(keys).toHaveLength(1);
            expect(keys[0].name).toBe('Stays');
        });

        it('should return empty array when no keys exist', () => {
            expect(controller.listKeys()).toEqual([]);
        });
    });

    describe('revokeKey', () => {
        it('should revoke an existing key', () => {
            const created = controller.createKey({ name: 'To Revoke' });

            expect(() => controller.revokeKey(created.id)).not.toThrow();
        });

        it('should throw NotFoundException for unknown key', () => {
            expect(() => controller.revokeKey('nonexistent')).toThrow(
                NotFoundException,
            );
        });

        it('should throw NotFoundException for already revoked key', () => {
            const created = controller.createKey({ name: 'Revoked' });
            controller.revokeKey(created.id);

            expect(() => controller.revokeKey(created.id)).toThrow(
                NotFoundException,
            );
        });
    });
});
