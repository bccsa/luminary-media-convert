import {
    Injectable,
    type NestInterceptor,
    type ExecutionContext,
    type CallHandler,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { RateLimiterService } from './rate-limiter.service.js';

/**
 * NestJS interceptor that enforces rate limits for API-key-authenticated requests.
 * Sets standard rate-limit headers on every API-key response.
 * Returns 429 when the limit is exceeded.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
    constructor(private readonly rateLimiter: RateLimiterService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest<Request>();
        const response = context.switchToHttp().getResponse<Response>();

        if ((request as any).authType !== 'apikey') {
            return next.handle();
        }

        const apiKey = (request as any).apiKey;
        if (!apiKey?.id) {
            return next.handle();
        }

        const result = this.rateLimiter.check(apiKey.id);

        response.setHeader('X-RateLimit-Limit', String(result.limit));
        response.setHeader('X-RateLimit-Remaining', String(result.remaining));
        response.setHeader(
            'X-RateLimit-Reset',
            String(Math.ceil(result.resetAt.getTime() / 1000)),
        );

        if (!result.allowed) {
            throw new HttpException(
                {
                    statusCode: HttpStatus.TOO_MANY_REQUESTS,
                    message: 'Rate limit exceeded',
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        return next.handle();
    }
}
