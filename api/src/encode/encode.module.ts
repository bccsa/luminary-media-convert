import { Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { S3Service } from './services/s3.service.js';
import { WebhookService } from './services/webhook.service.js';
import { EncodeService } from './services/encode.service.js';
import { ProbeService } from './services/probe.service.js';
import { TusUploadService } from './services/tus-upload.service.js';

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
        TusUploadService,
    ],
    exports: [SessionService],
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
