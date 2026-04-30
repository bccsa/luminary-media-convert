import { Module, forwardRef } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { UsersModule } from '../users/users.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { KeysModule } from '../keys/keys.module.js';

@Module({
    imports: [UsersModule, forwardRef(() => SessionsModule), KeysModule],
    controllers: [WebhooksController],
    providers: [WebhooksService],
})
export class WebhooksModule {}
