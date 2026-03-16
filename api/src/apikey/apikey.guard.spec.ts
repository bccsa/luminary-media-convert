import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './apikey.guard';
import { ApiKeyService } from './apikey.service';

function createMockContext(apiKeyHeader?: string): any {
    const headers: Record<string, string | undefined> = {};
    if (apiKeyHeader !== undefined) {
        headers['x-api-key'] = apiKeyHeader;
    }
    const request = { headers };
    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
    };
}

describe('ApiKeyGuard', () => {
    let service: ApiKeyService;
    let guard: ApiKeyGuard;

    beforeEach(() => {
        service = new ApiKeyService();
        guard = new ApiKeyGuard(service);
    });

    it('should return false when X-API-Key header is absent', () => {
        const ctx = createMockContext();
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it('should throw UnauthorizedException for invalid key', () => {
        const ctx = createMockContext('lmc_invalid');
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for revoked key', () => {
        const { key, record } = service.create({ name: 'Revoked' });
        service.revoke(record.id);

        const ctx = createMockContext(key);
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for expired key', () => {
        const { key } = service.create({
            name: 'Expired',
            expiresAt: '2020-01-01T00:00:00Z',
        });

        const ctx = createMockContext(key);
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should allow valid key and attach apiKey to request', () => {
        const { key } = service.create({ name: 'Valid' });
        const ctx = createMockContext(key);

        expect(guard.canActivate(ctx)).toBe(true);

        const request = ctx.switchToHttp().getRequest();
        expect(request.apiKey).toBeDefined();
        expect(request.apiKey.name).toBe('Valid');
    });
});
