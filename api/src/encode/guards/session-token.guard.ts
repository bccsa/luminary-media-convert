import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService } from '../services/session.service.js';

/**
 * Validates Bearer session token (sess_*) for per-session operations.
 * Does not restrict by session status — that is the controller's responsibility.
 */
@Injectable()
export class SessionTokenGuard implements CanActivate {
    constructor(private readonly sessionService: SessionService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException(
                'Missing or invalid Authorization header. Expected: Bearer <sessionToken>',
            );
        }

        const token = authHeader.slice('Bearer '.length).trim();
        if (!token) {
            throw new UnauthorizedException('Empty bearer token');
        }

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

        (request as any).session = session;
        return true;
    }
}
