import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
    imports: [DatabaseModule, AuthModule, UsersModule, SessionsModule],
})
export class AppModule {}
