import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    BadRequestException,
    ConflictException,
    NotImplementedException,
    PayloadTooLargeException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { HlsEditService } from './hls-edit.service.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

const MASTER = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
    'v0/playlist.m3u8',
].join('\n');

const s3: S3ConfigDto = {
    endPoint: 'minio.example.com',
    port: 9000,
    useSSL: false,
    bucket: 'media',
    accessKey: 'k',
    secretKey: 's',
};

function makeEtagMock() {
    return {
        getObjectWithEtag: vi.fn(),
        putObjectIfMatch: vi.fn(),
        putObject: vi.fn(),
        createClient: vi.fn(),
    };
}

describe('HlsEditService', () => {
    let etag: ReturnType<typeof makeEtagMock>;
    let service: HlsEditService;

    beforeEach(() => {
        etag = makeEtagMock();
        service = new HlsEditService(etag as any);
    });

    describe('read', () => {
        it('normalises the key, fetches, and returns the parsed master + etag + folder', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'abc',
            });

            const result = await service.read({
                s3,
                masterPlaylistKey: 'http://host/media/output/master.m3u8',
            });

            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(
                s3,
                'output/master.m3u8'
            );
            expect(result.etag).toBe('abc');
            expect(result.folderPrefix).toBe('output/');
            expect(result.masterPlaylistKey).toBe('output/master.m3u8');
            expect(result.master.variants).toHaveLength(1);
        });
    });

    describe('mutate', () => {
        it('rewrites master.m3u8 conditionally on empty operations (no-op plumbing)', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'old',
            });
            etag.putObjectIfMatch.mockResolvedValue({ etag: 'new' });

            const result = await service.mutate({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
                ifMatch: 'old',
                operations: [],
            });

            expect(etag.putObjectIfMatch).toHaveBeenCalledTimes(1);
            const putArgs = etag.putObjectIfMatch.mock.calls[0];
            expect(putArgs[0]).toBe(s3);
            expect(putArgs[1]).toBe('output/master.m3u8');
            expect(typeof putArgs[2]).toBe('string');
            expect(putArgs[3]).toBe('old');
            expect(putArgs[4]).toBe('application/vnd.apple.mpegurl');

            expect(result.etag).toBe('new');
            expect(result.writtenKeys).toEqual(['output/master.m3u8']);
        });

        it('propagates ConflictException from putObjectIfMatch', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'old',
            });
            etag.putObjectIfMatch.mockRejectedValue(
                new ConflictException({ code: 'ETAG_MISMATCH' })
            );

            await expect(
                service.mutate({
                    s3,
                    masterPlaylistKey: 'm.m3u8',
                    ifMatch: 'stale',
                    operations: [],
                })
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('rejects unknown operation types with BadRequestException', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'old',
            });

            await expect(
                service.mutate({
                    s3,
                    masterPlaylistKey: 'm.m3u8',
                    ifMatch: 'old',
                    operations: [{ type: 'nonsense' } as any],
                })
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(etag.putObjectIfMatch).not.toHaveBeenCalled();
        });

        it('known-but-unimplemented operations yield NotImplementedException (501)', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'old',
            });

            await expect(
                service.mutate({
                    s3,
                    masterPlaylistKey: 'm.m3u8',
                    ifMatch: 'old',
                    operations: [{ type: 'upsertSubtitle' } as any],
                })
            ).rejects.toBeInstanceOf(NotImplementedException);
        });
    });

    describe('discover', () => {
        it('throws when neither field is provided', async () => {
            await expect(
                service.discover({ s3 } as any)
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('derives folderPrefix from an .m3u8 key', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [{ Key: 'output/master.m3u8' }],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'e',
            });

            const result = await service.discover({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
            });

            expect(result.masterPlaylistKey).toBe('output/master.m3u8');
            expect(result.folderPrefix).toBe('output/');
            expect(result.anglePlaylists).toBeUndefined();
        });

        it('returns angles when multiple masters are found', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [
                    { Key: 'output/audio_only.m3u8' },
                    { Key: 'output/main.m3u8' },
                    { Key: 'output/pulpit.m3u8' },
                ],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'e',
            });

            const result = await service.discover({
                s3,
                folderPrefix: 'output/',
            });

            expect(result.masterPlaylistKey).toBe('output/audio_only.m3u8');
            expect(result.anglePlaylists).toEqual([
                { name: 'audio only', key: 'output/audio_only.m3u8' },
                { name: 'main', key: 'output/main.m3u8' },
                { name: 'pulpit', key: 'output/pulpit.m3u8' },
            ]);
        });

        it('throws when no master playlist is found under the prefix', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [{ Key: 'output/v0/media.m3u8' }],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from('#EXTM3U\n#EXTINF:6.0,\nseg0.ts'),
                etag: 'e',
            });

            await expect(
                service.discover({ s3, folderPrefix: 'output/' })
            ).rejects.toThrow(/No HLS master playlist/);
        });

        it('reports chapters/<lang>.vtt sidecars from the same listing', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [
                    { Key: 'output/master.m3u8' },
                    { Key: 'output/chapters/en.vtt' },
                    { Key: 'output/chapters/fr.vtt' },
                    { Key: 'output/chapters/something-else.txt' },
                ],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'e',
            });

            const result = await service.discover({
                s3,
                folderPrefix: 'output/',
            });

            expect(result.chaptersLanguages).toEqual(['en', 'fr']);
        });

        it('omits chaptersLanguages when no chapter files exist', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [{ Key: 'output/master.m3u8' }],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'e',
            });

            const result = await service.discover({
                s3,
                folderPrefix: 'output/',
            });

            expect(result.chaptersLanguages).toBeUndefined();
        });
    });

    describe('readChapters', () => {
        it('returns the VTT body when the file exists', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(
                    'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntro'
                ),
                etag: 'x',
            });

            const result = await service.readChapters(s3, 'output/', 'en');

            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(
                s3,
                'output/chapters/en.vtt'
            );
            expect(result?.vtt).toMatch(/^WEBVTT/);
        });

        it('handles a folder prefix without a trailing slash', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from('WEBVTT'),
                etag: 'x',
            });
            await service.readChapters(s3, 'output', 'en');
            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(
                s3,
                'output/chapters/en.vtt'
            );
        });

        it('returns null on NoSuchKey', async () => {
            const err: any = new Error('not found');
            err.name = 'NoSuchKey';
            etag.getObjectWithEtag.mockRejectedValue(err);

            const result = await service.readChapters(s3, 'output/', 'en');
            expect(result).toBeNull();
        });

        it('rejects malformed lang codes', async () => {
            await expect(
                service.readChapters(s3, 'output/', 'EN')
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.readChapters(s3, 'output/', 'english')
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.readChapters(s3, 'output/', '../etc')
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('writeChapters', () => {
        it('puts the VTT body with the right key, body, and content-type', async () => {
            etag.putObject.mockResolvedValue({ etag: 'y' });

            await service.writeChapters(
                s3,
                'output/',
                'en',
                'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntro'
            );

            expect(etag.putObject).toHaveBeenCalledWith(
                s3,
                'output/chapters/en.vtt',
                expect.stringMatching(/^WEBVTT/),
                'text/vtt'
            );
        });

        it('normalizes uppercase lang codes before writing the sidecar path', async () => {
            etag.putObject.mockResolvedValue({ etag: 'y' });

            await service.writeChapters(
                s3,
                'output/',
                'EN',
                'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntro'
            );

            expect(etag.putObject).toHaveBeenCalledWith(
                s3,
                'output/chapters/en.vtt',
                expect.stringMatching(/^WEBVTT/),
                'text/vtt'
            );
        });

        it('rejects bodies that do not start with WEBVTT', async () => {
            await expect(
                service.writeChapters(s3, 'output/', 'en', 'not vtt')
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(etag.putObject).not.toHaveBeenCalled();
        });

        it('rejects malformed lang codes', async () => {
            await expect(
                service.writeChapters(s3, 'output/', 'en_US', 'WEBVTT')
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects bodies larger than 1 MiB', async () => {
            const big = 'WEBVTT\n' + 'x'.repeat(1024 * 1024 + 100);
            await expect(
                service.writeChapters(s3, 'output/', 'en', big)
            ).rejects.toBeInstanceOf(PayloadTooLargeException);
        });
    });
});

describe('HlsEditService — encrypted sessions (LMCENC01)', () => {
    const KEY_HEX = '000102030405060708090a0b0c0d0e0f';
    const KEY = Buffer.from(KEY_HEX, 'hex');

    let etag: ReturnType<typeof makeEtagMock>;
    let service: HlsEditService;

    /** The format by hand, so the service is checked against the spec. */
    function encrypt(plaintext: string): Buffer {
        const iv = randomBytes(16);
        const cipher = createCipheriv('aes-128-cbc', KEY, iv);
        return Buffer.concat([
            Buffer.from('LMCENC01', 'ascii'),
            iv,
            cipher.update(Buffer.from(plaintext, 'utf-8')),
            cipher.final(),
        ]);
    }

    function decrypt(payload: Buffer): string {
        expect(payload.subarray(0, 8).toString('ascii')).toBe('LMCENC01');
        const decipher = createDecipheriv(
            'aes-128-cbc',
            KEY,
            payload.subarray(8, 24)
        );
        return Buffer.concat([
            decipher.update(payload.subarray(24)),
            decipher.final(),
        ]).toString('utf-8');
    }

    beforeEach(() => {
        etag = makeEtagMock();
        service = new HlsEditService(etag as any);
    });

    describe('read', () => {
        it('decrypts before parsing', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: encrypt(MASTER),
                etag: 'abc',
            });

            const result = await service.read({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
                keyHex: KEY_HEX,
            });

            expect(result.master.variants).toHaveLength(1);
        });

        it('reads a plaintext master even when a key is supplied', async () => {
            // A session can encrypt its segments without encrypting its
            // playlists; detection is by content, never by request.
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'abc',
            });

            const result = await service.read({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
                keyHex: KEY_HEX,
            });

            expect(result.master.variants).toHaveLength(1);
        });

        it('refuses an encrypted master with no key rather than guessing', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: encrypt(MASTER),
                etag: 'abc',
            });

            await expect(
                service.read({ s3, masterPlaylistKey: 'output/master.m3u8' })
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('mutate', () => {
        it('writes the rebuilt master back encrypted, with a fresh IV', async () => {
            const stored = encrypt(MASTER);
            etag.getObjectWithEtag.mockResolvedValue({
                body: stored,
                etag: 'old',
            });
            etag.putObjectIfMatch.mockResolvedValue({ etag: 'new' });

            const result = await service.mutate({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
                ifMatch: 'old',
                operations: [],
                keyHex: KEY_HEX,
            });

            const [, , body, , contentType] =
                etag.putObjectIfMatch.mock.calls[0];
            expect(Buffer.isBuffer(body)).toBe(true);
            expect(contentType).toBe('application/octet-stream');
            // Plaintext never reaches S3 — not even for the instant between
            // this write and a follow-up one.
            expect(decrypt(body as Buffer)).toContain('#EXT-X-STREAM-INF');
            expect(
                (body as Buffer).subarray(8, 24).equals(stored.subarray(8, 24))
            ).toBe(false);
            expect(result.etag).toBe('new');
        });

        it('keeps a plaintext session plaintext', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from(MASTER),
                etag: 'old',
            });
            etag.putObjectIfMatch.mockResolvedValue({ etag: 'new' });

            await service.mutate({
                s3,
                masterPlaylistKey: 'output/master.m3u8',
                ifMatch: 'old',
                operations: [],
            });

            const [, , body, , contentType] =
                etag.putObjectIfMatch.mock.calls[0];
            expect(typeof body).toBe('string');
            expect(contentType).toBe('application/vnd.apple.mpegurl');
        });
    });

    describe('chapters', () => {
        it('decrypts a chapter sidecar on read', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: encrypt('WEBVTT\n\n00:00.000 --> 00:10.000\nOne\n'),
                etag: 'e',
            });

            const result = await service.readChapters(
                s3,
                'output/',
                'en',
                KEY_HEX
            );

            expect(result?.vtt).toContain('WEBVTT');
            expect(result?.vtt).toContain('One');
        });

        it('encrypts a chapter sidecar on write', async () => {
            etag.putObject.mockResolvedValue({ etag: 'e' });

            await service.writeChapters(
                s3,
                'output/',
                'en',
                'WEBVTT\n\n00:00.000 --> 00:10.000\nOne\n',
                KEY_HEX
            );

            const [, key, body, contentType] = etag.putObject.mock.calls[0];
            expect(key).toBe('output/chapters/en.vtt');
            expect(contentType).toBe('application/octet-stream');
            expect(decrypt(body as Buffer)).toContain('One');
        });

        it('gives each write its own IV', async () => {
            etag.putObject.mockResolvedValue({ etag: 'e' });
            const vtt = 'WEBVTT\n';

            await service.writeChapters(s3, 'output/', 'en', vtt, KEY_HEX);
            await service.writeChapters(s3, 'output/', 'en', vtt, KEY_HEX);

            const first = etag.putObject.mock.calls[0][2] as Buffer;
            const second = etag.putObject.mock.calls[1][2] as Buffer;
            expect(first.equals(second)).toBe(false);
        });

        it('stores plaintext when the session has no key', async () => {
            etag.putObject.mockResolvedValue({ etag: 'e' });

            await service.writeChapters(s3, 'output/', 'en', 'WEBVTT\n');

            const [, , body, contentType] = etag.putObject.mock.calls[0];
            expect(body).toBe('WEBVTT\n');
            expect(contentType).toBe('text/vtt');
        });

        it('rejects a malformed key rather than writing something unreadable', async () => {
            await expect(
                service.writeChapters(s3, 'output/', 'en', 'WEBVTT\n', 'nothex')
            ).rejects.toThrow(/32 hex/);
            expect(etag.putObject).not.toHaveBeenCalled();
        });
    });

    describe('discover', () => {
        it('sees masters through the ciphertext', async () => {
            etag.createClient.mockReturnValue({
                send: vi.fn().mockResolvedValue({
                    Contents: [{ Key: 'output/master.m3u8' }],
                    IsTruncated: false,
                }),
            });
            etag.getObjectWithEtag.mockResolvedValue({
                body: encrypt(MASTER),
                etag: 'e',
            });

            const result = await service.discover({
                s3,
                folderPrefix: 'output/',
                keyHex: KEY_HEX,
            });

            expect(result.masterPlaylistKey).toBe('output/master.m3u8');
        });
    });
});
