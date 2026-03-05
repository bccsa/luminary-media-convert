import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionService } from '../services/session.service.js';

/**
 * Validates Bearer upload token for preview endpoints.
 * Unlike SessionAuthGuard, does not restrict by session status.
 */
@Injectable()
export class PreviewAuthGuard implements CanActivate {
    constructor(private readonly sessionService: SessionService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        // #region agent log
        fetch('http://127.0.0.1:7561/ingest/2361a5e6-9897-4e19-b9a5-f5e5c2ca8ef5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'4fba38'},body:JSON.stringify({sessionId:'4fba38',location:'preview-auth.guard.ts:canActivate',message:'guard entry',data:{url:request.url,originalUrl:request.originalUrl,hasAuth:!!authHeader,params:request.params},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
        // #endregion

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException(
                'Missing or invalid Authorization header. Expected: Bearer <uploadToken>',
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
                'Token does not match the requested session',
            );
        }

        (request as any).session = session;
        return true;
    }
}
