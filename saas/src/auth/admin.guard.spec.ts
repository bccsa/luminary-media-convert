import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminGuard } from './admin.guard.js';

function createMockContext(user: any): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ user }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
    } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
    let reflector: Reflector;
    let guard: AdminGuard;

    beforeEach(() => {
        reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as unknown as Reflector;
        guard = new AdminGuard(reflector);
    });

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

    it('should skip admin check when @SkipAdmin() is set', () => {
        (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);
        const context = createMockContext({ role: 'user' });
        expect(guard.canActivate(context)).toBe(true);
    });

    it('should skip admin check even when no user on request', () => {
        (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);
        const context = createMockContext(null);
        expect(guard.canActivate(context)).toBe(true);
    });
});
