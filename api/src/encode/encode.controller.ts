import {
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Query,
    Req,
    Res,
    Sse,
    StreamableFile,
    UnauthorizedException,
    UseGuards,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import type { Response } from 'express';

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
import { createReadStream, existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
import { AuthorizationWebhookService } from '../auth/authorization-webhook.service.js';
import { SessionService } from './services/session.service.js';
import {
    SessionEventsService,
    type SessionEvent,
} from './services/session-events.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { PreviewService } from './services/preview.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { EncodeConfigDto } from './dto/encode-config.dto.js';
import { UrlUploadDto } from './dto/url-upload.dto.js';
import { UrlFetchService } from './services/url-fetch.service.js';
import { WaveformService } from './services/waveform.service.js';
import { ThumbnailService } from './services/thumbnail.service.js';
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
@SkipThrottle()
export class EncodeController {
    private readonly logger = new Logger(EncodeController.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly sessionEventsService: SessionEventsService,
        private readonly queueService: QueueService,
        private readonly ffmpegService: FfmpegService,
        private readonly authorizationWebhookService: AuthorizationWebhookService,
        private readonly previewService: PreviewService,
        private readonly urlFetchService: UrlFetchService,
        private readonly waveformService: WaveformService,
        private readonly thumbnailService: ThumbnailService
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
        @Req() req: Request
    ): Promise<SessionResponseDto> {
        const apiKey = (req as any).apiKey;

        await this.authorizationWebhookService.checkAuthorization(
            'create_session',
            { apiKey, dto }
        );

        const session = this.sessionService.create(dto);

        // Bind webhook from API key if no per-session webhook is configured
        if (!dto.webhook && apiKey?.webhookUrl) {
            session.config.webhook = {
                url: apiKey.webhookUrl,
                sessionToken: '',
            };
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

    @Post(':sessionId/url-upload')
    @HttpCode(HttpStatus.ACCEPTED)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Ingest the source file from an HTTP/S URL',
        description:
            'Alternative to tus upload: the API server fetches the file directly from a public HTTP/S URL ' +
            '(e.g. a Google Drive direct-download link or an S3 presigned URL). ' +
            'Uses parallel HTTP Range requests when the source supports them. ' +
            'The session must be in "created" or "uploading" status. ' +
            'Returns 202 immediately; clients track progress via SSE or polling.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({
        status: 202,
        description: 'URL ingestion started in the background.',
    })
    @ApiResponse({ status: 400, description: 'Invalid URL or session state.' })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async startUrlUpload(
        @Param('sessionId') sessionId: string,
        @Body() dto: UrlUploadDto
    ): Promise<{ sessionId: string; status: 'uploading' }> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (session.status !== 'created' && session.status !== 'uploading') {
            throw new BadRequestException(
                `Session is not accepting uploads (current status: ${session.status})`
            );
        }

        // Kick off the download in the background — return 202 immediately.
        // UrlFetchService handles status transitions and webhook delivery.
        void this.urlFetchService.fetchToSession(
            sessionId,
            dto.url,
            dto.filename
        );

        return { sessionId, status: 'uploading' };
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
        @Req() req: Request
    ): Promise<EncodeStartResponseDto> {
        const apiKey = (req as any).apiKey;

        await this.authorizationWebhookService.checkAuthorization(
            'start_encode',
            { apiKey, sessionId, dto }
        );
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (session.status !== 'uploaded') {
            throw new BadRequestException(
                `Session must be in "uploaded" status to start encoding (current: "${session.status}")`
            );
        }

        if (dto.type === 'video') {
            if (!dto.videoRenditions?.length) {
                throw new BadRequestException(
                    'Video type requires at least one videoRendition'
                );
            }
            if (!dto.audioGroups?.length) {
                throw new BadRequestException(
                    'Video type requires at least one audioGroup'
                );
            }
            const groupIds = new Set(dto.audioGroups.map((g) => g.id));
            for (const vr of dto.videoRenditions) {
                if (!groupIds.has(vr.audioGroupId)) {
                    throw new BadRequestException(
                        `Video rendition references unknown audioGroupId "${vr.audioGroupId}"`
                    );
                }
                if (vr.copyStream && vr.sourceTrackIndex == null) {
                    throw new BadRequestException(
                        'copyStream renditions require a sourceTrackIndex'
                    );
                }
            }
        } else {
            if (!dto.audioGroups?.length) {
                throw new BadRequestException(
                    'Audio type requires at least one audioGroup'
                );
            }
        }

        this.sessionService.setEncodeConfig(sessionId, dto);

        if (dto.trimSegments?.length) {
            this.previewService.setTrimSegments(sessionId, dto.trimSegments);
        }

        const position = this.queueService.enqueue(sessionId);

        this.logger.log(
            `Encoding started for session ${sessionId}, queued at position ${position}`
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
        @Query('token') token: string
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
            }))
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
        @Req() req: Request
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

        if (
            session.probeResult &&
            session.status !== 'created' &&
            session.status !== 'uploading'
        ) {
            result.probeResult = session.probeResult as any;
        }

        // Trim ranges are part of the submitted encode config, so they outlive the
        // client that sent them. Reporting them lets the UI keep showing the output
        // timeline (duration, waveform) after a reload mid-encode.
        if (session.encodeConfig?.trimSegments?.length) {
            result.trimSegments = session.encodeConfig.trimSegments.map((t) => ({
                inSec: t.inSec,
                outSec: t.outSec,
            }));
        }

        if (session.status === 'queued') {
            result.queuePosition =
                this.queueService.getPosition(sessionId) ?? undefined;
        }

        if (session.status === 'uploading') {
            result.progress = session.progress;
            if (session.ingestTotalBytes != null) {
                result.ingestTotalBytes = session.ingestTotalBytes;
            }
        }

        if (
            session.status === 'encoding' ||
            session.status === 'encrypting' ||
            session.status === 'uploading_to_s3'
        ) {
            result.progress = session.progress;
            result.pipelineProgress = session.pipelineProgress;
        }

        if (session.status === 'completed') {
            result.progress = 100;
            result.files = session.files;
            result.masterPlaylist = session.masterPlaylist;
            result.anglePlaylists = session.anglePlaylists;
            result.thumbnailsVtt = session.thumbnailsVtt;
            result.segmentFormat = session.segmentFormat;
            if (session.encryptionKeyHex) {
                result.encryptionKeyHex = session.encryptionKeyHex;
            }
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

        const deletableStatuses = [
            'created',
            'uploading',
            'uploaded',
            'queued',
            'encoding',
        ];
        if (!deletableStatuses.includes(session.status)) {
            throw new BadRequestException(
                `Cannot delete session in "${session.status}" status`
            );
        }

        if (session.status === 'queued') {
            this.queueService.dequeue(sessionId);
        }

        if (session.status === 'uploading') {
            this.urlFetchService.abort(sessionId);
        }

        if (session.status === 'encoding') {
            this.ffmpegService.killActiveProcess();
        }

        const workDir = process.env.WORK_DIR || join(process.cwd(), 'work');
        const sessionDir = join(workDir, sessionId);
        try {
            await rm(sessionDir, { recursive: true, force: true });
        } catch (err) {
            this.logger.warn(
                `Failed to clean up directory for session ${sessionId}: ${(err as Error).message}`
            );
        }

        await this.previewService.destroy(sessionId);
        this.sessionService.remove(sessionId);
        this.logger.log(`Session ${sessionId} deleted by client`);
    }

    @Get(':sessionId/waveform')
    @ApiOperation({
        summary: 'Get audio waveform peaks',
        description:
            'Returns computed waveform peak data for the uploaded source file. ' +
            'The session must be in "uploaded" or later status. ' +
            'Peaks are normalized to 0–1 amplitude values sampled at regular intervals.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({
        status: 200,
        description: 'Waveform peaks data.',
        schema: {
            type: 'object',
            properties: {
                peaks: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Normalized 0–1 amplitude peaks',
                },
                numPeaks: { type: 'number', description: 'Number of peaks' },
            },
        },
    })
    @ApiResponse({
        status: 400,
        description: 'Session source file not yet uploaded.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async getWaveform(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string
    ): Promise<{ peaks: number[]; numPeaks: number }> {
        this.validatePreviewToken(sessionId, token);

        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new BadRequestException('Session not found');
        }

        const filePath = session.filePath;
        if (!filePath) {
            throw new BadRequestException('Source file not yet uploaded');
        }

        try {
            const sidecar = await this.waveformService.getOrComputeCached(
                sessionId,
                { inputPath: filePath },
            );
            return { peaks: sidecar.peaks, numPeaks: sidecar.numPeaks };
        } catch (err) {
            this.logger.error(
                `Failed to generate waveform for session ${sessionId}: ${(err as Error).message}`
            );
            throw new BadRequestException('Failed to generate waveform');
        }
    }

    // -----------------------------------------------------------------------
    // Preview HLS endpoints
    // -----------------------------------------------------------------------

    @Get(':sessionId/preview/audio-tracks')
    @ApiOperation({ summary: 'Get available preview audio tracks' })
    getPreviewAudioTracks(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string
    ): any {
        this.validatePreviewToken(sessionId, token);
        const tracks = this.previewService.getAudioTracks(sessionId);
        if (!tracks) throw new NotFoundException('Preview not ready');
        return tracks;
    }

    @Get(':sessionId/preview/playlist.m3u8')
    @ApiOperation({ summary: 'Get preview HLS master playlist' })
    getPreviewMasterPlaylist(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string,
        @Query('audio') audio: string | undefined,
        @Res() res: Response
    ): void {
        this.validatePreviewToken(sessionId, token);

        const audioTrackIndex =
            audio !== undefined ? parseInt(audio, 10) : undefined;
        const playlist = this.previewService.getPlaylist(
            sessionId,
            token,
            undefined,
            audioTrackIndex
        );
        if (!playlist) throw new NotFoundException('Preview not ready');

        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
        });
        res.send(playlist);
    }

    @Get(':sessionId/preview/r:rendition/playlist.m3u8')
    @ApiOperation({ summary: 'Get preview HLS rendition playlist' })
    getPreviewRenditionPlaylist(
        @Param('sessionId') sessionId: string,
        @Param('rendition') rendition: string,
        @Query('token') token: string,
        @Query('audio') audio: string | undefined,
        @Res() res: Response
    ): void {
        this.validatePreviewToken(sessionId, token);

        const renditionIndex = parseInt(rendition, 10);
        const audioTrackIndex =
            audio !== undefined ? parseInt(audio, 10) : undefined;
        const playlist = this.previewService.getPlaylist(
            sessionId,
            token,
            renditionIndex,
            audioTrackIndex
        );
        if (!playlist) throw new NotFoundException('Rendition not available');

        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
        });
        res.send(playlist);
    }

    @Get(':sessionId/preview/r:rendition/:filename')
    @ApiOperation({ summary: 'Get preview HLS segment' })
    async getPreviewSegment(
        @Param('sessionId') sessionId: string,
        @Param('rendition') rendition: string,
        @Param('filename') filename: string,
        @Query('token') token: string,
        @Query('audio') audio: string | undefined,
        @Res() res: Response
    ): Promise<void> {
        this.validatePreviewToken(sessionId, token);

        const renditionIndex = parseInt(rendition, 10);
        const segMatch = filename.match(/^segment(\d+)\.ts$/);
        if (!segMatch) throw new NotFoundException('Invalid segment filename');

        const segmentIndex = parseInt(segMatch[1], 10);
        const audioTrackIndex =
            audio !== undefined ? parseInt(audio, 10) : undefined;
        const result = await this.previewService.getSegmentStream(
            sessionId,
            renditionIndex,
            segmentIndex,
            audioTrackIndex
        );

        if (!result) throw new NotFoundException('Segment not available');

        res.set({
            'Content-Type': 'video/mp2t',
            'Content-Length': String(result.size),
            'Cache-Control': 'public, max-age=3600',
        });
        result.stream.pipe(res);
    }

    @Get(':sessionId/thumbnails/thumbnails.vtt')
    @SkipThrottle()
    @ApiOperation({
        summary: 'Get the storyboard for the uploaded source',
        description:
            'WebVTT storyboard generated from the source file before any encode, so ' +
            'the trim timeline can show frames while the user is still choosing what ' +
            'to keep. Generated on first request and cached for the session; sprite ' +
            'references are absolute so they carry the session token.',
    })
    @ApiResponse({ status: 200, description: 'WebVTT storyboard.' })
    @ApiResponse({ status: 404, description: 'No storyboard available.' })
    async getPreviewThumbnailVtt(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string,
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        this.validatePreviewToken(sessionId, token);

        const session = this.sessionService.get(sessionId);
        if (!session?.filePath) {
            throw new NotFoundException('Source file not yet uploaded');
        }

        const video = session.probeResult?.videoTracks?.[0];
        const duration = session.probeResult?.format?.duration ?? 0;
        if (!video?.width || !video?.height || duration <= 0) {
            throw new NotFoundException('Source has no usable video track');
        }

        const result = await this.thumbnailService.getOrGeneratePreview(
            sessionId,
            {
                inputPath: session.filePath,
                duration,
                sourceWidth: video.width,
                sourceHeight: video.height,
            },
        );
        if (!result) throw new NotFoundException('Storyboard unavailable');

        // Cues carry bare filenames; a client resolving them against the VTT URL
        // would drop the token and be turned away. Point them at the sprite route
        // outright instead.
        const base = `${req.protocol}://${req.get('host')}/api/sessions/${sessionId}/thumbnails`;
        const vtt = result.vtt.replace(
            /^(sprite_\d+\.\w+)(#.*)?$/gm,
            (_m, file: string, frag = '') =>
                `${base}/${file}?token=${encodeURIComponent(token)}${frag}`,
        );

        res.set({
            'Content-Type': 'text/vtt',
            'Cache-Control': 'private, max-age=300',
            // The web client is served under COEP credentialless, which refuses
            // cross-origin subresources unless they say they may be embedded.
            // Helmet's default of same-origin would have the browser drop this.
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        res.send(vtt);
    }

    @Get(':sessionId/thumbnails/:filename')
    @SkipThrottle()
    @ApiOperation({ summary: 'Get a storyboard sprite sheet for the source' })
    @ApiResponse({ status: 200, description: 'Sprite sheet image.' })
    @ApiResponse({ status: 404, description: 'Sprite not found.' })
    async getPreviewThumbnailSprite(
        @Param('sessionId') sessionId: string,
        @Param('filename') filename: string,
        @Query('token') token: string,
        @Res() res: Response,
    ): Promise<void> {
        this.validatePreviewToken(sessionId, token);

        // Only ever the files this service produces: the name is part of a path,
        // so anything else could walk out of the directory.
        const match = filename.match(/^sprite_\d+\.(webp|jpg|jpeg|png)$/);
        if (!match) throw new NotFoundException('Invalid sprite filename');

        const path = join(
            this.thumbnailService.previewDir(sessionId),
            'thumbnails',
            filename,
        );
        if (!existsSync(path)) throw new NotFoundException('Sprite not found');

        // `jpg` is not a media type — and the API sends X-Content-Type-Options:
        // nosniff, so the browser will not correct it for us.
        const mediaType = match[1] === 'jpg' ? 'jpeg' : match[1];

        res.set({
            'Content-Type': `image/${mediaType}`,
            'Cache-Control': 'private, max-age=3600',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        createReadStream(path).pipe(res);
    }

    private validatePreviewToken(sessionId: string, token: string): void {
        if (!token) {
            throw new UnauthorizedException('Missing token query parameter');
        }
        const session = this.sessionService.getBySessionToken(token);
        if (!session || session.id !== sessionId) {
            throw new UnauthorizedException('Invalid session token');
        }
    }
}
