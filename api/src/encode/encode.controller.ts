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
    Req,
    UseGuards,
    BadRequestException,
    Logger,
} from '@nestjs/common';

import {
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { rmSync } from 'fs';
import { join } from 'path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { EncodeConfigDto } from './dto/encode-config.dto.js';
import {
    SessionResponseDto,
    EncodeStartResponseDto,
    SessionStatusDto,
} from './dto/session-response.dto.js';

const DEFAULT_MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB

@ApiTags('Encoding Sessions')
@Controller('api/sessions')
export class EncodeController {
    private readonly logger = new Logger(EncodeController.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly queueService: QueueService,
    ) {}

    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('auth0')
    @ApiOperation({
        summary: 'Create an encoding session',
        description:
            'Creates a new encoding session and returns a tus upload endpoint ' +
            'and upload token. The client should create a tus upload ' +
            'to the provided endpoint using the Bearer token for authentication.',
    })
    @ApiResponse({
        status: 201,
        description:
            'Session created. Use the returned tusEndpoint and uploadToken to upload your file via the tus protocol.',
        type: SessionResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing Auth0 token.',
    })
    createSession(
        @Body() dto: CreateSessionDto,
        @Req() req: Request,
    ): SessionResponseDto {
        const session = this.sessionService.create(dto);

        const protocol = req.protocol;
        const host = req.get('host');
        const tusEndpoint = `${protocol}://${host}/api/tus`;

        const maxUploadSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_UPLOAD_SIZE;

        return {
            sessionId: session.id,
            tusEndpoint,
            uploadToken: session.uploadToken,
            maxUploadSize,
        };
    }

    @Post(':sessionId/encode')
    @HttpCode(HttpStatus.ACCEPTED)
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('auth0')
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
        description: 'Unauthorized — invalid or missing Auth0 token.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    startEncode(
        @Param('sessionId') sessionId: string,
        @Body() dto: EncodeConfigDto,
    ): EncodeStartResponseDto {
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
            if (!dto.audioRenditions?.length) {
                throw new BadRequestException(
                    'Audio type requires at least one audioRendition',
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

    @Get(':sessionId')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('auth0')
    @ApiOperation({
        summary: 'Get session status',
        description:
            'Poll the current status of an encoding session. ' +
            'When status is "uploaded", includes probe results and suggested config. ' +
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
        description: 'Unauthorized — invalid or missing Auth0 token.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    getStatus(@Param('sessionId') sessionId: string): SessionStatusDto {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        const result: SessionStatusDto = {
            sessionId: session.id,
            status: session.status,
        };

        if (session.status === 'uploaded') {
            result.probeResult = session.probeResult as any;
            result.suggestedConfig = session.suggestedConfig;
        }

        if (session.status === 'queued') {
            result.queuePosition =
                this.queueService.getPosition(sessionId) ?? undefined;
        }

        if (session.status === 'encoding' || session.status === 'uploading_to_s3') {
            result.progress = session.progress;
        }

        if (session.status === 'completed') {
            result.progress = 100;
            result.files = session.files;
            result.masterPlaylist = session.masterPlaylist;
            result.anglePlaylists = session.anglePlaylists;
        }

        if (session.status === 'failed') {
            result.error = session.error;
        }

        return result;
    }

    @Delete(':sessionId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('auth0')
    @ApiOperation({
        summary: 'Cancel and delete an encoding session',
        description:
            'Deletes a session and its uploaded file from disk. ' +
            'Only sessions in "created", "uploading", or "uploaded" status can be deleted. ' +
            'Sessions that are queued, encoding, or completed cannot be cancelled.',
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
        description: 'Unauthorized — invalid or missing Auth0 token.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    deleteSession(@Param('sessionId') sessionId: string): void {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (
            session.status !== 'created' &&
            session.status !== 'uploading' &&
            session.status !== 'uploaded'
        ) {
            throw new BadRequestException(
                `Cannot delete session in "${session.status}" status`,
            );
        }

        const workDir =
            process.env.WORK_DIR || join(process.cwd(), 'work');
        const sessionDir = join(workDir, sessionId);
        try {
            rmSync(sessionDir, { recursive: true, force: true });
        } catch (err) {
            this.logger.warn(
                `Failed to clean up directory for session ${sessionId}: ${(err as Error).message}`,
            );
        }

        this.sessionService.remove(sessionId);
        this.logger.log(`Session ${sessionId} deleted by client`);
    }
}
