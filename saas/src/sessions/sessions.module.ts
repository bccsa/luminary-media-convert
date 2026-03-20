import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';
import { SessionsController } from './sessions.controller.js';
import { AdminSessionsController } from './admin-sessions.controller.js';
import { SessionCleanupService } from './session-cleanup.service.js';
import { SessionEventsService } from './session-events.service.js';

@Module({
    providers: [SessionsService, SessionCleanupService, SessionEventsService],
    controllers: [SessionsController, AdminSessionsController],
    exports: [SessionsService, SessionEventsService],
})
export class SessionsModule {}
