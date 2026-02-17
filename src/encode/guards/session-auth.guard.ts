import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService } from '../services/session.service.js';

/**
 * Validates Bearer token for file upload endpoints.
 * Looks up the session by upload token, verifies the session exists
 * and the sessionId in the URL matches. Attaches the session to the request.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
    constructor(private readonly sessionService: SessionService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException(
                'Missing or invalid Authorization header. Expected: Bearer <uploadToken>'
            );
        }

        const token = authHeader.slice('Bearer '.length).trim();
        if (!token) {
            throw new UnauthorizedException('Empty bearer token');
        }

        const session = this.sessionService.getByUploadToken(token);
        if (!session) {
            throw new UnauthorizedException('Invalid or expired upload token');
        }

        const sessionId = request.params.sessionId;
        if (session.id !== sessionId) {
            throw new UnauthorizedException(
                'Token does not match the requested session'
            );
        }

        if (session.status !== 'created') {
            throw new UnauthorizedException(
                `Session is not accepting uploads (current status: ${session.status})`
            );
        }

        (request as any).session = session;
        return true;
    }
}
