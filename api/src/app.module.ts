import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { EncodeModule } from './encode/encode.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
    imports: [
        AuthModule,
        EncodeModule,
        ThrottlerModule.forRoot({
            throttlers: [
                { name: 'short', ttl: 1000, limit: 100 },
                { name: 'medium', ttl: 60000, limit: 1000 },
            ],
        }),
    ],
    providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
    ],
})
export class AppModule {}
