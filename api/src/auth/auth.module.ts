import { Module, forwardRef } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthResolverGuard } from './auth-resolver.guard.js';
import { ApiKeyModule } from '../apikey/apikey.module.js';

@Module({
    imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        forwardRef(() => ApiKeyModule),
    ],
    providers: [JwtStrategy, JwtAuthGuard, AuthResolverGuard],
    exports: [JwtAuthGuard, AuthResolverGuard],
})
export class AuthModule {}
