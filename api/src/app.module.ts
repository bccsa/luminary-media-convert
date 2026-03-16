import { Module } from '@nestjs/common';
import { EncodeModule } from './encode/encode.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ApiKeyModule } from './apikey/apikey.module.js';

@Module({
    imports: [AuthModule, ApiKeyModule, EncodeModule],
})
export class AppModule {}
