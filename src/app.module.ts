import { Module } from '@nestjs/common';
import { EncodeModule } from './encode/encode.module.js';

@Module({
    imports: [EncodeModule],
})
export class AppModule {}
