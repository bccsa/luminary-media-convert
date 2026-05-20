import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCouchdbUrl } from './couchdb-url.js';

const ENV_KEYS = [
    'COUCHDB_URL',
    'COUCHDB_USERNAME',
    'COUCHDB_PASSWORD',
    'COUCHDB_DATABASE',
] as const;

describe('buildCouchdbUrl', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    describe('defaults', () => {
        it('returns localhost URL and luminary db when nothing is set', () => {
            const { url, dbName } = buildCouchdbUrl();
            expect(url).toBe('http://localhost:5984/');
            expect(dbName).toBe('luminary');
        });

        it('uses COUCHDB_DATABASE override', () => {
            process.env.COUCHDB_DATABASE = 'luminary-encoder';
            expect(buildCouchdbUrl().dbName).toBe('luminary-encoder');
        });

        it('uses COUCHDB_URL override (host only)', () => {
            process.env.COUCHDB_URL = 'https://couchdb.example.com:6984';
            expect(buildCouchdbUrl().url).toBe(
                'https://couchdb.example.com:6984/',
            );
        });
    });

    describe('no-auth mode', () => {
        it('omits userinfo when neither username nor password is set', () => {
            const { url } = buildCouchdbUrl();
            const parsed = new URL(url);
            expect(parsed.username).toBe('');
            expect(parsed.password).toBe('');
        });
    });

    describe('credential injection', () => {
        // Each case asserts the raw password round-trips through percent-decoding,
        // rather than asserting an exact serialized form. That's the real contract:
        // CouchDB receives the original bytes regardless of how the URL class
        // chooses to encode them.
        const cases: Array<{ name: string; user: string; pass: string }> = [
            { name: 'simple ASCII', user: 'admin', pass: 'password' },
            {
                name: "password with ':'",
                user: 'admin',
                pass: 'pa:ss',
            },
            {
                name: "password with '@'",
                user: 'admin',
                pass: 'pa@ss',
            },
            {
                name: "password with '%'",
                user: 'admin',
                pass: 'pa%ss',
            },
            {
                name: "password with '(' and '.'",
                user: 'admin',
                pass: 'pa(s.s)',
            },
            {
                name: 'all of the problem characters together',
                user: 'admin',
                pass: '(a%b.c:d@e)',
            },
            {
                name: 'username with special characters',
                user: 'a:b@c',
                pass: 'plain',
            },
        ];

        for (const { name, user, pass } of cases) {
            it(`round-trips ${name}`, () => {
                process.env.COUCHDB_USERNAME = user;
                process.env.COUCHDB_PASSWORD = pass;

                const { url } = buildCouchdbUrl();
                const parsed = new URL(url);

                expect(decodeURIComponent(parsed.username)).toBe(user);
                expect(decodeURIComponent(parsed.password)).toBe(pass);
                expect(parsed.host).toBe('localhost:5984');
            });
        }

        it('preserves the host and port from COUCHDB_URL', () => {
            process.env.COUCHDB_URL = 'https://db.internal:6984';
            process.env.COUCHDB_USERNAME = 'admin';
            process.env.COUCHDB_PASSWORD = 'p@ss';

            const { url } = buildCouchdbUrl();
            const parsed = new URL(url);

            expect(parsed.protocol).toBe('https:');
            expect(parsed.host).toBe('db.internal:6984');
            expect(decodeURIComponent(parsed.password)).toBe('p@ss');
        });
    });

    describe('error: embedded credentials in COUCHDB_URL', () => {
        it('rejects userinfo with both username and password', () => {
            process.env.COUCHDB_URL =
                'http://admin:secret@localhost:5984';
            expect(() => buildCouchdbUrl()).toThrow(
                /must not contain embedded credentials/i,
            );
        });

        it('rejects userinfo with username only', () => {
            process.env.COUCHDB_URL = 'http://admin@localhost:5984';
            expect(() => buildCouchdbUrl()).toThrow(
                /must not contain embedded credentials/i,
            );
        });
    });

    describe('error: half-configured credentials', () => {
        it('throws when username is set but password is empty', () => {
            process.env.COUCHDB_USERNAME = 'admin';
            expect(() => buildCouchdbUrl()).toThrow(
                /COUCHDB_USERNAME is set but COUCHDB_PASSWORD/,
            );
        });

        it('throws when password is set but username is empty', () => {
            process.env.COUCHDB_PASSWORD = 'secret';
            expect(() => buildCouchdbUrl()).toThrow(
                /COUCHDB_PASSWORD is set but COUCHDB_USERNAME/,
            );
        });
    });

    describe('error: invalid URL', () => {
        it('throws on garbage COUCHDB_URL', () => {
            process.env.COUCHDB_URL = 'not a url';
            expect(() => buildCouchdbUrl()).toThrow(/Invalid COUCHDB_URL/);
        });
    });
});
