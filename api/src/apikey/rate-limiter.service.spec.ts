import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
    let service: RateLimiterService;

    beforeEach(() => {
        service = new RateLimiterService();
        delete process.env.API_KEY_RATE_LIMIT;
    });

    afterEach(() => {
        delete process.env.API_KEY_RATE_LIMIT;
    });

    it('should allow requests within the limit', () => {
        const result = service.check('key-1');

        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(100);
        expect(result.remaining).toBe(99);
    });

    it('should use API_KEY_RATE_LIMIT env var', () => {
        process.env.API_KEY_RATE_LIMIT = '5';

        const result = service.check('key-1');

        expect(result.limit).toBe(5);
        expect(result.remaining).toBe(4);
    });

    it('should deny when limit is exceeded', () => {
        process.env.API_KEY_RATE_LIMIT = '3';

        service.check('key-1');
        service.check('key-1');
        service.check('key-1');
        const result = service.check('key-1');

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
    });

    it('should track keys independently', () => {
        process.env.API_KEY_RATE_LIMIT = '2';

        service.check('key-1');
        service.check('key-1');

        const result1 = service.check('key-1');
        const result2 = service.check('key-2');

        expect(result1.allowed).toBe(false);
        expect(result2.allowed).toBe(true);
    });

    it('should return a resetAt date in the future', () => {
        const before = Date.now();
        const result = service.check('key-1');

        expect(result.resetAt.getTime()).toBeGreaterThan(before);
    });

    it('should allow requests after window expires', () => {
        process.env.API_KEY_RATE_LIMIT = '1';

        service.check('key-1');

        // Simulate window expiry by manipulating timestamps
        const entry = (service as any).windows.get('key-1');
        entry.timestamps = [Date.now() - 120_000]; // 2 minutes ago

        const result = service.check('key-1');
        expect(result.allowed).toBe(true);
    });
});
