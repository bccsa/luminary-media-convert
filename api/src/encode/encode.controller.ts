import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    Req,
    Sse,
    UnauthorizedException,
    UseGuards,
    BadRequestException,
    Logger,
} from '@nestjs/common';

import {
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiSecurity,
    ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
import { AuthorizationWebhookService } from '../auth/authorization-webhook.service.js';
import { SessionService } from './services/session.service.js';
import { SessionEventsService, type SessionEvent } from './services/session-events.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { EncodeConfigDto } from './dto/encode-config.dto.js';
import {
    SessionResponseDto,
    EncodeStartResponseDto,
    SessionStatusDto,
} from './dto/session-response.dto.js';

const DEFAULT_MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB

interface MessageEvent {
    data: string | object;
    type?: string;
    id?: string;
    retry?: number;
}

@ApiTags('Encoding Sessions')
@Controller('api/sessions')
export class EncodeController {
    private readonly logger = new Logger(EncodeController.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly sessionEventsService: SessionEventsService,
        private readonly queueService: QueueService,
        private readonly ffmpegService: FfmpegService,
        private readonly authorizationWebhookService: AuthorizationWebhookService,
    ) {}

    @Post()
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Create an encoding session',
        description:
            'Creates a new encoding session and returns a tus upload endpoint ' +
            'and session token. The client should create a tus upload ' +
            'to the provided endpoint using the Bearer token for authentication.',
    })
    @ApiResponse({
        status: 201,
        description:
            'Session created. Use the returned tusEndpoint and sessionToken to upload your file via the tus protocol.',
        type: SessionResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    async createSession(
        @Body() dto: CreateSessionDto,
        @Req() req: Request,
    ): Promise<SessionResponseDto> {
        const apiKey = (req as any).apiKey;

        await this.authorizationWebhookService.checkAuthorization(
            'create_session',
            { apiKey, dto },
        );

        const session = this.sessionService.create(dto);

        // Bind webhook from API key if no per-session webhook is configured
        if (!dto.webhook && apiKey?.webhookUrl) {
            session.config.webhook = { url: apiKey.webhookUrl, sessionToken: '' };
        }

        const protocol = req.protocol;
        const host = req.get('host');
        const tusEndpoint = `${protocol}://${host}/api/tus`;

        const maxUploadSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_UPLOAD_SIZE;

        return {
            sessionId: session.id,
            tusEndpoint,
            sessionToken: session.sessionToken,
            maxUploadSize,
        };
    }

    @Post(':sessionId/encode')
    @HttpCode(HttpStatus.ACCEPTED)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Start encoding with the given configuration',
        description:
            'Submit the encoding configuration for a previously uploaded file. ' +
            'The session must be in "uploaded" status. The session is queued for encoding.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({
        status: 202,
        description: 'Encoding config accepted and session queued.',
        type: EncodeStartResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: 'Invalid config or session not in uploaded state.',
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async startEncode(
        @Param('sessionId') sessionId: string,
        @Body() dto: EncodeConfigDto,
        @Req() req: Request,
    ): Promise<EncodeStartResponseDto> {
        const apiKey = (req as any).apiKey;

        await this.authorizationWebhookService.checkAuthorization(
            'start_encode',
            { apiKey, sessionId, dto },
        );
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (session.status !== 'uploaded') {
            throw new BadRequestException(
                `Session must be in "uploaded" status to start encoding (current: "${session.status}")`,
            );
        }

        if (dto.type === 'video') {
            if (!dto.videoRenditions?.length) {
                throw new BadRequestException(
                    'Video type requires at least one videoRendition',
                );
            }
            if (!dto.audioGroups?.length) {
                throw new BadRequestException(
                    'Video type requires at least one audioGroup',
                );
            }
            const groupIds = new Set(dto.audioGroups.map((g) => g.id));
            for (const vr of dto.videoRenditions) {
                if (!groupIds.has(vr.audioGroupId)) {
                    throw new BadRequestException(
                        `Video rendition references unknown audioGroupId "${vr.audioGroupId}"`,
                    );
                }
                if (vr.copyStream && vr.sourceTrackIndex == null) {
                    throw new BadRequestException(
                        'copyStream renditions require a sourceTrackIndex',
                    );
                }
            }
        } else {
            if (!dto.audioGroups?.length) {
                throw new BadRequestException(
                    'Audio type requires at least one audioGroup',
                );
            }
        }

        this.sessionService.setEncodeConfig(sessionId, dto);
        const position = this.queueService.enqueue(sessionId);

        this.logger.log(
            `Encoding started for session ${sessionId}, queued at position ${position}`,
        );

        return {
            sessionId,
            status: 'queued',
            queuePosition: position,
        };
    }

    @SkipThrottle()
    @Sse(':sessionId/events')
    @ApiOperation({
        summary: 'Stream session events via SSE',
        description:
            'Server-Sent Events stream for real-time session status updates. ' +
            'Authenticate via `token` query parameter with the session token.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    streamEvents(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string,
    ): Observable<MessageEvent> {
        if (!token) {
            throw new UnauthorizedException('Missing token query parameter');
        }
        const session = this.sessionService.getBySessionToken(token);
        if (!session || session.id !== sessionId) {
            throw new UnauthorizedException('Invalid session token');
        }

        const accelMode = this.ffmpegService.getAccelMode();
        return this.sessionEventsService.forSession(sessionId).pipe(
            map((event) => ({
                data: { ...event, encoder: accelMode },
            })),
        );
    }

    @Get(':sessionId')
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Get session status',
        description:
            'Poll the current status of an encoding session. ' +
            'When status is "uploaded", includes probe results. ' +
            'When status is "encoding", includes progress percentage. ' +
            'When "completed", includes file listing.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({
        status: 200,
        description: 'Current session status.',
        type: SessionStatusDto,
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    getStatus(
        @Param('sessionId') sessionId: string,
        @Req() req: Request,
    ): SessionStatusDto {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        const result: SessionStatusDto = {
            sessionId: session.id,
            status: session.status,
            encoder: this.ffmpegService.getAccelMode(),
        };

        if (session.status === 'uploaded') {
            result.probeResult = session.probeResult as any;
        }

        if (session.status === 'queued') {
            result.queuePosition =
                this.queueService.getPosition(sessionId) ?? undefined;
        }

        if (session.status === 'encoding' || session.status === 'encrypting' || session.status === 'uploading_to_s3') {
            result.progress = session.progress;
        }

        if (session.status === 'completed') {
            result.progress = 100;
            result.files = session.files;
            result.masterPlaylist = session.masterPlaylist;
            result.anglePlaylists = session.anglePlaylists;
            result.thumbnailsVtt = session.thumbnailsVtt;
            result.segmentFormat = session.segmentFormat;
        }

        if (session.status === 'failed') {
            result.error = session.error;
        }

        return result;
    }

    @Delete(':sessionId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Cancel and delete an encoding session',
        description:
            'Deletes a session and cleans up associated resources. ' +
            'Allowed in "created", "uploading", "uploaded", "queued", or "encoding" status. ' +
            'Queued sessions are removed from the queue. Encoding sessions have their FFmpeg process terminated. ' +
            'Sessions in "uploading_to_s3", "completed", or "failed" status cannot be deleted.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({ status: 204, description: 'Session deleted.' })
    @ApiResponse({
        status: 400,
        description: 'Session cannot be deleted in its current state.',
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async deleteSession(@Param('sessionId') sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        const deletableStatuses = ['created', 'uploading', 'uploaded', 'queued', 'encoding'];
        if (!deletableStatuses.includes(session.status)) {
            throw new BadRequestException(
                `Cannot delete session in "${session.status}" status`,
            );
        }

        if (session.status === 'queued') {
            this.queueService.dequeue(sessionId);
        }

        if (session.status === 'encoding') {
            this.ffmpegService.killActiveProcess();
        }

        const workDir =
            process.env.WORK_DIR || join(process.cwd(), 'work');
        const sessionDir = join(workDir, sessionId);
        try {
            await rm(sessionDir, { recursive: true, force: true });
        } catch (err) {
            this.logger.warn(
                `Failed to clean up directory for session ${sessionId}: ${(err as Error).message}`,
            );
        }

        this.sessionService.remove(sessionId);
        this.logger.log(`Session ${sessionId} deleted by client`);
    }
}
