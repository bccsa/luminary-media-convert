import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Request } from 'express';
import { CmsController } from './cms.controller.js';
import { OriginRegistry } from '../cms/origin-registry.js';
import { SessionService } from './services/session.service.js';
import { API_VERSION } from '../version.js';
import type { CmsCreateSessionDto } from './dto/cms-create-session.dto.js';

let workDir: string;
let sessions: SessionService;
const onSessionCreated = vi.fn();

function makeDto(
    overrides: Partial<CmsCreateSessionDto> = {}
): CmsCreateSessionDto {
    return {
        documentId: 'post_01HTZ8Y0J4',
        title: 'Episode 12',
        publicBaseUrl: 'https://cdn.example.com/media',
        s3: {
            endPoint: 's3.example.com',
            bucket: 'media',
            accessKey: 'AKIAEXAMPLE',
            secretKey: 'sUp3rS3cret',
        },
        ...overrides,
    } as CmsCreateSessionDto;
}

/**
 * A request as the controller reads it: an Origin header, and the peer address
 * the socket came from — which is what stands in for trust when there is no
 * Origin at all.
 */
function makeRequest(
    opts: {
        origin?: string;
        remoteAddress?: string;
        host?: string;
        protocol?: string;
    } = {}
): Request {
    const { origin, host = '127.0.0.1:31711', protocol = 'http' } = opts;
    // Presence, not value: passing `remoteAddress: undefined` to a defaulted
    // parameter would use the default, so "the socket reported no address"
    // could not be expressed and that test would pass for the wrong reason.
    const remoteAddress =
        'remoteAddress' in opts ? opts.remoteAddress : '127.0.0.1';

    return {
        headers: origin === undefined ? {} : { origin },
        socket: { remoteAddress },
        protocol,
        get: (name: string) =>
            name.toLowerCase() === 'host' ? host : undefined,
    } as unknown as Request;
}

function build(allowedOrigins: string[] = ['https://cms.test']): CmsController {
    return new CmsController(
        sessions,
        new OriginRegistry({ allowedOrigins }),
        onSessionCreated
    );
}

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lmc-cms-'));
    process.env.WORK_DIR = workDir;
    sessions = new SessionService({ emit: vi.fn() } as never);
    onSessionCreated.mockReset();
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.WORK_DIR;
});

describe('CmsController — health', () => {
    it('reports itself and its version, unauthenticated', () => {
        // The CMS calls this before showing the "upload media" affordance at
        // all. Saying only "something is listening here, and it is us" gives
        // away nothing worth withholding.
        expect(build().health()).toEqual({
            status: 'ok',
            apiVersion: API_VERSION,
        });
    });
});

describe('CmsController — who may open a session', () => {
    it('accepts an allowed origin', async () => {
        const result = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(result.sessionId).toBeTruthy();
    });

    it('refuses an origin it was not told to trust', async () => {
        await expect(
            build().createSession(
                makeDto(),
                makeRequest({ origin: 'https://evil.test' })
            )
        ).rejects.toThrow(ForbiddenException);
    });

    it('creates nothing when it refuses', async () => {
        // A refusal that still left a session behind would let an unknown site
        // fill the work directory with records nobody can reach.
        await build()
            .createSession(
                makeDto(),
                makeRequest({ origin: 'https://evil.test' })
            )
            .catch(() => undefined);

        expect(sessions.list()).toEqual([]);
    });

    it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
        'accepts a request with no Origin from %s',
        async (remoteAddress) => {
            // curl, and the host app's own renderer, whose origin browsers
            // report inconsistently.
            const result = await build().createSession(
                makeDto(),
                makeRequest({ remoteAddress })
            );

            expect(result.sessionId).toBeTruthy();
        }
    );

    it('accepts an Origin of "null" from this machine', async () => {
        const result = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'null', remoteAddress: '127.0.0.1' })
        );

        expect(result.sessionId).toBeTruthy();
    });

    it('refuses an Origin-less request from anywhere else', async () => {
        // Otherwise omitting the header would be a way round the allowlist,
        // which is the whole of the perimeter for a remote caller.
        await expect(
            build().createSession(
                makeDto(),
                makeRequest({ remoteAddress: '192.168.1.50' })
            )
        ).rejects.toThrow(ForbiddenException);
    });

    it('refuses an Origin-less request whose peer address is unknown', async () => {
        await expect(
            build().createSession(
                makeDto(),
                makeRequest({ remoteAddress: undefined })
            )
        ).rejects.toThrow(ForbiddenException);
    });

    it('matches an allowlist entry regardless of case or trailing slash', async () => {
        const controller = build(['HTTPS://CMS.test/']);

        const result = await controller.createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(result.sessionId).toBeTruthy();
    });
});

describe('CmsController — a repeated click on the same post', () => {
    it('hands back the session already in flight', async () => {
        const controller = build();
        const req = makeRequest({ origin: 'https://cms.test' });

        const first = await controller.createSession(makeDto(), req);
        const second = await controller.createSession(makeDto(), req);

        expect(second.sessionId).toBe(first.sessionId);
        expect(second.reused).toBe(true);
        expect(first.reused).toBe(false);
        expect(sessions.list()).toHaveLength(1);
    });

    it('brings the window forward again on the repeat', async () => {
        // Still the click that means "get on with it" — the user is very likely
        // looking for the file picker they walked away from.
        const controller = build();
        const req = makeRequest({ origin: 'https://cms.test' });

        await controller.createSession(makeDto(), req);
        onSessionCreated.mockClear();
        await controller.createSession(makeDto(), req);

        expect(onSessionCreated).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh session for a different document', async () => {
        const controller = build();
        const req = makeRequest({ origin: 'https://cms.test' });

        const first = await controller.createSession(makeDto(), req);
        const second = await controller.createSession(
            makeDto({ documentId: 'post_other' }),
            req
        );

        expect(second.sessionId).not.toBe(first.sessionId);
    });

    it('starts a fresh session once the previous one has finished', async () => {
        // A click on a post whose encode is done means "replace what is there".
        const controller = build();
        const req = makeRequest({ origin: 'https://cms.test' });

        const first = await controller.createSession(makeDto(), req);
        sessions.updateStatus(first.sessionId, 'completed');
        const second = await controller.createSession(makeDto(), req);

        expect(second.sessionId).not.toBe(first.sessionId);
        expect(second.reused).toBe(false);
    });
});

