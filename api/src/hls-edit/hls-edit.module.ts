import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EncodeModule } from '../encode/encode.module.js';
import { HlsEditController } from './hls-edit.controller.js';
import { HlsEditService } from './hls-edit.service.js';
import { S3EtagService } from './s3-etag.service.js';

@Module({
    // EncodeModule exports SessionService, which AuthResolverGuard depends on
    // (for session-token auth). forwardRef avoids circular dep with AuthModule.
    imports: [forwardRef(() => AuthModule), forwardRef(() => EncodeModule)],
    controllers: [HlsEditController],
    providers: [HlsEditService, S3EtagService],
    exports: [HlsEditService, S3EtagService],
})
export class HlsEditModule {}
