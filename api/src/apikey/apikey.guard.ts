import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService } from './apikey.service.js';

/**
 * Validates X-API-Key header against known API keys.
 * - If the header is present and valid, attaches `request.apiKey` and returns true.
 * - If the header is present but invalid, throws 401.
 * - If the header is absent, returns false (allows the auth chain to fall through).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(private readonly apiKeyService: ApiKeyService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const apiKeyHeader = request.headers['x-api-key'] as string | undefined;

        if (!apiKeyHeader) {
            return false;
        }

        const record = this.apiKeyService.validateKey(apiKeyHeader);
        if (!record) {
            throw new UnauthorizedException('Invalid or expired API key');
        }

        (request as any).apiKey = record;
        return true;
    }
}
