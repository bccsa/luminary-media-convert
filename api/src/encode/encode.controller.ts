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
    UploadedFile,
    UseGuards,
    UseInterceptors,
    BadRequestException,
    Logger,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UploadCleanupInterceptor } from './interceptors/upload-cleanup.interceptor.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { ProbeService } from './services/probe.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { EncodeConfigDto } from './dto/encode-config.dto.js';
import {
    SessionResponseDto,
    UploadResponseDto,
    EncodeStartResponseDto,
    SessionStatusDto,
} from './dto/session-response.dto.js';

@ApiTags('Encoding Sessions')
@Controller('api/sessions')
export class EncodeController {
    private readonly logger = new Logger(EncodeController.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly queueService: QueueService,
        private readonly probeService: ProbeService,
    ) {}

    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('auth0')
    @ApiOperation({
        summary: 'Create an encoding session',
        description:
            'Creates a new encoding session and returns an upload URL and token. ' +
            'The client should then upload the source media file to the provided URL ' +
            'using the Bearer token for authentication.',
    })
    @ApiResponse({
        status: 201,
        description: 'Session created. Use the returned uploadUrl and uploadToken to upload your file.',
        type: SessionResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({ status: 401, description: 'Unauthorized — invalid or missing Auth0 token.' })
    createSession(
        @Body() dto: CreateSessionDto,
        @Req() req: Request,
    ): SessionResponseDto {
        const session = this.sessionService.create(dto);

        const protocol = req.protocol;
        const host = req.get('host');
        const uploadUrl = `${protocol}://${host}/api/sessions/${session.id}/upload`;

        return {
            sessionId: session.id,
            uploadUrl,
            uploadToken: session.uploadToken,
        };
    }

    @Post(':sessionId/upload')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    @UseInterceptors(
        UploadCleanupInterceptor,
        FileInterceptor('file', {
            storage: diskStorage({
                destination: (req, _file, cb) => {
                    const workDir =
                        process.env.WORK_DIR || join(process.cwd(), 'work');
                    const sessionId = req.params.sessionId;
                    const dir = join(workDir, sessionId);
                    mkdirSync(dir, { recursive: true });
                    cb(null, dir);
                },
                filename: (_req, file, cb) => {
                    cb(null, file.originalname || 'input');
                },
            }),
            limits: { fileSize: 1024 * 1024 * 1024 * 10 },
        }),
    )
    @ApiBearerAuth()
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary: 'Upload source media file',
        description:
            'Upload the source media file for an encoding session. ' +
            'The file is saved and probed using ffprobe. Returns probe results and ' +
            'a suggested encoding configuration. Use POST /api/sessions/:id/encode to start encoding.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiBody({
        description: 'Multipart form data with a single "file" field containing the media file.',
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Source media file (video or audio)',
                },
            },
            required: ['file'],
        },
    })
    @ApiResponse({
        status: 200,
        description: 'File uploaded and probed. Review the probe results and suggested config, then POST to /encode.',
        type: UploadResponseDto,
    })
    @ApiResponse({ status: 400, description: 'No file provided.' })
    @ApiResponse({ status: 401, description: 'Invalid or expired upload token.' })
    uploadFile(
        @Param('sessionId') sessionId: string,
        @UploadedFile() uploaded: any,
    ): UploadResponseDto {
        if (!uploaded || !uploaded.path || uploaded.size === 0) {
            throw new BadRequestException('A non-empty file is required');
        }

        const inputPath = uploaded.path;
        this.sessionService.setFilePath(sessionId, inputPath);

        const probeResult = this.probeService.probe(inputPath);
        const suggestedConfig = this.probeService.suggest(probeResult);

        this.sessionService.setProbeResult(sessionId, probeResult, suggestedConfig);
        this.sessionService.updateStatus(sessionId, 'uploaded');

        this.logger.log(
            `File uploaded and probed for session ${sessionId}: ` +
            `${probeResult.videoTracks.length} video, ${probeResult.audioTracks.length} audio track(s)`,
        );

        return {
            sessionId,
            status: 'uploaded',
            probeResult,
            suggestedConfig,
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
    @ApiResponse({ status: 400, description: 'Invalid config or session not in uploaded state.' })
    @ApiResponse({ status: 401, description: 'Unauthorized — invalid or missing Auth0 token.' })
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
                throw new BadRequestException('Video type requires at least one videoRendition');
            }
            if (!dto.audioGroups?.length) {
                throw new BadRequestException('Video type requires at least one audioGroup');
            }
            const groupIds = new Set(dto.audioGroups.map(g => g.id));
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
                throw new BadRequestException('Audio type requires at least one audioRendition');
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
    @ApiResponse({ status: 401, description: 'Unauthorized — invalid or missing Auth0 token.' })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    getStatus(@Param('sessionId') sessionId: string): SessionStatusDto {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(
                `Session ${sessionId} not found`,
            );
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

        if (session.status === 'encoding') {
            result.progress = session.progress;
        }

        if (session.status === 'completed') {
            result.progress = 100;
            result.files = session.files;
            result.masterPlaylist = session.masterPlaylist;
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
            'Only sessions in "created" or "uploaded" status can be deleted. ' +
            'Sessions that are queued, encoding, or completed cannot be cancelled.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({ status: 204, description: 'Session deleted.' })
    @ApiResponse({ status: 400, description: 'Session cannot be deleted in its current state.' })
    @ApiResponse({ status: 401, description: 'Unauthorized — invalid or missing Auth0 token.' })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    deleteSession(@Param('sessionId') sessionId: string): void {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (session.status !== 'created' && session.status !== 'uploaded') {
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
