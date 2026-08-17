import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CmsModule } from '../cms/cms.module.js';
import { OriginsController } from '../cms/origins.controller.js';
import { HlsEditModule } from '../hls-edit/hls-edit.module.js';
import { CmsController } from './cms.controller.js';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { SessionEventsService } from './services/session-events.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { S3Service } from './services/s3.service.js';
import { EncodeService } from './services/encode.service.js';
import { EncryptionService } from './services/encryption.service.js';
import { ThumbnailService } from './services/thumbnail.service.js';
import { SessionCleanupService } from './services/session-cleanup.service.js';
import { ProbeService } from './services/probe.service.js';
import { IngestService } from './services/ingest.service.js';
import { SegmentPipelineService } from './services/segment-pipeline.service.js';
import { PreviewService } from './services/preview.service.js';
import { WaveformService } from './services/waveform.service.js';

@Module({
    // HlsEditModule is where chapter read/write lives; it imports this module in
    // turn for SessionService, so both sides are lazy.
    imports: [
        forwardRef(() => AuthModule),
        forwardRef(() => HlsEditModule),
        CmsModule,
    ],
    controllers: [EncodeController, CmsController, OriginsController],
    providers: [
        SessionEventsService,
        SessionService,
        QueueService,
        FfmpegService,
        S3Service,
        EncodeService,
        EncryptionService,
        ThumbnailService,
        SessionCleanupService,
        ProbeService,
        IngestService,
        SegmentPipelineService,
        PreviewService,
        WaveformService,
    ],
    exports: [SessionService, SessionEventsService],
})
export class EncodeModule {}
