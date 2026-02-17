import { Module } from '@nestjs/common';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { S3Service } from './services/s3.service.js';
import { WebhookService } from './services/webhook.service.js';
import { EncodeService } from './services/encode.service.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';

@Module({
    controllers: [EncodeController],
    providers: [
        SessionService,
        QueueService,
        FfmpegService,
        S3Service,
        WebhookService,
        EncodeService,
        SessionAuthGuard,
    ],
    exports: [SessionService],
})
export class EncodeModule {}
