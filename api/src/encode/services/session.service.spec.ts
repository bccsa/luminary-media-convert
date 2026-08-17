import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    CREDENTIALS_FILENAME,
    REDACTED_CREDENTIAL,
    SessionService,
    type Session,
} from './session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';
import type { CredentialCipher } from './credential-cipher.js';

/**
 * SessionService reads WORK_DIR once, as a field initialiser, so every test gets
 * its own directory *before* the service is constructed. Sharing one would let a
 * restore test pick up records another test wrote.
 */
let workDir: string;

const emit = vi.fn();
const events = { emit } as unknown as ConstructorParameters<
    typeof SessionService
>[0];

/**
 * Reversible stand-in for Electron's safeStorage. Deliberately not a no-op: the
 * point of most of these tests is that what lands on disk is *not* the
 * plaintext, and an identity cipher would pass them while proving nothing.
 */
const cipher: CredentialCipher = {
    encrypt: (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
    decrypt: (blob) => {
        if (!blob.startsWith('enc:')) throw new Error('not our ciphertext');
        return Buffer.from(blob.slice(4), 'base64').toString('utf-8');
    },
};

function makeConfig(
    overrides: Partial<CreateSessionDto> = {}
): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test-bucket',
            accessKey: 'AKIAEXAMPLE',
            secretKey: 'sUp3rS3cret',
        },
        ...overrides,
    } as CreateSessionDto;
}

function build(withCipher = true): SessionService {
    return new SessionService(events, withCipher ? cipher : undefined);
}

/**
 * Write a session record straight to disk, as a previous process would have.
 *
 * The record carries redacted keys and the real ones live in the sidecar,
 * because that is the only shape the service ever writes — seeding real keys
 * into session.json would let a session restore its credentials by a route that
 * does not exist, and quietly hide whether recovery works at all.
 */
function seedOnDisk(
    session: Partial<Session> & { id: string },
    { withCredentials = true } = {}
): void {
    const dir = join(workDir, session.id);
    mkdirSync(dir, { recursive: true });

    const config = makeConfig();
    writeFileSync(
        join(dir, 'session.json'),
        JSON.stringify({
            sessionToken: `sess_${session.id}`,
            status: 'uploaded',
            progress: 0,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            ...session,
            config: {
                ...config,
                s3: {
                    ...config.s3,
                    accessKey: REDACTED_CREDENTIAL,
                    secretKey: REDACTED_CREDENTIAL,
                },
            },
        })
    );

    if (withCredentials) {
        writeFileSync(
            join(dir, CREDENTIALS_FILENAME),
            cipher.encrypt(
                JSON.stringify({
                    accessKey: config.s3.accessKey,
                    secretKey: config.s3.secretKey,
                })
            )
        );
    }
}

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lmc-session-'));
    process.env.WORK_DIR = workDir;
    emit.mockClear();
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.WORK_DIR;
});

describe('SessionService — creating', () => {
    it('mints a session token and starts in "created"', () => {
        const session = build().create(makeConfig());

        expect(session.id).toBeTruthy();
        expect(session.sessionToken).toMatch(/^sess_[0-9a-f]{32}$/);
        expect(session.status).toBe('created');
        expect(session.progress).toBe(0);
    });

    it('gives every session its own id and token', () => {
        const service = build();
        const a = service.create(makeConfig());
        const b = service.create(makeConfig());

        expect(a.id).not.toBe(b.id);
        expect(a.sessionToken).not.toBe(b.sessionToken);
    });

    it('mints a read token only for a session a CMS opened', () => {
        // The local UI already holds the instance key, so it has nothing to do
        // with a weaker credential. A read token exists so a CMS can watch a
        // session it is not allowed to drive.
        const service = build();

        expect(service.create(makeConfig()).readToken).toBeUndefined();
        expect(
            service.create(makeConfig(), { origin: 'local' }).readToken
        ).toBeUndefined();
        expect(
            service.create(makeConfig(), { origin: 'cms' }).readToken
        ).toMatch(/^read_[0-9a-f]{32}$/);
    });

    it('hands the builder the id so the config can name its own folder', () => {
        // The CMS gives each session a subfolder named after it, so the id has
        // to exist before the config does.
        const session = build().createWith(
            (id) =>
                makeConfig({
                    s3: { ...makeConfig().s3, pathPrefix: `media/${id}` },
                }),
            { origin: 'cms' }
        );

        expect(session.config.s3.pathPrefix).toBe(`media/${session.id}`);
    });

    it('carries the CMS metadata it was given', () => {
        const session = build().create(makeConfig(), {
            origin: 'cms',
            title: 'Episode 12',
            documentId: 'post_01HTZ8Y0J4',
            publicBaseUrl: 'https://cdn.example.com/media',
        });

        expect(session.title).toBe('Episode 12');
        expect(session.documentId).toBe('post_01HTZ8Y0J4');
        expect(session.publicBaseUrl).toBe('https://cdn.example.com/media');
    });
});

