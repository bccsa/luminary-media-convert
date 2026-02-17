import {
    Body,
    Controller,
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
    ApiBasicAuth,
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { BasicAuthGuard } from './guards/basic-auth.guard.js';
import { SessionAuthGuard } from './guards/session-auth.guard.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import {
    SessionResponseDto,
    UploadResponseDto,
    SessionStatusDto,
} from './dto/session-response.dto.js';

@ApiTags('Encoding Sessions')
@Controller('api/sessions')
export class EncodeController {
    private readonly logger = new Logger(EncodeController.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');

    constructor(
        private readonly sessionService: SessionService,
        private readonly queueService: QueueService
    ) {}

    @Post()
    @UseGuards(BasicAuthGuard)
    @ApiBasicAuth()
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
    @ApiResponse({ status: 401, description: 'Invalid credentials.' })
    createSession(
        @Body() dto: CreateSessionDto,
        @Req() req: Request
    ): SessionResponseDto {
        // Validate renditions match the encoding type
        if (dto.type === 'video') {
            for (const r of dto.renditions) {
                if (!r.width || !r.height || !r.videoBitrateKbps) {
                    throw new BadRequestException(
                        'Video renditions must include width, height, and videoBitrateKbps'
                    );
                }
            }
        }

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
    @HttpCode(HttpStatus.ACCEPTED)
    @UseGuards(SessionAuthGuard)
    @UseInterceptors(
        FileInterceptor('file', {
            limits: { fileSize: 1024 * 1024 * 1024 * 10 }, // 10GB limit
        })
    )
    @ApiBearerAuth()
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary: 'Upload source media file',
        description:
            'Upload the source media file for an encoding session. ' +
            'The file is accepted and the session is queued for encoding. ' +
            'Use the Bearer token returned from the session creation endpoint.',
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
        status: 202,
        description: 'File accepted and queued for encoding.',
        type: UploadResponseDto,
    })
    @ApiResponse({ status: 400, description: 'No file provided.' })
    @ApiResponse({ status: 401, description: 'Invalid or expired upload token.' })
    async uploadFile(
        @Param('sessionId') sessionId: string,
        @UploadedFile() uploaded: any,
        @Req() req: Request
    ): Promise<UploadResponseDto> {
        if (!uploaded || !uploaded.buffer || uploaded.size === 0) {
            throw new BadRequestException('A non-empty file is required');
        }

        // Save the uploaded file to the work directory
        const sessionDir = join(this.workDir, sessionId);
        if (!existsSync(sessionDir)) {
            mkdirSync(sessionDir, { recursive: true });
        }

        const originalName =
            uploaded.originalname || 'input';
        const inputPath = join(sessionDir, originalName);
        writeFileSync(inputPath, uploaded.buffer);

        this.sessionService.setFilePath(sessionId, inputPath);

        // Enqueue for processing
        const position = this.queueService.enqueue(sessionId);

        this.logger.log(
            `File uploaded for session ${sessionId}, queued at position ${position}`
        );

        return {
            sessionId,
            status: 'queued',
            queuePosition: position,
        };
    }

    @Get(':sessionId')
    @UseGuards(BasicAuthGuard)
    @ApiBasicAuth()
    @ApiOperation({
        summary: 'Get session status',
        description:
            'Poll the current status of an encoding session. ' +
            'Includes progress percentage when encoding, queue position when queued, ' +
            'and file listing when completed.',
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
    @ApiResponse({ status: 401, description: 'Invalid credentials.' })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    getStatus(@Param('sessionId') sessionId: string): SessionStatusDto {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(
                `Session ${sessionId} not found`
            );
        }

        const result: SessionStatusDto = {
            sessionId: session.id,
            status: session.status,
        };

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
}
