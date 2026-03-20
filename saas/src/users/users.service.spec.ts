import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { DatabaseService } from '../database/database.service.js';

vi.mock('uuid', () => ({
    v4: vi.fn().mockReturnValue('mock-uuid'),
}));

describe('UsersService', () => {
    let service: UsersService;
    let dbService: {
        find: ReturnType<typeof vi.fn>;
        insert: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        dbService = {
            find: vi.fn().mockResolvedValue({ docs: [] }),
            insert: vi
                .fn()
                .mockResolvedValue({ ok: true, id: 'user:mock-uuid', rev: '1-abc' }),
            upsert: vi
                .fn()
                .mockResolvedValue({ ok: true, id: 'user:mock-uuid', rev: '2-def' }),
            get: vi.fn(),
            destroy: vi.fn().mockResolvedValue({ ok: true }),
        };
        service = new UsersService(dbService as unknown as DatabaseService);
    });

    describe('create', () => {
        it('should create a user document', async () => {
            const dto = { email: 'test@example.com', name: 'Test User' };

            const result = await service.create(dto);

            expect(result._id).toBe('user:mock-uuid');
            expect(result.docType).toBe('user');
            expect(result.email).toBe('test@example.com');
            expect(result.name).toBe('Test User');
            expect(result.role).toBe('user');
            expect(result.status).toBe('active');
            expect(result.auth0Id).toBeNull();
            expect(dbService.insert).toHaveBeenCalled();
        });

        it('should create an admin user when role is specified', async () => {
            const dto = {
                email: 'admin@example.com',
                name: 'Admin',
                role: 'admin' as const,
            };

            const result = await service.create(dto);

            expect(result.role).toBe('admin');
        });

        it('should throw ConflictException if email already exists', async () => {
            dbService.find.mockResolvedValueOnce({
                docs: [{ _id: 'user:existing', email: 'test@example.com' }],
            });

            await expect(
                service.create({
                    email: 'test@example.com',
                    name: 'Test',
                }),
            ).rejects.toThrow(ConflictException);
        });
    });

    describe('findByEmail', () => {
        it('should find user by email', async () => {
            const user = { _id: 'user:123', email: 'test@example.com' };
            dbService.find.mockResolvedValue({ docs: [user] });

            const result = await service.findByEmail('test@example.com');

            expect(result).toEqual(user);
            expect(dbService.find).toHaveBeenCalledWith({
                selector: { docType: 'user', email: 'test@example.com' },
                use_index: 'users-by-email',
                limit: 1,
            });
        });

        it('should return null when user not found', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            const result = await service.findByEmail('missing@example.com');

            expect(result).toBeNull();
        });
    });

    describe('findByAuth0Id', () => {
        it('should find user by auth0Id', async () => {
            const user = { _id: 'user:123', auth0Id: 'auth0|123' };
            dbService.find.mockResolvedValue({ docs: [user] });

            const result = await service.findByAuth0Id('auth0|123');

            expect(result).toEqual(user);
            expect(dbService.find).toHaveBeenCalledWith({
                selector: { docType: 'user', auth0Id: 'auth0|123' },
                use_index: 'users-by-auth0id',
                limit: 1,
            });
        });

        it('should return null when auth0Id not found', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            const result = await service.findByAuth0Id('auth0|unknown');

            expect(result).toBeNull();
        });
    });

    describe('findById', () => {
        it('should find user by id', async () => {
            const user = { _id: 'user:123', _rev: '1-abc', name: 'Test' };
            dbService.get.mockResolvedValue(user);

            const result = await service.findById('user:123');

            expect(result).toEqual(user);
            expect(dbService.get).toHaveBeenCalledWith('user:123');
        });

        it('should throw NotFoundException when id not found', async () => {
            dbService.get.mockRejectedValue({ statusCode: 404 });

            await expect(service.findById('user:missing')).rejects.toThrow(
                NotFoundException,
            );
        });

        it('should rethrow non-404 errors', async () => {
            dbService.get.mockRejectedValue(new Error('connection lost'));

            await expect(service.findById('user:123')).rejects.toThrow(
                'connection lost',
            );
        });
    });

    describe('findAll', () => {
        it('should return paginated results', async () => {
            const users = [{ _id: 'user:1' }, { _id: 'user:2' }];
            dbService.find.mockResolvedValue({ docs: users });

            const result = await service.findAll({ limit: 10, skip: 0 });

            expect(result.docs).toHaveLength(2);
            expect(dbService.find).toHaveBeenCalledWith({
                selector: { docType: 'user' },
                limit: 10,
                skip: 0,
            });
        });

        it('should filter by role', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            await service.findAll({ role: 'admin' });

            expect(dbService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: expect.objectContaining({ role: 'admin' }),
                }),
            );
        });

        it('should filter by status', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            await service.findAll({ status: 'disabled' });

            expect(dbService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: expect.objectContaining({ status: 'disabled' }),
                }),
            );
        });

        it('should search by name or email', async () => {
            dbService.find.mockResolvedValue({ docs: [] });

            await service.findAll({ search: 'test' });

            expect(dbService.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    selector: expect.objectContaining({
                        $or: [
                            { email: { $regex: '(?i)test' } },
                            { name: { $regex: '(?i)test' } },
                        ],
                    }),
                }),
            );
        });
    });

    describe('update', () => {
        it('should update user fields', async () => {
            const existing = {
                _id: 'user:123',
                _rev: '1-abc',
                docType: 'user',
                name: 'Old Name',
                email: 'test@example.com',
            };
            dbService.get.mockResolvedValue(existing);

            // Capture the doc passed to upsert before it gets mutated
            let capturedDoc: any;
            dbService.upsert.mockImplementation((doc: any) => {
                capturedDoc = { ...doc };
                return Promise.resolve({ rev: '2-def' });
            });

            const result = await service.update('user:123', {
                name: 'New Name',
            });

            expect(result.name).toBe('New Name');
            expect(result._rev).toBe('2-def');

            expect(capturedDoc._id).toBe('user:123');
            expect(capturedDoc.name).toBe('New Name');
            expect(capturedDoc.docType).toBe('user');
        });
    });

    describe('remove', () => {
        it('should delete a user', async () => {
            const existing = { _id: 'user:123', _rev: '1-abc' };
            dbService.get.mockResolvedValue(existing);

            await service.remove('user:123');

            expect(dbService.destroy).toHaveBeenCalledWith(
                'user:123',
                '1-abc',
            );
        });
    });

    describe('linkAuth0Id', () => {
        it('should update user with auth0Id', async () => {
            const existing = {
                _id: 'user:123',
                _rev: '1-abc',
                docType: 'user',
                auth0Id: null,
            };
            dbService.get.mockResolvedValue(existing);
            dbService.upsert.mockResolvedValue({ rev: '2-def' });

            await service.linkAuth0Id('user:123', 'auth0|456');

            expect(dbService.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    auth0Id: 'auth0|456',
                }),
            );
        });
    });
});
