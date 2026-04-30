import { Module } from '@nestjs/common';
import { S3ConfigsModule } from '../s3-configs/s3-configs.module.js';
import { SessionsService } from './sessions.service.js';
import { SessionsController } from './sessions.controller.js';
import { AdminSessionsController } from './admin-sessions.controller.js';
import { SessionCleanupService } from './session-cleanup.service.js';
import { SessionEventsService } from './session-events.service.js';
import { HlsParserService } from './hls-parser.service.js';
import { HlsEditClient } from './hls-edit.client.js';
import { S3ClientService } from './s3-client.service.js';

@Module({
    imports: [S3ConfigsModule],
    providers: [
        SessionsService,
        SessionCleanupService,
        SessionEventsService,
        HlsParserService,
        HlsEditClient,
        S3ClientService,
    ],
    controllers: [SessionsController, AdminSessionsController],
    exports: [SessionsService, SessionEventsService],
})
export class SessionsModule {}
