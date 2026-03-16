import { describe, it, expect, vi, beforeEach } from 'vitest';
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

            const result = await controller.disable('user:123');

            expect(result.status).toBe('disabled');
            expect(usersService.update).toHaveBeenCalledWith('user:123', {
                status: 'disabled',
            });
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

            await controller.remove('user:123');

            expect(usersService.remove).toHaveBeenCalledWith('user:123');
        });
    });
});
