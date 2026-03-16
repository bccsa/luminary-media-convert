import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { IdentityService } from './identity.service.js';
import { UsersService } from '../users/users.service.js';
import { UserDocument } from '../users/interfaces/user-document.interface.js';

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
});

describe('IdentityService', () => {
    let service: IdentityService;
    let usersService: {
        findByAuth0Id: ReturnType<typeof vi.fn>;
        findByEmail: ReturnType<typeof vi.fn>;
        linkAuth0Id: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        usersService = {
            findByAuth0Id: vi.fn(),
            findByEmail: vi.fn(),
            linkAuth0Id: vi.fn(),
        };
        service = new IdentityService(usersService as unknown as UsersService);
    });

    it('should return user when found by auth0Id', async () => {
        const user = makeUser();
        usersService.findByAuth0Id.mockResolvedValue(user);

        const result = await service.resolveUser({
            sub: 'auth0|123',
            email: 'test@example.com',
        });

        expect(result).toEqual(user);
        expect(usersService.findByAuth0Id).toHaveBeenCalledWith('auth0|123');
        expect(usersService.findByEmail).not.toHaveBeenCalled();
    });

    it('should find by email and link auth0Id when not found by auth0Id', async () => {
        const user = makeUser({ auth0Id: null });
        usersService.findByAuth0Id.mockResolvedValue(null);
        usersService.findByEmail.mockResolvedValue(user);
        usersService.linkAuth0Id.mockResolvedValue(undefined);

        const result = await service.resolveUser({
            sub: 'auth0|456',
            email: 'test@example.com',
        });

        expect(usersService.findByEmail).toHaveBeenCalledWith(
            'test@example.com',
        );
        expect(usersService.linkAuth0Id).toHaveBeenCalledWith(
            'user:123',
            'auth0|456',
        );
        expect(result.auth0Id).toBe('auth0|456');
    });

    it('should throw UnauthorizedException when user not found', async () => {
        usersService.findByAuth0Id.mockResolvedValue(null);
        usersService.findByEmail.mockResolvedValue(null);

        await expect(
            service.resolveUser({
                sub: 'auth0|999',
                email: 'unknown@example.com',
            }),
        ).rejects.toThrow(UnauthorizedException);

        await expect(
            service.resolveUser({
                sub: 'auth0|999',
                email: 'unknown@example.com',
            }),
        ).rejects.toThrow('Account not provisioned');
    });

    it('should throw UnauthorizedException when user is disabled', async () => {
        const user = makeUser({ status: 'disabled' });
        usersService.findByAuth0Id.mockResolvedValue(user);

        await expect(
            service.resolveUser({
                sub: 'auth0|123',
                email: 'test@example.com',
            }),
        ).rejects.toThrow(UnauthorizedException);

        await expect(
            service.resolveUser({
                sub: 'auth0|123',
                email: 'test@example.com',
            }),
        ).rejects.toThrow('Account disabled');
    });
});
