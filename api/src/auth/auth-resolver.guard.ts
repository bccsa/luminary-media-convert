import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { KeyValidationWebhookService } from './key-validation-webhook.service.js';
import { SessionService } from '../encode/services/session.service.js';
import { AUTH_TYPES_KEY, type AuthType } from './auth-types.decorator.js';

/**
 * Composite guard that resolves authentication via a priority chain:
 * Master Key -> API Key -> Session Token
 *
 * Uses the @AuthTypes() decorator to determine which methods are allowed.
 * Defaults to ['master'] if no decorator is present.
 *
 * The master key (MASTER_API_KEY env var) is a superkey that is always
 * accepted regardless of the @AuthTypes() decorator on the endpoint.
 */
@Injectable()
export class AuthResolverGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly keyValidationService: KeyValidationWebhookService,
        private readonly sessionService: SessionService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const allowedTypes =
            this.reflector.getAllAndOverride<AuthType[]>(AUTH_TYPES_KEY, [
                context.getHandler(),
                context.getClass(),
            ]) ?? ['master'];

        const request = context.switchToHttp().getRequest<Request>();

        // 1. Try X-API-Key header (master key or regular API key)
        const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
        if (apiKeyHeader) {
            // Check master key first — always accepted (superkey)
            const masterKey = process.env.MASTER_API_KEY;
            if (masterKey && apiKeyHeader === masterKey) {
                (request as any).authType = 'master';
                return true;
            }

            // Check regular API key via webhook
            if (allowedTypes.includes('apikey')) {
                const metadata = await this.keyValidationService.validateKey(apiKeyHeader);
                if (metadata) {
                    (request as any).authType = 'apikey';
                    (request as any).apiKey = metadata;
                    return true;
                }
            }

            // Key was provided but invalid
            throw new UnauthorizedException('Invalid or expired API key');
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

        throw new UnauthorizedException(
            'No valid authentication credentials provided',
        );
    }
}
