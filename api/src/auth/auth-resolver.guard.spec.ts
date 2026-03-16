import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from '../apikey/apikey.service';
import { SessionService } from '../encode/services/session.service';
import type { CreateSessionDto } from '../encode/dto/create-session.dto';

const mockJwtCanActivate = vi.fn();

// Mock the JwtAuthGuard so we don't need a real Passport strategy
vi.mock('./jwt-auth.guard', () => ({
    JwtAuthGuard: vi.fn().mockImplementation(function () {
        return { canActivate: mockJwtCanActivate };
    }),
}));

import { AuthResolverGuard } from './auth-resolver.guard';

function makeConfig(): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
    };
}

function createMockContext(
    headers: Record<string, string> = {},
    params: Record<string, string> = {},
): any {
    const request = { headers, params };
    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
    };
}

describe('AuthResolverGuard', () => {
    let guard: AuthResolverGuard;
    let reflector: Reflector;
    let apiKeyService: ApiKeyService;
    let sessionService: SessionService;

    beforeEach(() => {
        vi.clearAllMocks();
        reflector = new Reflector();
        apiKeyService = new ApiKeyService();
        sessionService = new SessionService();
        guard = new AuthResolverGuard(reflector, apiKeyService, sessionService);
    });

    describe('with default auth types (jwt only)', () => {
        it('should try JWT when no decorator is set', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
            mockJwtCanActivate.mockResolvedValue(true);

            const ctx = createMockContext();
            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('jwt');
        });

        it('should throw when JWT fails and no other methods allowed', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
            mockJwtCanActivate.mockRejectedValue(new Error('JWT failed'));

            const ctx = createMockContext();
            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('with apikey auth type', () => {
        beforeEach(() => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['apikey']);
        });

        it('should authenticate via X-API-Key header', async () => {
            const { key } = apiKeyService.create({ name: 'Test' });
            const ctx = createMockContext({ 'x-api-key': key });

            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('apikey');
            expect(request.apiKey.name).toBe('Test');
        });

        it('should throw for invalid API key', async () => {
            const ctx = createMockContext({ 'x-api-key': 'lmc_invalid' });

            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should throw when no credentials provided', async () => {
            const ctx = createMockContext();

            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('with session auth type', () => {
        beforeEach(() => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['session']);
        });

        it('should authenticate via Bearer sess_ token', async () => {
            const session = sessionService.create(makeConfig());
            const ctx = createMockContext(
                { authorization: `Bearer ${session.sessionToken}` },
                { sessionId: session.id },
            );

            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('session');
            expect(request.session.id).toBe(session.id);
        });

        it('should throw for invalid session token', async () => {
            const ctx = createMockContext(
                { authorization: 'Bearer sess_invalid' },
                { sessionId: 'some-id' },
            );

            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should throw when session token does not match sessionId param', async () => {
            const session = sessionService.create(makeConfig());
            const ctx = createMockContext(
                { authorization: `Bearer ${session.sessionToken}` },
                { sessionId: 'different-id' },
            );

            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should ignore non-sess_ bearer tokens', async () => {
            const ctx = createMockContext(
                { authorization: 'Bearer jwt_token_here' },
            );

            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('with multiple auth types', () => {
        it('should prefer API key over session token', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
                'session',
            ]);
            const { key } = apiKeyService.create({ name: 'API Key' });
            const session = sessionService.create(makeConfig());

            const ctx = createMockContext(
                {
                    'x-api-key': key,
                    authorization: `Bearer ${session.sessionToken}`,
                },
                { sessionId: session.id },
            );

            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('apikey');
        });

        it('should fall through to session when no API key header', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
                'session',
                'jwt',
            ]);
            const session = sessionService.create(makeConfig());

            const ctx = createMockContext(
                { authorization: `Bearer ${session.sessionToken}` },
                { sessionId: session.id },
            );

            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('session');
        });

        it('should fall through to JWT when no API key or session token', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
                'session',
                'jwt',
            ]);
            mockJwtCanActivate.mockResolvedValue(true);

            const ctx = createMockContext(
                { authorization: 'Bearer some.jwt.token' },
            );

            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('jwt');
        });
    });
});
