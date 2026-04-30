import { Module, forwardRef } from '@nestjs/common';
import { AuthResolverGuard } from './auth-resolver.guard.js';
import { KeyValidationWebhookService } from './key-validation-webhook.service.js';
import { EncodeModule } from '../encode/encode.module.js';

@Module({
    imports: [forwardRef(() => EncodeModule)],
    providers: [AuthResolverGuard, KeyValidationWebhookService],
    exports: [AuthResolverGuard, KeyValidationWebhookService],
})
export class AuthModule {}
