import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KeyValidationWebhookService } from './key-validation-webhook.service';
import { SessionService } from '../encode/services/session.service';
import { AuthResolverGuard } from './auth-resolver.guard';
import type { CreateSessionDto } from '../encode/dto/create-session.dto';

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
    let keyValidationService: KeyValidationWebhookService;
    let sessionService: SessionService;
    const savedMasterKey = process.env.MASTER_API_KEY;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.MASTER_API_KEY = 'test-master-key';
        reflector = new Reflector();
        keyValidationService = {
            validateKey: vi.fn().mockResolvedValue(null),
        } as any;
        sessionService = new SessionService({ emit: () => {} } as any);
        guard = new AuthResolverGuard(
            reflector,
            keyValidationService,
            sessionService,
        );
    });

    afterEach(() => {
        if (savedMasterKey !== undefined) {
            process.env.MASTER_API_KEY = savedMasterKey;
        } else {
            delete process.env.MASTER_API_KEY;
        }
    });

    describe('master key', () => {
        it('should accept master key on any endpoint', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
                'session',
            ]);

            const ctx = createMockContext({ 'x-api-key': 'test-master-key' });
            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('master');
        });

        it('should reject when MASTER_API_KEY env var is not set', async () => {
            delete process.env.MASTER_API_KEY;
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'master',
            ]);

            const ctx = createMockContext({ 'x-api-key': 'test-master-key' });
            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('API key validated via webhook', () => {
        it('should authenticate and attach metadata to request', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
            ]);
            const metadata = {
                userId: 'user-1',
                webhookUrl: 'https://example.com/hook',
            };
            (keyValidationService.validateKey as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);

            const ctx = createMockContext({ 'x-api-key': 'external-key-123' });
            const result = await guard.canActivate(ctx);

            expect(result).toBe(true);
            const request = ctx.switchToHttp().getRequest();
            expect(request.authType).toBe('apikey');
            expect(request.apiKey).toBe(metadata);
        });

        it('should return 401 when webhook returns null', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
            ]);
            (keyValidationService.validateKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

            const ctx = createMockContext({ 'x-api-key': 'bad-key' });
            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should reject regular API key on master-only endpoints', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'master',
            ]);
            const metadata = { userId: 'user-1' };
            (keyValidationService.validateKey as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);

            const ctx = createMockContext({ 'x-api-key': 'external-key-123' });
            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });

    describe('session token', () => {
        it('should authenticate via Bearer sess_ token', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'session',
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
            expect(request.session.id).toBe(session.id);
        });
    });

    describe('no credentials', () => {
        it('should throw when no credentials provided', async () => {
            vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
                'apikey',
                'session',
            ]);

            const ctx = createMockContext();
            await expect(guard.canActivate(ctx)).rejects.toThrow(
                UnauthorizedException,
            );
        });
    });
});