describe('SessionService — looking up', () => {
    it('resolves a session by either of its tokens', () => {
        const service = build();
        const session = service.create(makeConfig(), { origin: 'cms' });

        expect(service.getBySessionToken(session.sessionToken)?.id).toBe(
            session.id
        );
        expect(service.getByReadToken(session.readToken!)?.id).toBe(session.id);
    });

    it('does not resolve one token through the other index', () => {
        // The tiers differ in what they may do, so a read token arriving where a
        // session token is expected must not be honoured.
        const service = build();
        const session = service.create(makeConfig(), { origin: 'cms' });

        expect(service.getBySessionToken(session.readToken!)).toBeUndefined();
        expect(service.getByReadToken(session.sessionToken)).toBeUndefined();
    });

    it('lists newest first', () => {
        const service = build();
        const first = service.create(makeConfig());
        vi.setSystemTime(Date.now() + 1000);
        const second = service.create(makeConfig());
        vi.useRealTimers();

        expect(service.list().map((s) => s.id)).toEqual([second.id, first.id]);
    });

    describe('findActiveByDocumentId', () => {
        it('returns the session already in flight for that document', () => {
            // A double click on "upload media" must land back on the session
            // already running, not start a second one against the same post.
            const service = build();
            const session = service.create(makeConfig(), {
                origin: 'cms',
                documentId: 'post_1',
            });

            expect(service.findActiveByDocumentId('post_1')?.id).toBe(
                session.id
            );
        });

        it.each(['completed', 'failed'] as const)(
            'ignores a %s session — that click means replace what is there',
            (status) => {
                const service = build();
                const session = service.create(makeConfig(), {
                    origin: 'cms',
                    documentId: 'post_1',
                });
                service.updateStatus(session.id, status);

                expect(
                    service.findActiveByDocumentId('post_1')
                ).toBeUndefined();
            }
        );

        it('does not match a different document', () => {
            const service = build();
            service.create(makeConfig(), {
                origin: 'cms',
                documentId: 'post_1',
            });

            expect(service.findActiveByDocumentId('post_2')).toBeUndefined();
        });
    });
});

describe('SessionService — credentials on disk', () => {
    it('never writes S3 keys into session.json', () => {
        const service = build();
        const session = service.create(makeConfig());

        const raw = readFileSync(
            join(workDir, session.id, 'session.json'),
            'utf-8'
        );
        expect(raw).not.toContain('AKIAEXAMPLE');
        expect(raw).not.toContain('sUp3rS3cret');
        expect(JSON.parse(raw).config.s3.accessKey).toBe(REDACTED_CREDENTIAL);
        expect(JSON.parse(raw).config.s3.secretKey).toBe(REDACTED_CREDENTIAL);
    });

    it('keeps the in-memory session usable while redacting only the copy', () => {
        // Redaction is a property of what is written, not of the session itself:
        // the encode still has to reach the bucket.
        const service = build();
        const session = service.create(makeConfig());

        expect(session.config.s3.accessKey).toBe('AKIAEXAMPLE');
        expect(service.hasUsableCredentials(session)).toBe(true);
    });

    it('puts the keys in an encrypted sidecar instead', () => {
        const service = build();
        const session = service.create(makeConfig());

        const path = join(workDir, session.id, CREDENTIALS_FILENAME);
        expect(existsSync(path)).toBe(true);

        const blob = readFileSync(path, 'utf-8');
        expect(blob).not.toContain('sUp3rS3cret');
        expect(JSON.parse(cipher.decrypt(blob))).toEqual({
            accessKey: 'AKIAEXAMPLE',
            secretKey: 'sUp3rS3cret',
        });
    });

    it('writes both files owner-only', () => {
        const service = build();
        const session = service.create(makeConfig());

        const mode = (name: string) =>
            statSync(join(workDir, session.id, name)).mode & 0o777;
        expect(mode('session.json')).toBe(0o600);
        expect(mode(CREDENTIALS_FILENAME)).toBe(0o600);
    });

    it('writes no sidecar at all when there is no cipher', () => {
        // Deliberate: a stranded session is a smaller problem than a plaintext
        // key sitting in the work directory.
        const service = build(false);
        const session = service.create(makeConfig());

        expect(
            existsSync(join(workDir, session.id, CREDENTIALS_FILENAME))
        ).toBe(false);
        expect(
            readFileSync(join(workDir, session.id, 'session.json'), 'utf-8')
        ).not.toContain('sUp3rS3cret');
    });

    describe('hasUsableCredentials', () => {
        it('is false when the config still holds placeholders', () => {
            const service = build();
            const session = service.create(makeConfig());
            session.config.s3.accessKey = REDACTED_CREDENTIAL;

            expect(service.hasUsableCredentials(session)).toBe(false);
        });

        it('is false when a key is missing outright', () => {
            const service = build();
            const session = service.create(makeConfig());
            session.config.s3.secretKey = '';

            expect(service.hasUsableCredentials(session)).toBe(false);
        });
    });
});

