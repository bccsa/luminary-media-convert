import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
    Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class BasicAuthGuard implements CanActivate {
    private readonly logger = new Logger(BasicAuthGuard.name);
    private readonly username = process.env.AUTH_USERNAME ?? '';
    private readonly password = process.env.AUTH_PASSWORD ?? '';

    canActivate(context: ExecutionContext): boolean {
        if (!this.username || !this.password) {
            this.logger.error(
                'AUTH_USERNAME and AUTH_PASSWORD environment variables must be set'
            );
            throw new UnauthorizedException('Server auth not configured');
        }

        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Basic ')) {
            throw new UnauthorizedException(
                'Missing or invalid Authorization header. Expected: Basic <base64(username:password)>'
            );
        }

        const base64 = authHeader.slice('Basic '.length);
        let decoded: string;
        try {
            decoded = Buffer.from(base64, 'base64').toString('utf-8');
        } catch {
            throw new UnauthorizedException('Malformed base64 in Authorization header');
        }

        const separatorIdx = decoded.indexOf(':');
        if (separatorIdx === -1) {
            throw new UnauthorizedException('Invalid Basic auth format. Expected base64(username:password)');
        }

        const user = decoded.slice(0, separatorIdx);
        const pass = decoded.slice(separatorIdx + 1);

        if (user !== this.username || pass !== this.password) {
            throw new UnauthorizedException('Invalid credentials');
        }

        return true;
    }
}
