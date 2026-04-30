import { Module, forwardRef } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IdentityService } from './identity.service.js';
import { AdminGuard } from './admin.guard.js';
import { UsersModule } from '../users/users.module.js';

@Module({
    imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        forwardRef(() => UsersModule),
    ],
    providers: [JwtStrategy, JwtAuthGuard, IdentityService, AdminGuard],
    exports: [JwtAuthGuard, IdentityService, AdminGuard],
})
export class AuthModule {}