describe('CmsController — the session it builds', () => {
    async function create(dto = makeDto()) {
        const controller = build();
        const response = await controller.createSession(
            dto,
            makeRequest({ origin: 'https://cms.test' })
        );
        return { response, session: sessions.get(response.sessionId)! };
    }

    it('gives the session its own subfolder under the caller’s prefix', async () => {
        // Two encodes of the same post would otherwise write over each other,
        // and a replacement would be live — half old, half new — for as long as
        // the second encode took.
        const { response, session } = await create(
            makeDto({
                s3: { ...makeDto().s3, pathPrefix: 'library/videos' },
            } as never)
        );

        expect(session.config.s3.pathPrefix).toBe(
            `library/videos/${response.sessionId}`
        );
    });

    it('uses the session id alone when the CMS sent no prefix', async () => {
        const { response, session } = await create();

        expect(session.config.s3.pathPrefix).toBe(response.sessionId);
    });

    it('canonicalises a prefix with stray separators', async () => {
        const { response, session } = await create(
            makeDto({
                s3: { ...makeDto().s3, pathPrefix: '//library//videos//' },
            } as never)
        );

        expect(session.config.s3.pathPrefix).toBe(
            `library/videos/${response.sessionId}`
        );
    });

    it('turns a stated encryption requirement into an enabled encryption config', async () => {
        // A CMS states a requirement; key delivery is not its business.
        const { session } = await create(
            makeDto({ encryption: { required: true } } as never)
        );

        expect(session.config.encryption).toEqual({ enabled: true });
    });

    it.each([undefined, { required: false }])(
        'leaves encryption unset for %o, which the encoder reads as none',
        async (encryption) => {
            const { session } = await create(makeDto({ encryption } as never));

            expect(session.config.encryption).toBeUndefined();
        }
    );

    it('carries the document metadata onto the session', async () => {
        const { session } = await create();

        expect(session.origin).toBe('cms');
        expect(session.title).toBe('Episode 12');
        expect(session.documentId).toBe('post_01HTZ8Y0J4');
        expect(session.publicBaseUrl).toBe('https://cdn.example.com/media');
    });

    it('passes the segment and byte-range options through', async () => {
        const { session } = await create(
            makeDto({
                segmentDuration: 4,
                byteRange: false,
                byteRangeMaxFileSizeMB: 250,
                thumbnails: false,
            } as never)
        );

        expect(session.config.segmentDuration).toBe(4);
        expect(session.config.byteRange).toBe(false);
        expect(session.config.byteRangeMaxFileSizeMB).toBe(250);
        expect(session.config.thumbnails).toBe(false);
    });
});

describe('CmsController — what it answers with', () => {
    it('returns a read token, not the token that drives the session', async () => {
        const controller = build();
        const response = await controller.createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );
        const session = sessions.get(response.sessionId)!;

        expect(response.readToken).toMatch(/^read_/);
        expect(JSON.stringify(response)).not.toContain(session.sessionToken);
    });

    it('never echoes the S3 credentials back', async () => {
        const response = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(JSON.stringify(response)).not.toContain('sUp3rS3cret');
        expect(JSON.stringify(response)).not.toContain('AKIAEXAMPLE');
    });

    it('builds the events URL from the request’s own host', async () => {
        // The port is assigned by the host app, and this process has no better
        // idea of it than the caller does.
        const response = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test', host: '127.0.0.1:45678' })
        );

        expect(response.eventsUrl).toBe(
            `http://127.0.0.1:45678/api/sessions/${response.sessionId}` +
                `/events?token=${response.readToken}`
        );
    });

    it('url-encodes the token it puts in the query string', async () => {
        const response = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(response.eventsUrl).toContain(
            encodeURIComponent(response.readToken)
        );
    });

    it('reports the API version so the CMS can tell what it is talking to', async () => {
        const response = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(response.apiVersion).toBe(API_VERSION);
    });
});

describe('CmsController — the host notification', () => {
    it('tells the host a session is waiting for the user', async () => {
        const controller = build();
        const response = await controller.createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(onSessionCreated).toHaveBeenCalledWith(response.sessionId);
    });

    it('still answers when the host callback throws', async () => {
        // The session exists. A 500 here would have the CMS record a failure,
        // with no way to learn afterwards that the session is there after all.
        onSessionCreated.mockImplementation(() => {
            throw new Error('no window');
        });

        const response = await build().createSession(
            makeDto(),
            makeRequest({ origin: 'https://cms.test' })
        );

        expect(response.sessionId).toBeTruthy();
    });

    it('works with no host at all', async () => {
        const controller = new CmsController(
            sessions,
            new OriginRegistry({ allowedOrigins: ['https://cms.test'] }),
            undefined
        );

        await expect(
            controller.createSession(
                makeDto(),
                makeRequest({ origin: 'https://cms.test' })
            )
        ).resolves.toBeTruthy();
    });
});