describe('SessionService — restoring after a restart', () => {
    it('brings an idle session back with its credentials', () => {
        const first = build();
        const session = first.create(makeConfig());
        first.updateStatus(session.id, 'uploaded');

        const second = build();
        second.onModuleInit();

        const restored = second.get(session.id);
        expect(restored?.status).toBe('uploaded');
        expect(restored?.config.s3.secretKey).toBe('sUp3rS3cret');
        expect(second.hasUsableCredentials(restored!)).toBe(true);
    });

    it('re-indexes both tokens so the client can carry on', () => {
        const first = build();
        const session = first.create(makeConfig(), { origin: 'cms' });

        const second = build();
        second.onModuleInit();

        expect(second.getBySessionToken(session.sessionToken)?.id).toBe(
            session.id
        );
        expect(second.getByReadToken(session.readToken!)?.id).toBe(session.id);
    });

    it.each([
        'uploading',
        'queued',
        'encoding',
        'encrypting',
        'uploading_to_s3',
    ] as const)(
        'fails a session left %s — the process driving it is gone',
        (status) => {
            seedOnDisk({ id: `in-flight-${status}`, status });

            const service = build();
            service.onModuleInit();

            const restored = service.get(`in-flight-${status}`);
            expect(restored?.status).toBe('failed');
            expect(restored?.error).toMatch(/restarted/i);
        }
    );

    it.each(['completed', 'failed'] as const)(
        'discards a %s session and its directory rather than restoring it',
        (status) => {
            // Its output is already in the bucket and its URL already back with
            // the CMS. Boot is the natural moment to be rid of both record and
            // leftovers, instead of letting an age-based sweep do it hours later.
            seedOnDisk({ id: `terminal-${status}`, status });

            const service = build();
            service.onModuleInit();

            expect(service.get(`terminal-${status}`)).toBeUndefined();
            expect(existsSync(join(workDir, `terminal-${status}`))).toBe(false);
        }
    );

    it('fails a session whose credentials cannot be recovered', () => {
        // No sidecar on disk: a different machine, or a reset keychain. The
        // config holds placeholders, and anything reaching S3 with those would
        // fail at the far end with an error nobody could trace to a restart.
        seedOnDisk(
            { id: 'stranded', status: 'uploaded' },
            { withCredentials: false }
        );

        const service = build();
        service.onModuleInit();

        const restored = service.get('stranded');
        expect(restored?.status).toBe('failed');
        expect(restored?.error).toMatch(/credentials unavailable/i);
        expect(service.hasUsableCredentials(restored!)).toBe(false);
    });

    it('prefers the credential reason over "the encoder restarted"', () => {
        // Both apply: it was mid-encode *and* its keys are gone. Re-running is
        // not what fixes the second, so that is the reason the user is shown.
        seedOnDisk(
            { id: 'both', status: 'encoding' },
            { withCredentials: false }
        );

        const service = build();
        service.onModuleInit();

        expect(service.get('both')?.error).toMatch(/credentials unavailable/i);
    });

    it('fails the session when the sidecar cannot be decrypted', () => {
        const first = build();
        const session = first.create(makeConfig());
        writeFileSync(
            join(workDir, session.id, CREDENTIALS_FILENAME),
            'not-our-ciphertext'
        );

        const service = build();
        service.onModuleInit();

        expect(service.get(session.id)?.status).toBe('failed');
    });

    it('holds no credentials at all without a cipher', () => {
        const first = build();
        const session = first.create(makeConfig());

        const second = build(false);
        second.onModuleInit();

        expect(second.get(session.id)?.status).toBe('failed');
    });

    it('falls back to createdAt for a record written before activity stamps', () => {
        // Otherwise every pre-existing session looks freshly active and the
        // sweep never touches it.
        const createdAt = Date.now() - 10 * 3_600_000;
        seedOnDisk({ id: 'legacy', status: 'uploaded', createdAt });
        const path = join(workDir, 'legacy', 'session.json');
        const record = JSON.parse(readFileSync(path, 'utf-8'));
        delete record.lastActivityAt;
        writeFileSync(path, JSON.stringify(record));

        const service = build();
        service.onModuleInit();

        expect(service.get('legacy')?.lastActivityAt).toBe(createdAt);
    });

    it('skips a directory whose record is unreadable rather than failing to boot', () => {
        mkdirSync(join(workDir, 'corrupt'), { recursive: true });
        writeFileSync(join(workDir, 'corrupt', 'session.json'), '{ not json');
        const first = build();
        const good = first.create(makeConfig());

        const service = build();
        service.onModuleInit();

        expect(service.get('corrupt')).toBeUndefined();
        expect(service.get(good.id)).toBeDefined();
    });

    it('survives a work directory that does not exist yet', () => {
        rmSync(workDir, { recursive: true, force: true });
        const service = build();

        expect(() => service.onModuleInit()).not.toThrow();
        expect(service.list()).toEqual([]);
    });
});

