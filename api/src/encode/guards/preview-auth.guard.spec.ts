import { UnauthorizedException } from '@nestjs/common';
import { PreviewAuthGuard } from './preview-auth.guard.js';
import { SessionService } from '../services/session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

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
    authHeader: string | undefined,
    sessionId: string,
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

describe('PreviewAuthGuard', () => {
    let sessionService: SessionService;
    let guard: PreviewAuthGuard;

    beforeEach(() => {
        sessionService = new SessionService();
        guard = new PreviewAuthGuard(sessionService);
    });

    it('should allow valid token for correct session', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id,
        );

        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should attach session to request object', () => {
        const session = sessionService.create(makeConfig());
        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id,
        );

        guard.canActivate(ctx);

        const request = ctx.switchToHttp().getRequest();
        expect(request.session).toBeDefined();
        expect(request.session.id).toBe(session.id);
    });

    it('should allow access regardless of session status', () => {
        const session = sessionService.create(makeConfig());
        sessionService.updateStatus(session.id, 'encoding');

        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id,
        );

        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should allow access for completed sessions', () => {
        const session = sessionService.create(makeConfig());
        sessionService.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');

        const ctx = createMockContext(
            `Bearer ${session.uploadToken}`,
            session.id,
        );

        expect(guard.canActivate(ctx)).toBe(true);
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
            'different-session-id',
        );

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
});
