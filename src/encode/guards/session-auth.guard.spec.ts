import { UnauthorizedException } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from '../services/session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(): CreateSessionDto {
    return {
        type: 'video',
        renditions: [
            { width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
        ],
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
        webhook: {
            url: 'https://example.com/webhook',
            sessionToken: 'tok',
        },
    };
}

function createMockContext(
    authHeader: string | undefined,
    sessionId: string
): any {
    const request = {
        headers: { authorization: authHeader },
        params: { sessionId },
    };
    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
    };
}

describe('SessionAuthGuard', () => {
    let sessionService: SessionService;
    let guard: SessionAuthGuard;

    beforeEach(() => {
        sessionService = new SessionService();
        guard = new SessionAuthGuard(sessionService);
    });

    it('should allow valid token for correct session', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id
        );

        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should attach session to request object', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id
        );

        guard.canActivate(ctx);

        const request = ctx.switchToHttp().getRequest();
        expect(request.session).toBeDefined();
        expect(request.session.id).toBe(session.id);
    });

    it('should reject missing Authorization header', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(undefined, session.id);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject non-Bearer scheme', () => {
        const session = sessionService.create(makeConfig());
        const encoded = Buffer.from('user:pass').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`, session.id);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject empty Bearer token', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext('Bearer ', session.id);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject unknown token', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext('Bearer tok_invalid', session.id);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject token for a different session', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            'different-session-id'
        );

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject upload when session is not in created status', () => {
        const session = sessionService.create(makeConfig());
        sessionService.updateStatus(session.id, 'queued');

        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id
        );

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
});
