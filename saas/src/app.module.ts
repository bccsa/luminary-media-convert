import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { S3ConfigsModule } from './s3-configs/s3-configs.module.js';
import { MeModule } from './me/me.module.js';
import { KeysModule } from './keys/keys.module.js';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        CryptoModule,
        DatabaseModule,
        AuthModule,
        UsersModule,
        SessionsModule,
        WebhooksModule,
        DashboardModule,
        S3ConfigsModule,
        MeModule,
        KeysModule,
    ],
})
export class AppModule {}
