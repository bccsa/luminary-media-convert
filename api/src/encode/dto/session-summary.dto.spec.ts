import { toSessionSummary } from './session-summary.dto.js';
import type { Session } from '../services/session.service.js';

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'sess-id',
        sessionToken: 'sess_supersecrettoken',
        status: 'completed',
        progress: 100,
        config: {
            s3: {
                endPoint: 's3.example.com',
                bucket: 'media',
                pathPrefix: 'projects/one',
                accessKey: 'AKIA_SECRET_ACCESS_KEY',
                secretKey: 'THE_SECRET_KEY',
            },
        } as any,
        createdAt: 1,
        lastActivityAt: 1,
        ...overrides,
    };
}

describe('toSessionSummary', () => {
    describe('never leaks credentials', () => {
        // The session record carries the S3 keys, the bearer token that grants
        // access to the session, and the HLS decryption key. A listing goes to
        // any client that can list, so this is an allow-list by construction —
        // these assertions are what keeps that true as fields get added.
        const session = makeSession({
            encryptionKeyHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
            filePath: '/Users/alex/Movies/interview.mov',
        });

        it.each([
            ['session token', 'sess_supersecrettoken'],
            ['S3 access key', 'AKIA_SECRET_ACCESS_KEY'],
            ['S3 secret key', 'THE_SECRET_KEY'],
            ['encryption key', 'deadbeefdeadbeefdeadbeefdeadbeef'],
        ])('omits the %s', (_label, secret) => {
            const serialised = JSON.stringify(toSessionSummary(session));
            expect(serialised).not.toContain(secret);
        });

        it('exposes the source filename but not its path', () => {
            const summary = toSessionSummary(session);
            expect(summary.filename).toBe('interview.mov');
            expect(JSON.stringify(summary)).not.toContain('/Users/alex');
        });
    });

    describe('encrypted flag', () => {
        it('is true once a key has been generated', () => {
            const summary = toSessionSummary(
                makeSession({ encryptionKeyHex: 'abc' }),
            );
            expect(summary.encrypted).toBe(true);
        });

        it('is true while encryption is configured but the encode has not run', () => {
            const session = makeSession();
            session.config.encryption = { keyUrl: 'https://k' } as any;
            expect(toSessionSummary(session).encrypted).toBe(true);
        });

        it('is false when encryption was explicitly turned off', () => {
            const session = makeSession();
            session.config.encryption = {
                keyUrl: 'https://k',
                enabled: false,
            } as any;
            expect(toSessionSummary(session).encrypted).toBe(false);
        });

        it('is false when encryption was never configured', () => {
            expect(toSessionSummary(makeSession()).encrypted).toBe(false);
        });
    });

    it('carries the fields a listing renders', () => {
        const summary = toSessionSummary(
            makeSession({
                name: 'Interview',
                files: ['a', 'b', 'c'],
                masterPlaylist: 'projects/one/master.m3u8',
                completedAt: 42,
                probeResult: { format: { duration: 120 } } as any,
            }),
        );

        expect(summary).toMatchObject({
            id: 'sess-id',
            name: 'Interview',
            status: 'completed',
            progress: 100,
            fileCount: 3,
            masterPlaylist: 'projects/one/master.m3u8',
            durationSec: 120,
            bucket: 'media',
            pathPrefix: 'projects/one',
            completedAt: 42,
        });
    });

    it('tolerates a session that has barely started', () => {
        const summary = toSessionSummary(
            makeSession({ status: 'created', progress: 0 }),
        );
        expect(summary.filename).toBeUndefined();
        expect(summary.fileCount).toBeUndefined();
        expect(summary.durationSec).toBeUndefined();
        expect(summary.completedAt).toBeUndefined();
    });
});
