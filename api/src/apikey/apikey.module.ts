import { Module } from '@nestjs/common';
import { ApiKeyService } from './apikey.service.js';
import { ApiKeyController } from './apikey.controller.js';
import { ApiKeyGuard } from './apikey.guard.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';

@Module({
    controllers: [ApiKeyController],
    providers: [ApiKeyService, ApiKeyGuard, RateLimiterService, RateLimitInterceptor],
    exports: [ApiKeyService, ApiKeyGuard, RateLimiterService, RateLimitInterceptor],
})
export class ApiKeyModule {}