describe('SessionService — removing', () => {
    it('drops the record, its tokens and its directory', () => {
        const service = build();
        const session = service.create(makeConfig(), { origin: 'cms' });

        expect(service.remove(session.id)?.id).toBe(session.id);
        expect(service.get(session.id)).toBeUndefined();
        expect(service.getBySessionToken(session.sessionToken)).toBeUndefined();
        expect(service.getByReadToken(session.readToken!)).toBeUndefined();
        expect(existsSync(join(workDir, session.id))).toBe(false);
    });

    it('returns undefined for an id it does not hold', () => {
        expect(build().remove('nope')).toBeUndefined();
    });

    it('does not bring the session back on the next boot', () => {
        const service = build();
        const session = service.create(makeConfig());
        service.remove(session.id);

        const next = build();
        next.onModuleInit();
        expect(next.get(session.id)).toBeUndefined();
    });
});

describe('SessionService — sweeping abandoned sessions', () => {
    const SIX_HOURS = 6 * 3_600_000;

    function aged(
        service: SessionService,
        status: Session['status'],
        hours: number
    ) {
        const session = service.create(makeConfig());
        service.updateStatus(session.id, status);
        session.lastActivityAt = Date.now() - hours * 3_600_000;
        return session;
    }

    it.each(['created', 'uploading', 'uploaded'] as const)(
        'removes an idle %s session past the age limit',
        (status) => {
            const service = build();
            const session = aged(service, status, 7);

            expect(service.cleanupAbandoned(SIX_HOURS)).toBe(1);
            expect(service.get(session.id)).toBeUndefined();
            expect(existsSync(join(workDir, session.id))).toBe(false);
        }
    );

    it.each(['queued', 'encoding', 'encrypting', 'uploading_to_s3'] as const)(
        'never sweeps a %s session, however old',
        (status) => {
            // It is doing work someone is waiting on — and a long backlog is a
            // legitimate reason for `queued` to sit still.
            const service = build();
            const session = aged(service, status, 99);

            expect(service.cleanupAbandoned(SIX_HOURS)).toBe(0);
            expect(service.get(session.id)).toBeDefined();
        }
    );

    it('leaves a session that is idle but recent', () => {
        const service = build();
        const session = aged(service, 'uploaded', 1);

        expect(service.cleanupAbandoned(SIX_HOURS)).toBe(0);
        expect(service.get(session.id)).toBeDefined();
    });

    it('judges on last activity, not on age', () => {
        // A slow multi-gigabyte ingest is hours old and perfectly alive.
        const service = build();
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'uploading');
        session.createdAt = Date.now() - 20 * 3_600_000;
        service.touch(session.id);

        expect(service.cleanupAbandoned(SIX_HOURS)).toBe(0);
        expect(service.get(session.id)).toBeDefined();
    });

    it('reports how many it removed', () => {
        const service = build();
        aged(service, 'uploaded', 7);
        aged(service, 'created', 8);
        aged(service, 'encoding', 9);

        expect(service.cleanupAbandoned(SIX_HOURS)).toBe(2);
    });
});

