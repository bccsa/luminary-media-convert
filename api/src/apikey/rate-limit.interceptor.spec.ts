import { HttpException, HttpStatus } from '@nestjs/common';
import { of } from 'rxjs';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { RateLimiterService } from './rate-limiter.service';

function createMockContext(
    authType?: string,
    apiKey?: { id: string },
): { context: any; response: any } {
    const request: any = {};
    if (authType) request.authType = authType;
    if (apiKey) request.apiKey = apiKey;

    const response = {
        setHeader: vi.fn(),
    };

    return {
        context: {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => response,
            }),
        },
        response,
    };
}

function createMockCallHandler() {
    return {
        handle: vi.fn().mockReturnValue(of('result')),
    };
}

describe('RateLimitInterceptor', () => {
    let interceptor: RateLimitInterceptor;
    let rateLimiter: RateLimiterService;

    beforeEach(() => {
        rateLimiter = new RateLimiterService();
        interceptor = new RateLimitInterceptor(rateLimiter);
        delete process.env.API_KEY_RATE_LIMIT;
    });

    afterEach(() => {
        delete process.env.API_KEY_RATE_LIMIT;
    });

    it('should pass through for non-apikey auth types', () => {
        const { context } = createMockContext('jwt');
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler);

        expect(handler.handle).toHaveBeenCalled();
    });

    it('should pass through when no authType is set', () => {
        const { context } = createMockContext();
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler);

        expect(handler.handle).toHaveBeenCalled();
    });

    it('should set rate limit headers for apikey auth', () => {
        const { context, response } = createMockContext('apikey', { id: 'key-1' });
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler);

        expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
        expect(response.setHeader).toHaveBeenCalledWith(
            'X-RateLimit-Remaining',
            expect.any(String),
        );
        expect(response.setHeader).toHaveBeenCalledWith(
            'X-RateLimit-Reset',
            expect.any(String),
        );
    });

    it('should throw 429 when rate limit is exceeded', () => {
        process.env.API_KEY_RATE_LIMIT = '1';

        const { context: ctx1 } = createMockContext('apikey', { id: 'key-1' });
        interceptor.intercept(ctx1, createMockCallHandler());

        const { context: ctx2 } = createMockContext('apikey', { id: 'key-1' });
        expect(() => interceptor.intercept(ctx2, createMockCallHandler())).toThrow(
            HttpException,
        );

        try {
            const { context: ctx3 } = createMockContext('apikey', { id: 'key-1' });
            interceptor.intercept(ctx3, createMockCallHandler());
        } catch (e) {
            expect((e as HttpException).getStatus()).toBe(
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }
    });

    it('should allow requests from different keys independently', () => {
        process.env.API_KEY_RATE_LIMIT = '1';

        const { context: ctx1 } = createMockContext('apikey', { id: 'key-1' });
        interceptor.intercept(ctx1, createMockCallHandler());

        const { context: ctx2 } = createMockContext('apikey', { id: 'key-2' });
        const handler = createMockCallHandler();

        expect(() => interceptor.intercept(ctx2, handler)).not.toThrow();
        expect(handler.handle).toHaveBeenCalled();
    });
});
