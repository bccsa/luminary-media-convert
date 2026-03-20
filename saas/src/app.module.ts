import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { MeModule } from './me/me.module.js';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        DatabaseModule,
        AuthModule,
        UsersModule,
        SessionsModule,
        WebhooksModule,
        DashboardModule,
        MeModule,
    ],
})
export class AppModule {}
