import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    Post,
    Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { posix } from 'path';
import {
    CMS_SESSION_HOOK,
    type CmsSessionHook,
} from '../cms/cms-session-hook.js';
import { normalizeOrigin, OriginRegistry } from '../cms/origin-registry.js';
import { API_VERSION } from '../version.js';
import { CmsCreateSessionDto } from './dto/cms-create-session.dto.js';
import {
    CmsHealthResponseDto,
    CmsSessionResponseDto,
} from './dto/cms-session-response.dto.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { S3Service } from './services/s3.service.js';
import { SessionService, type Session } from './services/session.service.js';

/** Addresses that mean "this machine", for a request that carried no Origin. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The handshake the Luminary CMS uses to hand work to the local encoder.
 *
 * The CMS is an ordinary web app on another origin; this API listens on
 * loopback. A user clicking "upload media" on a post makes the CMS open a
 * session here, carrying everything about the destination — credentials, public
 * base URL, the post's title — and gets back a read token it uses to watch the
 * encode. The file itself is chosen in the local app: the browser never uploads
 * anything, and this API never hands the CMS back what it was given.
 *
 * Authentication is the origin allowlist rather than a key. There is no
 * credential a CMS in a browser could hold that the pages around it could not
 * also read, so the question worth asking is which site is calling, and that is
 * the one thing the browser answers honestly.
 */
@ApiTags('CMS')
@Controller('api/cms')
@SkipThrottle()
export class CmsController {
    private readonly logger = new Logger(CmsController.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly originRegistry: OriginRegistry,
        @Inject(CMS_SESSION_HOOK)
        private readonly onSessionCreated?: CmsSessionHook
    ) {}

    @Get('health')
    @ApiOperation({
        summary: 'Check that the local encoder is installed and running',
        description:
            'Unauthenticated: the CMS calls this before showing the "upload media" ' +
            'affordance at all, and a probe that says only "something is listening ' +
            'on this port, and it is us" gives away nothing.',
    })
    @ApiResponse({ status: 200, type: CmsHealthResponseDto })
    health(): CmsHealthResponseDto {
        return { status: 'ok', apiVersion: API_VERSION };
    }

