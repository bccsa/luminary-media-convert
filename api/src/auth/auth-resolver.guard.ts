import {
    CanActivate,
    ExecutionContext,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { SessionService } from '../encode/services/session.service.js';
import { AUTH_TYPES_KEY, type AuthType } from './auth-types.decorator.js';
import { LOCAL_API_TOKEN, type LocalApiToken } from './local-auth.config.js';

/**
 * Resolves a caller's credentials, in priority order:
 * instance token -> session token -> read token.
 *
 * Endpoints declare what they accept with `@AuthTypes(...)`, defaulting to
 * `['instance']` — the strictest — so a route that says nothing is not
 * accidentally open to a weaker credential.
 *
 * The instance token is a superkey: it is accepted wherever it appears,
 * whatever the endpoint declared, because the only thing holding it is the
 * app's own UI, which drives everything.
 */
@Injectable()
export class AuthResolverGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly sessionService: SessionService,
        @Inject(LOCAL_API_TOKEN) private readonly instanceToken: LocalApiToken
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const allowedTypes = this.reflector.getAllAndOverride<AuthType[]>(
            AUTH_TYPES_KEY,
            [context.getHandler(), context.getClass()]
        ) ?? ['instance'];

        const request = context.switchToHttp().getRequest<Request>();

        // 1. The instance token, on X-API-Key.
        const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
        if (apiKeyHeader) {
            const instanceToken = this.instanceToken;
            if (
                instanceToken &&
                apiKeyHeader.length === instanceToken.length &&
                timingSafeEqual(
                    Buffer.from(apiKeyHeader),
                    Buffer.from(instanceToken)
                )
            ) {
                (request as any).authType = 'instance';
                return true;
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
                    throw new UnauthorizedException(
                        'Invalid or expired session token'
                    );
                }

                const sessionId = request.params.sessionId;
                if (sessionId && session.id !== sessionId) {
                    throw new UnauthorizedException(
                        'Token does not match the requested session'
                    );
                }

                (request as any).authType = 'session';
                (request as any).session = session;
                return true;
            }
        }

        // 3. Try a read-only token on the query string.
        //
        // Only on endpoints that opt in with @AuthTypes('read'), which is the
        // status endpoint alone. The CMS watches a session from a browser, and
        // the two ways a browser can carry a credential to a URL it does not
        // control the headers of — EventSource and a plain <a> — both mean the
        // query string. It reads status; it cannot start, cancel, or reach the
        // source file, so widening the door this far costs nothing.
        if (allowedTypes.includes('read')) {
            const token = request.query.token;
            if (typeof token === 'string' && token) {
                const session =
                    this.sessionService.getBySessionToken(token) ??
                    this.sessionService.getByReadToken(token);
                const sessionId = request.params.sessionId;
                if (session && (!sessionId || session.id === sessionId)) {
                    (request as any).authType = 'read';
                    (request as any).session = session;
                    return true;
                }
                throw new UnauthorizedException('Invalid or expired token');
            }
        }

        throw new UnauthorizedException(
            'No valid authentication credentials provided'
        );
    }
}
