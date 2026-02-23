import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { S3Service } from './services/s3.service.js';
import { WebhookService } from './services/webhook.service.js';
import { EncodeService } from './services/encode.service.js';
import { ProbeService } from './services/probe.service.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { UploadTimeoutMiddleware } from './middleware/upload-timeout.middleware.js';

@Module({
    controllers: [EncodeController],
    providers: [
        SessionService,
        QueueService,
        FfmpegService,
        S3Service,
        WebhookService,
        EncodeService,
        ProbeService,
        SessionAuthGuard,
    ],
    exports: [SessionService],
})
export class EncodeModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer
            .apply(UploadTimeoutMiddleware)
            .forRoutes({
                path: 'api/sessions/:sessionId/upload',
                method: RequestMethod.POST,
            });
    }
}
