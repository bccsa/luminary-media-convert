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
    Put,
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
import { rm, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
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
import { LocalFileDto } from './dto/local-file.dto.js';
import { ChaptersWriteDto } from './dto/chapters.dto.js';
import { hasAllowedExtension } from './services/media-extensions.js';
import { IngestService } from './services/ingest.service.js';
import { S3Service } from './services/s3.service.js';
import { HlsEditService } from '../hls-edit/hls-edit.service.js';
import { WaveformService } from './services/waveform.service.js';
import {
    selectStoryboardTrack,
    ThumbnailService,
} from './services/thumbnail.service.js';
import {
    SessionResponseDto,
    EncodeStartResponseDto,
    SessionKeyResponseDto,
    SessionStatusDto,
    SessionSummaryDto,
} from './dto/session-response.dto.js';
import { maskKeyHex } from './services/key-mask.js';

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
        private readonly previewService: PreviewService,
        private readonly ingestService: IngestService,
        private readonly hlsEditService: HlsEditService,
        private readonly waveformService: WaveformService,
        private readonly thumbnailService: ThumbnailService
    ) {}

    @Post()
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Create an encoding session',
        description:
            'Creates a new encoding session and returns a session token. ' +
            'The client uses that token as a Bearer credential for the ' +
            'session-scoped endpoints that follow.',
    })
    @ApiResponse({
        status: 201,
        description:
            'Session created. Use the returned sessionToken to authenticate the session-scoped endpoints.',
        type: SessionResponseDto,
    })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    async createSession(
        @Body() dto: CreateSessionDto
    ): Promise<SessionResponseDto> {
        const session = this.sessionService.create(dto);

        return {
            sessionId: session.id,
            sessionToken: session.sessionToken,
        };
    }

    @Get()
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'List every session on this instance',
        description:
            'For the local UI, which is the only thing holding the instance token. ' +
            'Includes each session token so the UI can reach the session-scoped ' +
            'preview and waveform routes without having kept one from creation. ' +
            'Newest first.',
    })
    @ApiResponse({ status: 200, type: SessionSummaryDto, isArray: true })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    listSessions(): SessionSummaryDto[] {
        return this.sessionService.list().map((session) => ({
            sessionId: session.id,
            title: session.title,
            status: session.status,
            progress: session.progress,
            createdAt: session.createdAt,
            sessionToken: session.sessionToken,
            hlsUrl: session.hlsUrl,
            error: session.error,
        }));
    }

    @Post(':sessionId/local-file')
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Attach a file already on this machine to the session',
        description:
            'The source is used where it is — never copied and never moved, so a ' +
            'multi-gigabyte pick costs no disk and no wait. The file belongs to ' +
            'the user throughout: nothing here writes to it or removes it, ' +
            'including on failure. Returns once the file has been probed.',
    })
    @ApiParam({
        name: 'sessionId',
        description: 'Session ID returned from POST /api/sessions',
    })
    @ApiResponse({
        status: 201,
        description: 'Source attached and probed.',
        type: SessionStatusDto,
    })
    @ApiResponse({
        status: 400,
        description:
            'Path is missing, not a file, not a media file, or the session is past "created".',
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async attachLocalFile(
        @Param('sessionId') sessionId: string,
        @Body() dto: LocalFileDto,
        @Req() req: Request
    ): Promise<SessionStatusDto> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        if (session.status !== 'created') {
            throw new BadRequestException(
                `Session is not accepting a source file (current status: ${session.status})`
            );
        }

        // A relative path would resolve against the encoder's working directory,
        // which is not where the user was standing when they picked the file.
        if (!isAbsolute(dto.path)) {
            throw new BadRequestException('path must be absolute');
        }

        let stats;
        try {
            stats = await stat(dto.path);
        } catch {
            throw new BadRequestException(`No file at ${dto.path}`);
        }
        if (!stats.isFile()) {
            throw new BadRequestException(`${dto.path} is not a regular file`);
        }

        if (!hasAllowedExtension(dto.path)) {
            throw new BadRequestException(
                'Unsupported file type — pick an audio or video file'
            );
        }

        this.sessionService.updateStatus(sessionId, 'uploading');

        try {
            await this.ingestService.finalizeUpload(sessionId, dto.path);
        } catch (err) {
            const message = (err as Error).message || 'Could not read the file';
            this.logger.error(
                `Local file ingest failed for session ${sessionId}: ${message}`
            );
            // Only the session is marked failed. The user's file is theirs; a
            // probe that could not read it is no reason to touch it.
            this.sessionService.setFailed(sessionId, message);
            throw new BadRequestException(message);
        }

        return this.getStatus(sessionId, req);
    }

    @Post(':sessionId/encode')
    @HttpCode(HttpStatus.ACCEPTED)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance', 'session')
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
        @Body() dto: EncodeConfigDto
    ): Promise<EncodeStartResponseDto> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }

        // A session restored without its credentials kept its destination but
        // not the keys to write there; its config holds placeholders. Encoding
        // it would burn the whole encode and fail at the upload with an S3
        // authentication error nobody could trace back to a restart.
        if (!this.sessionService.hasUsableCredentials(session)) {
            throw new BadRequestException(
                'The storage credentials for this session are no longer available — ' +
                    'create the session again from the CMS'
            );
        }

        // A failed encode is worth retrying when its source survived. Every
        // failure seen in practice — a full disk, a stalled upload, a restart —
        // left the uploaded file untouched, and refusing anything but "uploaded"
        // meant a valid multi-GB source could only be used by deleting the
        // session and uploading it again.
        const canRetry =
            session.status === 'failed' &&
            !!session.filePath &&
            existsSync(session.filePath);

        if (session.status !== 'uploaded' && !canRetry) {
            const reason =
                session.status === 'failed'
                    ? `the source file for session ${sessionId} is no longer on disk, so it must be uploaded again`
                    : `Session must be in "uploaded" status to start encoding (current: "${session.status}")`;
            throw new BadRequestException(reason);
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
            'Authenticate via the `token` query parameter, with either the session ' +
            'token or the read token — EventSource cannot set headers.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    streamEvents(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string
    ): Observable<MessageEvent> {
        if (!token) {
            throw new UnauthorizedException('Missing token query parameter');
        }
        // The read token is watching-only, and watching is all this endpoint
        // does — it is how the CMS follows an encode it opened but does not run.
        const session =
            this.sessionService.getBySessionToken(token) ??
            this.sessionService.getByReadToken(token);
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
    @AuthTypes('instance', 'session', 'read')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Get session status',
        description:
            'Poll the current status of an encoding session. ' +
            'When status is "uploaded", includes probe results. ' +
            'When status is "encoding", includes progress percentage. ' +
            'When "completed", includes file listing. ' +
            'Accepts the instance token, the session Bearer token, or either the ' +
            'session or read token as a `token` query parameter.',
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
            title: session.title,
            documentId: session.documentId,
        };

        // Known from the moment encoding starts, not from completion: a caller
        // that reconnects mid-encode has to be able to ask for it again. The
        // decryption key is no longer part of this payload — it is fetched
        // separately from GET /api/sessions/:sessionId/key.
        if (session.hlsUrl) result.hlsUrl = session.hlsUrl;

        if (
            session.probeResult &&
            session.status !== 'created' &&
            session.status !== 'uploading'
        ) {
            result.probeResult = session.probeResult as any;
        }

        // Decided at session creation and not editable afterwards, so the client
        // has no other way to learn it. The encode config form was assuming the
        // API default, which is right until a CMS asks for anything else.
        result.byteRange = session.config?.byteRange !== false;

        // Trim ranges are part of the submitted encode config, so they outlive the
        // client that sent them. Reporting them lets the UI keep showing the output
        // timeline (duration, waveform) after a reload mid-encode.
        if (session.encodeConfig?.trimSegments?.length) {
            result.trimSegments = session.encodeConfig.trimSegments.map(
                (t) => ({
                    inSec: t.inSec,
                    outSec: t.outSec,
                })
            );
        }

        // A failed encode can be run again while its source is still on disk and
        // the credentials for its destination are still in hand. The client can
        // see neither the encoder's filesystem nor its keychain, so it is told
        // here rather than left to guess from the status alone.
        if (
            session.status === 'failed' &&
            !!session.filePath &&
            existsSync(session.filePath) &&
            this.sessionService.hasUsableCredentials(session)
        ) {
            result.canRetry = true;
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
            result.thumbnailsVtt = session.thumbnailsVtt;
            result.segmentFormat = session.segmentFormat;
        }

        if (session.status === 'failed') {
            result.error = session.error;
        }

        return result;
    }

    @Get(':sessionId/key')
    @UseGuards(AuthResolverGuard)
    // 'read' matches the SSE events endpoint: a viewer holding a read token can
    // already stream the session's status, and it needs the key to play back
    // encrypted output (cms-mock's playback check does exactly this).
    @AuthTypes('instance', 'session', 'read')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Get the masked AES-128 key for this session',
        description:
            'Returns the session key XOR-masked with the first 16 bytes of ' +
            'SHA-256(sessionId). Unmask by repeating the XOR — the operation is ' +
            'its own inverse, and the formula is published deliberately.\n\n' +
            'This is an obscurity measure, not DRM. The key used to ride along ' +
            'on every status read and SSE frame, which put it in logs, proxies ' +
            'and screenshots; behind its own endpoint and behind the mask, a ' +
            'raw key never appears in a payload that gets copied around. ' +
            'Anyone able to play the media can still recover it — the player ' +
            'needs the key in the clear to decrypt segments.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({
        status: 200,
        description: 'Masked session key.',
        type: SessionKeyResponseDto,
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized — invalid or missing credentials.',
    })
    @ApiResponse({
        status: 404,
        description: 'Session not found, or the session has no encryption key.',
    })
    getSessionKey(
        @Param('sessionId') sessionId: string
    ): SessionKeyResponseDto {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }
        // A session encoding without encryption has no key at all — that is a
        // missing resource, not an empty one, so the client can tell the two
        // apart without inspecting the body.
        if (!session.encryptionKeyHex) {
            throw new NotFoundException('Session has no encryption key');
        }
        return {
            maskedKeyHex: maskKeyHex(sessionId, session.encryptionKeyHex),
        };
    }

    @Delete(':sessionId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Cancel and delete an encoding session',
        description:
            'Deletes a session and cleans up associated resources. Allowed in ' +
            '"created", "uploading", "uploaded", "queued", "encoding", "failed" ' +
            'and "completed" — the terminal two included, which is the only way ' +
            'their disk is ever reclaimed. Queued sessions are removed from the ' +
            'queue; encoding sessions have their FFmpeg process terminated. ' +
            'Refused in "encrypting" and "uploading_to_s3": the pipeline is ' +
            'mid-write, and pulling its files out from under it leaves half an ' +
            'output in the bucket.',
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

        // Finished sessions are deletable too — that is the only way their disk
        // is ever reclaimed. Excluding them meant the work directory of a failed
        // session, source file and all, could not be removed through the product
        // at any point in its life; on staging that was several GB per attempt,
        // on a volume that filled and took the next encode down with it.
        //
        // uploading_to_s3 stays excluded: the pipeline is mid-write, and pulling
        // its files out from under it leaves half an output in the bucket.
        const deletableStatuses = [
            'created',
            'uploading',
            'uploaded',
            'queued',
            'encoding',
            'failed',
            'completed',
        ];
        if (!deletableStatuses.includes(session.status)) {
            throw new BadRequestException(
                `Cannot delete session in "${session.status}" status`
            );
        }

        if (session.status === 'queued') {
            this.queueService.dequeue(sessionId);
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

    // -----------------------------------------------------------------------
    // Chapters — the session already knows where its output lives
    // -----------------------------------------------------------------------

    @Get(':sessionId/chapters')
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Read the chapter sidecar for this session',
        description:
            "Resolves the session's own bucket and prefix, so the caller supplies " +
            'nothing but a language. Same storage and layout as /api/hls/chapters/read.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({
        status: 200,
        description:
            'Chapter VTT body, empty when this language has no sidecar yet.',
    })
    @ApiResponse({ status: 400, description: 'Malformed language code.' })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    async getChapters(
        @Param('sessionId') sessionId: string,
        @Query('lang') lang = 'en'
    ): Promise<{ vtt: string }> {
        const { s3, folderPrefix, keyHex } = this.sessionStorage(sessionId);
        const result = await this.hlsEditService.readChapters(
            s3,
            folderPrefix,
            lang,
            keyHex
        );
        // No sidecar yet is the normal state of a session nobody has authored
        // chapters for, so it answers with an empty document rather than 404.
        //
        // The editor opens by asking this on every session, and a 404 is
        // written to the browser console whatever the caller then does with it.
        // That put a permanent red line under a screen working correctly, and
        // it cost a bug report: "chapters are not saved" was this read failing
        // to find a file that had never been written. 404 on this route now
        // means the session does not exist, which is the only genuine absence
        // left to report.
        return result ?? { vtt: '' };
    }

    @Put(':sessionId/chapters')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance', 'session')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Write the chapter sidecar for this session',
        description:
            "Stores the document at chapters/<lang>.vtt under the session's own " +
            'prefix, with Content-Type: text/vtt.',
    })
    @ApiParam({ name: 'sessionId', description: 'Session ID' })
    @ApiResponse({ status: 204, description: 'Chapter VTT stored.' })
    @ApiResponse({
        status: 400,
        description: 'Malformed language code or VTT body.',
    })
    @ApiResponse({ status: 404, description: 'Session not found.' })
    @ApiResponse({ status: 413, description: 'VTT body exceeds 1 MiB.' })
    async putChapters(
        @Param('sessionId') sessionId: string,
        @Body() dto: ChaptersWriteDto,
        @Query('lang') lang = 'en'
    ): Promise<void> {
        const { s3, folderPrefix, keyHex } = this.sessionStorage(sessionId);
        await this.hlsEditService.writeChapters(
            s3,
            folderPrefix,
            lang,
            dto.vtt,
            keyHex
        );
    }

    /**
     * Where this session's output lives, in the form the HLS-edit service takes.
     *
     * Includes the session key only when the session encrypts its text assets:
     * that is what tells the service to expect LMCENC01 in the bucket, and to
     * put it back the same way. A session with encrypted segments but plaintext
     * playlists must not be handed a key here, or its sidecars would start
     * coming back encrypted halfway through its life.
     */
    private sessionStorage(sessionId: string): {
        s3: CreateSessionDto['s3'];
        folderPrefix: string;
        keyHex?: string;
    } {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            throw new NotFoundException(`Session ${sessionId} not found`);
        }
        // Restored without its keys: reaching S3 with the placeholders would
        // come back as an opaque authentication failure.
        if (!this.sessionService.hasUsableCredentials(session)) {
            throw new BadRequestException(
                'The storage credentials for this session are no longer available — ' +
                    'create the session again from the CMS'
            );
        }
        // Mirrors the encode: text assets follow `enabled` unless explicitly
        // opted out of. Sidecars written after the encode have to be encrypted
        // exactly when the encode's own were, or the chapter the user just
        // saved becomes the one file in the output nothing can read.
        const encryptsText =
            session.config.encryption != null &&
            session.config.encryption.enabled !== false &&
            session.config.encryption.encryptPlaylists !== false;

        return {
            s3: session.config.s3,
            folderPrefix: S3Service.canonicalPrefix(
                session.config.s3.pathPrefix
            ),
            keyHex: encryptsText ? session.encryptionKeyHex : undefined,
        };
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
                { inputPath: filePath }
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
    @ApiResponse({
        status: 200,
        description:
            'WebVTT storyboard, possibly partial — `X-Storyboard-Complete` ' +
            'says whether sampling has finished. An empty body means sampling ' +
            'is underway and has produced nothing yet.',
    })
    @ApiResponse({
        status: 404,
        description:
            'This source will never have a storyboard: no file attached, or no ' +
            'usable video track.',
    })
    async getPreviewThumbnailVtt(
        @Param('sessionId') sessionId: string,
        @Query('token') token: string,
        @Req() req: Request,
        @Res() res: Response
    ): Promise<void> {
        this.validatePreviewToken(sessionId, token);

        const session = this.sessionService.get(sessionId);
        if (!session?.filePath) {
            throw new NotFoundException('Source file not yet uploaded');
        }

        // The same helper the ingest prime uses — the two have to agree, or a
        // request landing after the prime asks for a storyboard of a different
        // track and the cached cue geometry no longer matches the images.
        const video = selectStoryboardTrack(session.probeResult?.videoTracks);
        const duration = session.probeResult?.format?.duration ?? 0;
        if (!video || duration <= 0) {
            throw new NotFoundException('Source has no usable video track');
        }

        const result = await this.thumbnailService.getOrGeneratePreview(
            sessionId,
            {
                inputPath: session.filePath,
                duration,
                trackIndex: video.index,
                sourceWidth: video.width,
                sourceHeight: video.height,
            }
        );

        // No sprite written yet. Generation was just started by the call above,
        // so this is "ask again", not "never" — and the difference has to reach
        // the client as something other than 404, which it reads as permanent.
        // The two genuinely permanent cases (no source file, no usable video
        // track) are already 404 above, before any sampling is attempted.
        //
        // Answering with an empty but explicitly incomplete storyboard is what
        // the polling contract already expects: nought cues means nothing to
        // draw, and `X-Storyboard-Complete: false` means keep asking.
        if (!result) {
            res.set({
                'Content-Type': 'text/vtt',
                'Cache-Control': 'no-store',
                'X-Storyboard-Complete': 'false',
                'Cross-Origin-Resource-Policy': 'cross-origin',
            });
            res.send('WEBVTT\n');
            return;
        }

        // Cues carry bare filenames; a client resolving them against the VTT URL
        // would drop the token and be turned away. Point them at the sprite route
        // outright instead. `thumb_` is the source storyboard's individual
        // frames, `sprite_` a packed sheet — this route can serve either.
        const base = `${req.protocol}://${req.get('host')}/api/sessions/${sessionId}/thumbnails`;
        const vtt = result.vtt.replace(
            /^((?:sprite|thumb)_\d+\.\w+)(#.*)?$/gm,
            (_m, file: string, frag = '') =>
                `${base}/${file}?token=${encodeURIComponent(token)}${frag}`
        );

        res.set({
            'Content-Type': 'text/vtt',
            // A partial storyboard must not be cached as though it were final —
            // the client is expected to ask again as more of the source is
            // sampled, and a cached copy would freeze the timeline half-drawn.
            'Cache-Control': result.complete
                ? 'private, max-age=300'
                : 'no-store',
            'X-Storyboard-Complete': String(result.complete),
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
        @Res() res: Response
    ): Promise<void> {
        this.validatePreviewToken(sessionId, token);

        // Only ever the files this service produces: the name is part of a path,
        // so anything else could walk out of the directory.
        const match = filename.match(
            /^(?:sprite|thumb)_\d+\.(webp|jpg|jpeg|png)$/
        );
        if (!match) throw new NotFoundException('Invalid sprite filename');

        const path = join(
            this.thumbnailService.previewDir(sessionId),
            'thumbnails',
            filename
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
