import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
    imports: [DatabaseModule, AuthModule, UsersModule],
})
export class AppModule {}
