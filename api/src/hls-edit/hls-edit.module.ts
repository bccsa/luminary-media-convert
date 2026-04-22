import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HlsEditController } from './hls-edit.controller.js';
import { HlsEditService } from './hls-edit.service.js';
import { S3EtagService } from './s3-etag.service.js';

@Module({
    imports: [forwardRef(() => AuthModule)],
    controllers: [HlsEditController],
    providers: [HlsEditService, S3EtagService],
    exports: [HlsEditService, S3EtagService],
})
export class HlsEditModule {}
