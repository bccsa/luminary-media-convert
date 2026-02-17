import { UnauthorizedException } from '@nestjs/common';
import { BasicAuthGuard } from './basic-auth.guard.js';

function createMockContext(authHeader?: string): any {
    return {
        switchToHttp: () => ({
            getRequest: () => ({
                headers: {
                    authorization: authHeader,
                },
            }),
        }),
    };
}

describe('BasicAuthGuard', () => {
    const originalUsername = process.env.AUTH_USERNAME;
    const originalPassword = process.env.AUTH_PASSWORD;

    afterEach(() => {
        // Restore original values
        if (originalUsername !== undefined)
            process.env.AUTH_USERNAME = originalUsername;
        else delete process.env.AUTH_USERNAME;
        if (originalPassword !== undefined)
            process.env.AUTH_PASSWORD = originalPassword;
        else delete process.env.AUTH_PASSWORD;
    });

    function createGuard(username: string, password: string): BasicAuthGuard {
        process.env.AUTH_USERNAME = username;
        process.env.AUTH_PASSWORD = password;
        // BasicAuthGuard reads env in constructor, so we need a new instance
        return new BasicAuthGuard();
    }

    it('should allow valid credentials', () => {
        const guard = createGuard('admin', 'secret');
        const encoded = Buffer.from('admin:secret').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should reject wrong username', () => {
        const guard = createGuard('admin', 'secret');
        const encoded = Buffer.from('wrong:secret').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject wrong password', () => {
        const guard = createGuard('admin', 'secret');
        const encoded = Buffer.from('admin:wrong').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject missing Authorization header', () => {
        const guard = createGuard('admin', 'secret');
        const ctx = createMockContext(undefined);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject non-Basic auth scheme', () => {
        const guard = createGuard('admin', 'secret');
        const ctx = createMockContext('Bearer some-token');

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject malformed base64 (no colon separator)', () => {
        const guard = createGuard('admin', 'secret');
        const encoded = Buffer.from('nocolon').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should throw when env vars are not configured', () => {
        const guard = createGuard('', '');
        const encoded = Buffer.from('admin:secret').toString('base64');
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should handle passwords containing colons', () => {
        const guard = createGuard('admin', 'pass:with:colons');
        const encoded = Buffer.from('admin:pass:with:colons').toString(
            'base64'
        );
        const ctx = createMockContext(`Basic ${encoded}`);

        expect(guard.canActivate(ctx)).toBe(true);
    });
});
