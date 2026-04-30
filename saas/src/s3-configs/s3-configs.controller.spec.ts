import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3ConfigsController } from './s3-configs.controller.js';
import { S3ConfigsService } from './s3-configs.service.js';

describe('S3ConfigsController', () => {
    let controller: S3ConfigsController;
    let service: {
        create: ReturnType<typeof vi.fn>;
        list: ReturnType<typeof vi.fn>;
        getById: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
        decryptCredentials: ReturnType<typeof vi.fn>;
    };

    const mockDoc = {
        _id: 's3config:1',
        name: 'Test Config',
        endPoint: 's3.example.com',
        port: 443,
        useSSL: true,
        bucket: 'my-bucket',
        region: 'us-east-1',
        pathPrefix: 'output/',
        accessKey: { iv: 'iv', tag: 'tag', ciphertext: 'enc_AKID' },
        secretKey: { iv: 'iv', tag: 'tag', ciphertext: 'enc_SECRET' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const req = { user: { _id: 'user:1' } };

    beforeEach(() => {
        service = {
            create: vi.fn().mockResolvedValue(mockDoc),
            list: vi.fn().mockResolvedValue([mockDoc]),
            getById: vi.fn().mockResolvedValue(mockDoc),
            update: vi.fn().mockResolvedValue(mockDoc),
            remove: vi.fn().mockResolvedValue(undefined),
            decryptCredentials: vi.fn().mockReturnValue({
                accessKey: 'AKID',
                secretKey: 'SECRET',
            }),
        };
        controller = new S3ConfigsController(
            service as unknown as S3ConfigsService,
        );
    });

    describe('create', () => {
        it('should create config and mask credentials in response', async () => {
            const dto = {
                name: 'Test',
                endPoint: 's3.example.com',
                bucket: 'b',
                accessKey: 'AKID',
                secretKey: 'SECRET',
            };

            const result = await controller.create(dto as any, req as any);

            expect(service.create).toHaveBeenCalledWith('user:1', dto);
            expect(result.accessKey).toBe('***');
            expect(result.secretKey).toBe('***');
            expect(result.id).toBe('s3config:1');
            expect(result.name).toBe('Test Config');
        });
    });

    describe('list', () => {
        it('should list configs with masked credentials', async () => {
            const result = await controller.list(req as any);

            expect(service.list).toHaveBeenCalledWith('user:1');
            expect(result.configs).toHaveLength(1);
            expect(result.configs[0].accessKey).toBe('***');
            expect(result.configs[0].secretKey).toBe('***');
        });
    });

    describe('detail', () => {
        it('should return config with decrypted credentials', async () => {
            const result = await controller.detail('s3config:1', req as any);

            expect(service.getById).toHaveBeenCalledWith('user:1', 's3config:1');
            expect(service.decryptCredentials).toHaveBeenCalledWith(mockDoc);
            expect(result.accessKey).toBe('AKID');
            expect(result.secretKey).toBe('SECRET');
            expect(result.id).toBe('s3config:1');
        });
    });

    describe('update', () => {
        it('should update config and mask credentials in response', async () => {
            const dto = { name: 'Updated' };
            const result = await controller.update('s3config:1', dto as any, req as any);

            expect(service.update).toHaveBeenCalledWith('user:1', 's3config:1', dto);
            expect(result.accessKey).toBe('***');
            expect(result.secretKey).toBe('***');
        });
    });

    describe('remove', () => {
        it('should delete config', async () => {
            await controller.remove('s3config:1', req as any);

            expect(service.remove).toHaveBeenCalledWith('user:1', 's3config:1');
        });
    });
});