    @Post('sessions')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Open an encoding session for a CMS document',
        description:
            'Creates a session bound to a CMS document and returns a read-only ' +
            'token for its event stream. Clicking twice on the same post returns ' +
            'the session already in flight rather than starting a second one. ' +
            "Authorised by the caller's Origin, not by an API key.",
    })
    @ApiResponse({ status: 201, type: CmsSessionResponseDto })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({
        status: 403,
        description: 'Origin is not allowed to use this encoder.',
    })
    async createSession(
        @Body() dto: CmsCreateSessionDto,
        @Req() req: Request
    ): Promise<CmsSessionResponseDto> {
        await this.assertOriginAllowed(req);
        const callerOrigin = normalizeOrigin(req.headers.origin) ?? undefined;

        // Matched on the document *and* the caller. Idempotency means "this site
        // clicked twice", not "somebody named this document" — without the
        // second half, one approved site could name another's post and be handed
        // its read token, and with it the playback URL and the decryption key
        // for media it had nothing to do with.
        const existing = this.sessionService.findActiveByDocumentId(
            dto.documentId,
            callerOrigin
        );
        if (existing?.readToken) {
            this.logger.log(
                `Reusing session ${existing.id} for document ${dto.documentId}`
            );
            // Still the click that means "get on with it", so the window comes
            // forward again — the user is very likely looking for the file
            // picker they walked away from.
            this.notifyHost(existing.id);
            return this.describe(existing, req, true);
        }

        const session = this.sessionService.createWith(
            (sessionId) => this.toCreateSessionDto(dto, sessionId),
            {
                title: dto.title,
                documentId: dto.documentId,
                publicBaseUrl: dto.publicBaseUrl,
                origin: 'cms',
                createdByOrigin: callerOrigin,
            }
        );

        this.logger.log(
            `Session ${session.id} opened for document ${dto.documentId} ` +
                `by ${req.headers.origin ?? 'a local caller'}`
        );

        this.notifyHost(session.id);

        return this.describe(session, req, false);
    }

    /**
     * Tell the host a session is waiting for the user, if anything is hosting.
     *
     * Guarded because the response owes nothing to it: a host callback that
     * throws must not turn a created session into a 500 the CMS reads as
     * failure, having no way to learn that the session exists after all.
     */
    private notifyHost(sessionId: string): void {
        try {
            this.onSessionCreated?.(sessionId);
        } catch (err) {
            this.logger.warn(
                `Host notification failed for session ${sessionId}: ${
                    (err as Error).message
                }`
            );
        }
    }

    /**
     * Map the CMS's request onto the encoder's own session config.
     *
     * Every session gets its own subfolder under the caller's prefix, named for
     * the session. Two encodes of the same post would otherwise write master and
     * segment files over each other, and a replacement would be live — half old,
     * half new — for as long as the second encode took.
     */
    private toCreateSessionDto(
        dto: CmsCreateSessionDto,
        sessionId: string
    ): CreateSessionDto {
        const config = new CreateSessionDto();
        config.s3 = {
            ...dto.s3,
            pathPrefix: posix.join(
                S3Service.canonicalPrefix(dto.s3.pathPrefix),
                sessionId
            ),
        };
        config.segmentDuration = dto.segmentDuration;
        config.byteRange = dto.byteRange;
        config.byteRangeMaxFileSizeMB = dto.byteRangeMaxFileSizeMB;
        config.thumbnails = dto.thumbnails;
        // A CMS states a requirement; key delivery is not its business. Leaving
        // this undefined is what the encoder reads as "no encryption".
        config.encryption = dto.encryption?.required
            ? { enabled: true }
            : undefined;
        return config;
    }

    private describe(
        session: Session,
        req: Request,
        reused: boolean
    ): CmsSessionResponseDto {
        // Built from the request's own host so the CMS reaches the encoder on the
        // address it already found it at — the port is assigned by the host app
        // and this process has no better idea of it than the caller does.
        const base = `${req.protocol}://${req.get('host')}`;
        const token = encodeURIComponent(session.readToken!);

        return {
            sessionId: session.id,
            readToken: session.readToken!,
            eventsUrl: `${base}/api/sessions/${session.id}/events?token=${token}`,
            apiVersion: API_VERSION,
            reused,
        };
    }

    /**
     * Refuse anything this instance has not been told to trust.
     *
     * A request with **no** Origin header is not a browser page: curl, or a
     * local tool. There is no origin to judge, so it is allowed — but only from
     * this machine, so an Origin-less request off the network cannot walk past
     * the allowlist by simply omitting the header.
     *
     * A literal `Origin: null` is a different thing entirely and gets no such
     * exemption. Browsers send it for an opaque origin — a sandboxed iframe, a
     * `data:` document — which is precisely the caller this gate exists to stop.
     * The loopback check is no defence there: the browser sending it is running
     * on the user's own machine, so it is always a loopback peer. Exempting it
     * let any website open a session on someone's encoder, bypassing both the
     * approval dialog and the memory of everything they had already refused.
     * It goes to the registry now, which refuses it.
     */
    private async assertOriginAllowed(req: Request): Promise<void> {
        const origin = req.headers.origin;

        if (!origin) {
            const remote = req.socket.remoteAddress ?? '';
            if (LOOPBACK.has(remote)) return;
            throw new ForbiddenException(
                'Requests without an Origin are only accepted from this machine'
            );
        }

        if (await this.originRegistry.isAllowed(origin)) return;

        this.logger.warn(`Refused session request from origin ${origin}`);
        throw new ForbiddenException(
            'This site is not allowed to use the local encoder'
        );
    }
}
