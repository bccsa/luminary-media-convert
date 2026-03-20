import { Module, forwardRef, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { SessionEventsService } from './services/session-events.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { S3Service } from './services/s3.service.js';
import { WebhookService } from './services/webhook.service.js';
import { EncodeService } from './services/encode.service.js';
import { EncryptionService } from './services/encryption.service.js';
import { ThumbnailService } from './services/thumbnail.service.js';
import { ProbeService } from './services/probe.service.js';
import { TusUploadService } from './services/tus-upload.service.js';
import { AuthorizationWebhookService } from '../auth/authorization-webhook.service.js';

@Module({
    imports: [forwardRef(() => AuthModule)],
    controllers: [EncodeController],
    providers: [
        SessionEventsService,
        SessionService,
        QueueService,
        FfmpegService,
        S3Service,
        WebhookService,
        EncodeService,
        EncryptionService,
        ThumbnailService,
        ProbeService,
        TusUploadService,
        AuthorizationWebhookService,
    ],
    exports: [SessionService, SessionEventsService],
})
export class EncodeModule implements OnModuleInit {
    constructor(
        private readonly httpAdapterHost: HttpAdapterHost,
        private readonly tusService: TusUploadService,
    ) {}

    onModuleInit(): void {
        const app = this.httpAdapterHost.httpAdapter.getInstance();
        const handler = (req: any, res: any) =>
            this.tusService.handle(req, res);
        app.all('/api/tus', handler);
        app.all('/api/tus/{*tusPath}', handler);
    }
}