describe('SessionService — events', () => {
    it('emits on a status change', () => {
        const service = build();
        const session = service.create(makeConfig());
        emit.mockClear();

        service.updateStatus(session.id, 'uploaded');

        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: session.id,
                status: 'uploaded',
            })
        );
    });

    it('emits the failure reason with the failed status', () => {
        const service = build();
        const session = service.create(makeConfig());
        emit.mockClear();

        service.setFailed(session.id, 'Disk full');

        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed', error: 'Disk full' })
        );
    });

    it('does not persist progress — it is worthless after a restart', () => {
        const service = build();
        const session = service.create(makeConfig());
        service.updateProgress(session.id, 42);

        const raw = JSON.parse(
            readFileSync(join(workDir, session.id, 'session.json'), 'utf-8')
        );
        expect(raw.progress).toBeFalsy();
    });

    /**
     * What makes the trim filmstrip fill in as the frames are sampled: the
     * client refetches the storyboard VTT when the count grows, instead of
     * guessing on a backoff timer at how far an ffmpeg pass over the whole file
     * has got.
     */
    describe('storyboard progress', () => {
        it('emits the count sampled so far', () => {
            const service = build();
            const session = service.create(makeConfig());
            emit.mockClear();

            service.updateStoryboardProgress(session.id, 12);

            expect(service.get(session.id)?.storyboardThumbCount).toBe(12);
            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: session.id,
                    storyboardThumbCount: 12,
                })
            );
        });

        it('marks the one report made after the final VTT is written', () => {
            // It cannot ride on the count: the last mid-pass report usually
            // already carries the full number, and a repeat of the same value is
            // not a change the client's watcher can see.
            const service = build();
            const session = service.create(makeConfig());
            emit.mockClear();

            service.updateStoryboardProgress(session.id, 40, true);

            expect(service.get(session.id)?.storyboardComplete).toBe(true);
            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    storyboardThumbCount: 40,
                    storyboardComplete: true,
                })
            );
        });

        it('leaves the flag off an in-progress report rather than sending false', () => {
            const service = build();
            const session = service.create(makeConfig());

            service.updateStoryboardProgress(session.id, 12, false);

            expect(service.get(session.id)?.storyboardComplete).toBeUndefined();
        });

        it('clears the flag again when a later pass re-primes the storyboard', () => {
            // A restored session samples its frames afresh, and the filmstrip
            // must not go on believing the previous pass's VTT is the final one.
            const service = build();
            const session = service.create(makeConfig());
            service.updateStoryboardProgress(session.id, 40, true);
            emit.mockClear();

            service.updateStoryboardProgress(session.id, 3);

            expect(service.get(session.id)?.storyboardComplete).toBeUndefined();
            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({ storyboardComplete: undefined })
            );
        });

        it('does not persist the count — the pass starts over after a restart', () => {
            const service = build();
            const session = service.create(makeConfig());
            service.updateStoryboardProgress(session.id, 40, true);

            const raw = JSON.parse(
                readFileSync(join(workDir, session.id, 'session.json'), 'utf-8')
            );
            expect(raw.storyboardThumbCount).toBeFalsy();
            expect(raw.storyboardComplete).toBeFalsy();
        });

        it('ignores an id it does not hold', () => {
            const service = build();
            emit.mockClear();

            expect(() =>
                service.updateStoryboardProgress('nope', 5)
            ).not.toThrow();
            expect(emit).not.toHaveBeenCalled();
        });

        it('carries the count on every later event, not just its own', () => {
            // The client learns of new frames from whatever event arrives next,
            // so the count belongs on all of them.
            const service = build();
            const session = service.create(makeConfig());
            service.updateStoryboardProgress(session.id, 12);
            emit.mockClear();

            service.updateStatus(session.id, 'uploaded');

            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 'uploaded',
                    storyboardThumbCount: 12,
                })
            );
        });
    });
});
