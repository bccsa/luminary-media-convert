import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { UserDocument } from './interfaces/user-document.interface.js';

const makeUser = (overrides: Partial<UserDocument> = {}): UserDocument => ({
    _id: 'user:123',
    _rev: '1-abc',
    docType: 'user',
    auth0Id: 'auth0|123',
    email: 'test@example.com',
    name: 'Test User',
    role: 'user',
    status: 'active',
    sessionRetentionDaysOverride: null,
    emailVerifiedAt: new Date().toISOString(),
    invitedBy: null,
    onboardingCompletedAt: null,
    lastLoginAt: null,
    lastApiAccessAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
});

describe('UsersController', () => {
    let controller: UsersController;
    let usersService: {
        create: ReturnType<typeof vi.fn>;
        findAll: ReturnType<typeof vi.fn>;
        findById: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        remove: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        usersService = {
            create: vi.fn(),
            findAll: vi.fn(),
            findById: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
        };
        controller = new UsersController(
            usersService as unknown as UsersService,
        );
    });

    describe('me', () => {
        it('should return the current user from request', async () => {
            const user = makeUser({ role: 'admin' });
            const req = { user };

            const result = await controller.me(req);

            expect(result.id).toBe('user:123');
            expect(result.email).toBe('test@example.com');
            expect(result.role).toBe('admin');
            expect(result.lastLoginAt).toBeNull();
            expect(result.lastApiAccessAt).toBeNull();
            expect(result).not.toHaveProperty('_rev');
            expect(result).not.toHaveProperty('docType');
        });
    });

    describe('create', () => {
        it('should create a user and return response DTO', async () => {
            const user = makeUser();
            usersService.create.mockResolvedValue(user);

            const result = await controller.create({
                email: 'test@example.com',
                name: 'Test User',
            });

            expect(result.id).toBe('user:123');
            expect(result.email).toBe('test@example.com');
            expect(result.name).toBe('Test User');
            expect(result.role).toBe('user');
            expect(result.status).toBe('active');
            expect(result.lastLoginAt).toBeNull();
            expect(result.lastApiAccessAt).toBeNull();
            expect(result).not.toHaveProperty('_rev');
            expect(result).not.toHaveProperty('docType');
        });
    });

    describe('findAll', () => {
        it('should return paginated users', async () => {
            const users = [makeUser(), makeUser({ _id: 'user:456' })];
            usersService.findAll.mockResolvedValue({
                docs: users,
                total: 2,
            });

            const result = await controller.findAll(10, 0);

            expect(result.users).toHaveLength(2);
            expect(result.total).toBe(2);
            expect(usersService.findAll).toHaveBeenCalledWith({
                limit: 10,
                skip: 0,
                search: undefined,
                role: undefined,
                status: undefined,
            });
        });

        it('should pass search and filter params', async () => {
            usersService.findAll.mockResolvedValue({ docs: [], total: 0 });

            await controller.findAll(25, 0, 'test', 'admin', 'active');

            expect(usersService.findAll).toHaveBeenCalledWith({
                limit: 25,
                skip: 0,
                search: 'test',
                role: 'admin',
                status: 'active',
            });
        });
    });

    describe('findOne', () => {
        it('should return a single user', async () => {
            const user = makeUser();
            usersService.findById.mockResolvedValue(user);

            const result = await controller.findOne('user:123');

            expect(result.id).toBe('user:123');
            expect(usersService.findById).toHaveBeenCalledWith('user:123');
        });
    });

    describe('update', () => {
        it('should update and return user', async () => {
            const user = makeUser({ name: 'Updated Name' });
            usersService.update.mockResolvedValue(user);

            const result = await controller.update('user:123', {
                name: 'Updated Name',
            });

            expect(result.name).toBe('Updated Name');
            expect(usersService.update).toHaveBeenCalledWith('user:123', {
                name: 'Updated Name',
            });
        });
    });

    describe('disable', () => {
        it('should disable a user', async () => {
            const user = makeUser({ status: 'disabled' });
            usersService.update.mockResolvedValue(user);
            const req = { user: makeUser({ _id: 'user:admin' }) };

            const result = await controller.disable('user:123', req);

            expect(result.status).toBe('disabled');
            expect(usersService.update).toHaveBeenCalledWith('user:123', {
                status: 'disabled',
            });
        });

        it('should throw ForbiddenException when disabling own account', async () => {
            const req = { user: makeUser({ _id: 'user:123' }) };

            await expect(controller.disable('user:123', req)).rejects.toThrow(
                ForbiddenException,
            );
            await expect(controller.disable('user:123', req)).rejects.toThrow(
                'Cannot disable your own account',
            );
            expect(usersService.update).not.toHaveBeenCalled();
        });
    });

    describe('enable', () => {
        it('should enable a user', async () => {
            const user = makeUser({ status: 'active' });
            usersService.update.mockResolvedValue(user);

            const result = await controller.enable('user:123');

            expect(result.status).toBe('active');
            expect(usersService.update).toHaveBeenCalledWith('user:123', {
                status: 'active',
            });
        });
    });

    describe('remove', () => {
        it('should remove a user', async () => {
            usersService.remove.mockResolvedValue(undefined);
            const req = { user: makeUser({ _id: 'user:admin' }) };

            await controller.remove('user:123', req);

            expect(usersService.remove).toHaveBeenCalledWith('user:123');
        });

        it('should throw ForbiddenException when deleting own account', async () => {
            const req = { user: makeUser({ _id: 'user:123' }) };

            await expect(controller.remove('user:123', req)).rejects.toThrow(
                ForbiddenException,
            );
            await expect(controller.remove('user:123', req)).rejects.toThrow(
                'Cannot delete your own account',
            );
            expect(usersService.remove).not.toHaveBeenCalled();
        });
    });

    describe('toResponse', () => {
        it('should map lastLoginAt and lastApiAccessAt from user document', async () => {
            const user = makeUser({
                lastLoginAt: '2026-03-18T10:00:00.000Z',
                lastApiAccessAt: '2026-03-18T09:00:00.000Z',
            });
            const req = { user };

            const result = await controller.me(req);

            expect(result.lastLoginAt).toBe('2026-03-18T10:00:00.000Z');
            expect(result.lastApiAccessAt).toBe('2026-03-18T09:00:00.000Z');
        });

        it('should default missing lastLoginAt/lastApiAccessAt to null', async () => {
            const user = makeUser();
            // Simulate old documents without the fields
            delete (user as any).lastLoginAt;
            delete (user as any).lastApiAccessAt;
            const req = { user };

            const result = await controller.me(req);

            expect(result.lastLoginAt).toBeNull();
            expect(result.lastApiAccessAt).toBeNull();
        });
    });
});
