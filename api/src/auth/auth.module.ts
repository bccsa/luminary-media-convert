import { Module, forwardRef } from '@nestjs/common';
import { AuthResolverGuard } from './auth-resolver.guard.js';
import { EncodeModule } from '../encode/encode.module.js';

@Module({
    imports: [forwardRef(() => EncodeModule)],
    providers: [AuthResolverGuard],
    exports: [AuthResolverGuard],
})
export class AuthModule {}
