import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';

function createMockContext(user: any): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ user }),
        }),
    } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
    const guard = new AdminGuard();

    it('should allow admin users', () => {
        const context = createMockContext({ role: 'admin' });
        expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny non-admin users', () => {
        const context = createMockContext({ role: 'user' });
        expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny when no user on request', () => {
        const context = createMockContext(null);
        expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny when user has no role', () => {
        const context = createMockContext({});
        expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
});
