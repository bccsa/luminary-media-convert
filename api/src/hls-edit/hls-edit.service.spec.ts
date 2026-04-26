import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, NotImplementedException, PayloadTooLargeException } from '@nestjs/common';
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

            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(s3, 'output/master.m3u8');
            expect(result.etag).toBe('abc');
            expect(result.folderPrefix).toBe('output/');
            expect(result.masterPlaylistKey).toBe('output/master.m3u8');
            expect(result.master.variants).toHaveLength(1);
        });
    });

    describe('mutate', () => {
        it('rewrites master.m3u8 conditionally on empty operations (no-op plumbing)', async () => {
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'old' });
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
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'old' });
            etag.putObjectIfMatch.mockRejectedValue(
                new ConflictException({ code: 'ETAG_MISMATCH' }),
            );

            await expect(
                service.mutate({ s3, masterPlaylistKey: 'm.m3u8', ifMatch: 'stale', operations: [] }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('rejects unknown operation types with BadRequestException', async () => {
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'old' });

            await expect(
                service.mutate({
                    s3,
                    masterPlaylistKey: 'm.m3u8',
                    ifMatch: 'old',
                    operations: [{ type: 'nonsense' } as any],
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(etag.putObjectIfMatch).not.toHaveBeenCalled();
        });

        it('known-but-unimplemented operations yield NotImplementedException (501)', async () => {
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'old' });

            await expect(
                service.mutate({
                    s3,
                    masterPlaylistKey: 'm.m3u8',
                    ifMatch: 'old',
                    operations: [{ type: 'upsertSubtitle' } as any],
                }),
            ).rejects.toBeInstanceOf(NotImplementedException);
        });
    });

    describe('discover', () => {
        it('throws when neither field is provided', async () => {
            await expect(service.discover({ s3 } as any)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('derives folderPrefix from an .m3u8 key', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [{ Key: 'output/master.m3u8' }],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'e' });

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
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'e' });

            const result = await service.discover({ s3, folderPrefix: 'output/' });

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

            await expect(service.discover({ s3, folderPrefix: 'output/' })).rejects.toThrow(
                /No HLS master playlist/,
            );
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
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'e' });

            const result = await service.discover({ s3, folderPrefix: 'output/' });

            expect(result.chaptersLanguages).toEqual(['en', 'fr']);
        });

        it('omits chaptersLanguages when no chapter files exist', async () => {
            const listMock = vi.fn().mockResolvedValue({
                Contents: [{ Key: 'output/master.m3u8' }],
                IsTruncated: false,
            });
            etag.createClient.mockReturnValue({ send: listMock } as any);
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from(MASTER), etag: 'e' });

            const result = await service.discover({ s3, folderPrefix: 'output/' });

            expect(result.chaptersLanguages).toBeUndefined();
        });
    });

    describe('readChapters', () => {
        it('returns the VTT body when the file exists', async () => {
            etag.getObjectWithEtag.mockResolvedValue({
                body: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntro'),
                etag: 'x',
            });

            const result = await service.readChapters(s3, 'output/', 'en');

            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(s3, 'output/chapters/en.vtt');
            expect(result?.vtt).toMatch(/^WEBVTT/);
        });

        it('handles a folder prefix without a trailing slash', async () => {
            etag.getObjectWithEtag.mockResolvedValue({ body: Buffer.from('WEBVTT'), etag: 'x' });
            await service.readChapters(s3, 'output', 'en');
            expect(etag.getObjectWithEtag).toHaveBeenCalledWith(s3, 'output/chapters/en.vtt');
        });

        it('returns null on NoSuchKey', async () => {
            const err: any = new Error('not found');
            err.name = 'NoSuchKey';
            etag.getObjectWithEtag.mockRejectedValue(err);

            const result = await service.readChapters(s3, 'output/', 'en');
            expect(result).toBeNull();
        });

        it('rejects malformed lang codes', async () => {
            await expect(service.readChapters(s3, 'output/', 'EN')).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.readChapters(s3, 'output/', 'english')).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.readChapters(s3, 'output/', '../etc')).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('writeChapters', () => {
        it('puts the VTT body with the right key, body, and content-type', async () => {
            etag.putObject.mockResolvedValue({ etag: 'y' });

            await service.writeChapters(s3, 'output/', 'en', 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nIntro');

            expect(etag.putObject).toHaveBeenCalledWith(
                s3,
                'output/chapters/en.vtt',
                expect.stringMatching(/^WEBVTT/),
                'text/vtt',
            );
        });

        it('rejects bodies that do not start with WEBVTT', async () => {
            await expect(
                service.writeChapters(s3, 'output/', 'en', 'not vtt'),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(etag.putObject).not.toHaveBeenCalled();
        });

        it('rejects malformed lang codes', async () => {
            await expect(
                service.writeChapters(s3, 'output/', 'en_US', 'WEBVTT'),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects bodies larger than 1 MiB', async () => {
            const big = 'WEBVTT\n' + 'x'.repeat(1024 * 1024 + 100);
            await expect(
                service.writeChapters(s3, 'output/', 'en', big),
            ).rejects.toBeInstanceOf(PayloadTooLargeException);
        });
    });
});
