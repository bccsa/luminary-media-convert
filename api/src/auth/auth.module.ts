import { Module } from '@nestjs/common';
import { AuthResolverGuard } from './auth-resolver.guard.js';
import { KeyValidationWebhookService } from './key-validation-webhook.service.js';

@Module({
    providers: [AuthResolverGuard, KeyValidationWebhookService],
    exports: [AuthResolverGuard, KeyValidationWebhookService],
})
export class AuthModule {}
