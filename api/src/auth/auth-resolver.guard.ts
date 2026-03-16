import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiKeyService } from '../apikey/apikey.service.js';
import { SessionService } from '../encode/services/session.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AUTH_TYPES_KEY, type AuthType } from './auth-types.decorator.js';

/**
 * Composite guard that resolves authentication via a priority chain:
 * API Key -> Session Token -> JWT
 *
 * Uses the @AuthTypes() decorator to determine which methods are allowed.
 * Defaults to ['jwt'] if no decorator is present.
 */
@Injectable()
export class AuthResolverGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly apiKeyService: ApiKeyService,
        private readonly sessionService: SessionService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const allowedTypes =
            this.reflector.getAllAndOverride<AuthType[]>(AUTH_TYPES_KEY, [
                context.getHandler(),
                context.getClass(),
            ]) ?? ['jwt'];

        const request = context.switchToHttp().getRequest<Request>();

        // 1. Try API Key
        if (allowedTypes.includes('apikey')) {
            const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
            if (apiKeyHeader) {
                const record = this.apiKeyService.validateKey(apiKeyHeader);
                if (!record) {
                    throw new UnauthorizedException('Invalid or expired API key');
                }
                (request as any).authType = 'apikey';
                (request as any).apiKey = record;
                return true;
            }
        }

        // 2. Try Session Token (Bearer sess_*)
        if (allowedTypes.includes('session')) {
            const authHeader = request.headers.authorization;
            if (authHeader?.startsWith('Bearer sess_')) {
                const token = authHeader.slice('Bearer '.length).trim();
                const session = this.sessionService.getBySessionToken(token);
                if (!session) {
                    throw new UnauthorizedException('Invalid or expired session token');
                }

                const sessionId = request.params.sessionId;
                if (sessionId && session.id !== sessionId) {
                    throw new UnauthorizedException(
                        'Token does not match the requested session',
                    );
                }

                (request as any).authType = 'session';
                (request as any).session = session;
                return true;
            }
        }

        // 3. Try JWT
        if (allowedTypes.includes('jwt')) {
            const jwtGuard = new JwtAuthGuard();
            try {
                const result = await jwtGuard.canActivate(context);
                if (result) {
                    (request as any).authType = 'jwt';
                    return true;
                }
            } catch {
                // JWT validation failed — fall through to final error
            }
        }

        throw new UnauthorizedException(
            'No valid authentication credentials provided',
        );
    }
}
