import { Module } from '@nestjs/common';
import { EncodeModule } from './encode/encode.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
    imports: [AuthModule, EncodeModule],
})
export class AppModule {}
