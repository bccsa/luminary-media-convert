import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_ADMIN_KEY } from './skip-admin.decorator.js';

@Injectable()
export class AdminGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ADMIN_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (skip) return true;

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || user.role !== 'admin') {
            throw new ForbiddenException('Admin access required');
        }

        return true;
    }
}
