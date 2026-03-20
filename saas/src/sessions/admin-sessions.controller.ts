import {
    Controller,
    Get,
    Param,
    Query,
    Req,
    Sse,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Observable, map } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { SkipAdmin } from '../auth/skip-admin.decorator.js';
import { SessionsService } from './sessions.service.js';
import { SessionEventsService } from './session-events.service.js';

interface MessageEvent {
    data: string | object;
    type?: string;
    id?: string;
    retry?: number;
}

@ApiTags('Admin - Sessions')
@ApiBearerAuth('auth0')
@Controller('saas/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminSessionsController {
    constructor(
        private readonly sessionsService: SessionsService,
        private readonly sessionEvents: SessionEventsService,
    ) {}

    @Get('sessions')
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'skip', required: false, type: Number })
    @ApiQuery({ name: 'status', required: false, type: String })
    @ApiQuery({ name: 'userId', required: false, type: String })
    async listAll(
        @Query('limit') limit?: number,
        @Query('skip') skip?: number,
        @Query('status') status?: string,
        @Query('userId') userId?: string,
    ) {
        return this.sessionsService.listAllSessions({ limit, skip, status, userId });
    }

    @Sse('sessions/events')
    @SkipAdmin()
    streamSessionEvents(
        @Req() req: { user?: { role?: string } },
    ): Observable<MessageEvent> {
        if (req.user?.role !== 'admin') {
            throw new UnauthorizedException('Admin role required');
        }
        return this.sessionEvents.events$.pipe(
            map((event) => ({ data: event })),
        );
    }

    @Get('sessions/:sessionId')
    async detail(@Param('sessionId') sessionId: string) {
        return this.sessionsService.getSessionAdmin(sessionId);
    }

    @Get('users/:userId/sessions')
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'skip', required: false, type: Number })
    @ApiQuery({ name: 'status', required: false, type: String })
    async userSessions(
        @Param('userId') userId: string,
        @Query('limit') limit?: number,
        @Query('skip') skip?: number,
        @Query('status') status?: string,
    ) {
        return this.sessionsService.listAllSessions({ limit, skip, status, userId });
    }
}
