import { type Mock } from 'vitest';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockFPutObject, MockClient } = vi.hoisted(() => {
    const mockFPutObject = vi.fn().mockResolvedValue(undefined);
    const MockClient = vi.fn().mockImplementation(function (this: any) {
        this.fPutObject = mockFPutObject;
    });
    return { mockFPutObject, MockClient };
});

vi.mock('minio', () => ({
    Client: MockClient,
}));

import { S3Service } from './s3.service.js';
import * as minio from 'minio';

function makeS3Config(overrides: Partial<S3ConfigDto> = {}): S3ConfigDto {
    return {
        endPoint: 's3.example.com',
        bucket: 'test-bucket',
        accessKey: 'key',
        secretKey: 'secret',
        ...overrides,
    };
}

describe('S3Service', () => {
    let service: S3Service;

    beforeEach(() => {
        service = new S3Service();
        mockFPutObject.mockReset();
        mockFPutObject.mockResolvedValue(undefined);
        (minio.Client as Mock).mockClear();
    });

    describe('getContentType (private)', () => {
        const getContentType = (path: string): string => {
            return (service as any).getContentType(path);
        };

        it('should return HLS content type for .m3u8', () => {
            expect(getContentType('master.m3u8')).toBe('application/vnd.apple.mpegurl');
        });

        it('should return fMP4 segment content type for .m4s', () => {
            expect(getContentType('segment_000.m4s')).toBe('video/iso.segment');
        });

        it('should return MP4 content type for .mp4', () => {
            expect(getContentType('video.mp4')).toBe('video/mp4');
        });

        it('should return octet-stream for unknown extensions', () => {
            expect(getContentType('file.xyz')).toBe('application/octet-stream');
        });

        it('should handle full paths', () => {
            expect(getContentType('/tmp/output/v0/playlist.m3u8')).toBe('application/vnd.apple.mpegurl');
        });

        it('should return image/webp for .webp', () => {
            expect(getContentType('sprite_001.webp')).toBe('image/webp');
        });

        it('should return image/jpeg for .jpg', () => {
            expect(getContentType('thumbnail.jpg')).toBe('image/jpeg');
        });

        it('should return image/jpeg for .jpeg', () => {
            expect(getContentType('thumbnail.jpeg')).toBe('image/jpeg');
        });

        it('should return text/vtt for .vtt', () => {
            expect(getContentType('thumbnails.vtt')).toBe('text/vtt');
        });

        it('should return video/mp2t for .ts', () => {
            expect(getContentType('segment_000.ts')).toBe('video/mp2t');
        });
    });

    describe('walkDir (private)', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 's3-walk-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should return all files recursively', async () => {
            mkdirSync(join(tmpDir, 'sub'), { recursive: true });
            writeFileSync(join(tmpDir, 'a.txt'), 'a');
            writeFileSync(join(tmpDir, 'sub', 'b.txt'), 'b');

            const files = await (service as any).walkDir(tmpDir);
            expect(files).toHaveLength(2);
            expect(files).toContain(join(tmpDir, 'a.txt'));
            expect(files).toContain(join(tmpDir, 'sub', 'b.txt'));
        });

        it('should return empty array for empty directory', async () => {
            const files = await (service as any).walkDir(tmpDir);
            expect(files).toEqual([]);
        });
    });

    describe('createClient (private)', () => {
        it('should create a MinIO client with given config', () => {
            (service as any).createClient(makeS3Config({
                port: 9000,
                useSSL: false,
                region: 'us-east-1',
            }));

            expect(minio.Client).toHaveBeenCalledWith({
                endPoint: 's3.example.com',
                port: 9000,
                useSSL: false,
                accessKey: 'key',
                secretKey: 'secret',
                region: 'us-east-1',
            });
        });

        it('should default useSSL to true when not provided', () => {
            (service as any).createClient(makeS3Config());

            expect(minio.Client).toHaveBeenCalledWith(
                expect.objectContaining({ useSSL: true }),
            );
        });

        it('should respect useSSL: false', () => {
            (service as any).createClient(makeS3Config({ useSSL: false }));

            expect(minio.Client).toHaveBeenCalledWith(
                expect.objectContaining({ useSSL: false }),
            );
        });
    });

    describe('uploadDirectory', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 's3-upload-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should upload all files and return keys + master playlist key', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');
            mkdirSync(join(tmpDir, 'stream_0'), { recursive: true });
            writeFileSync(join(tmpDir, 'stream_0', 'playlist.m3u8'), '#EXTM3U');
            writeFileSync(join(tmpDir, 'stream_0', 'init.mp4'), 'init');
            writeFileSync(join(tmpDir, 'stream_0', 'segment_000.m4s'), 'seg');

            const result = await service.uploadDirectory(
                makeS3Config(),
                tmpDir,
                'master.m3u8',
            );

            expect(result.keys).toHaveLength(4);
            expect(result.keys).toContain('master.m3u8');
            expect(result.keys).toContain('stream_0/playlist.m3u8');
            expect(result.keys).toContain('stream_0/init.mp4');
            expect(result.keys).toContain('stream_0/segment_000.m4s');
            expect(result.masterPlaylistKey).toBe('master.m3u8');

            expect(mockFPutObject).toHaveBeenCalledTimes(4);
        });

        it('should use correct content types for uploaded files', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');
            mkdirSync(join(tmpDir, 'stream_0'), { recursive: true });
            writeFileSync(join(tmpDir, 'stream_0', 'init.mp4'), 'init');
            writeFileSync(join(tmpDir, 'stream_0', 'segment_000.m4s'), 'seg');

            await service.uploadDirectory(makeS3Config(), tmpDir, 'master.m3u8');

            const calls = mockFPutObject.mock.calls;
            const m3u8Call = calls.find((c: any[]) => c[1] === 'master.m3u8');
            expect(m3u8Call?.[3]).toEqual({ 'Content-Type': 'application/vnd.apple.mpegurl' });

            const mp4Call = calls.find((c: any[]) => c[1] === 'stream_0/init.mp4');
            expect(mp4Call?.[3]).toEqual({ 'Content-Type': 'video/mp4' });

            const m4sCall = calls.find((c: any[]) => c[1] === 'stream_0/segment_000.m4s');
            expect(m4sCall?.[3]).toEqual({ 'Content-Type': 'video/iso.segment' });
        });

        it('should apply pathPrefix to object keys', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');
            mkdirSync(join(tmpDir, 'stream_0'), { recursive: true });
            writeFileSync(join(tmpDir, 'stream_0', 'playlist.m3u8'), '#EXTM3U');

            const result = await service.uploadDirectory(
                makeS3Config({ pathPrefix: 'videos/project-1' }),
                tmpDir,
                'master.m3u8',
            );

            expect(result.masterPlaylistKey).toBe('videos/project-1/master.m3u8');
            expect(result.keys).toContain('videos/project-1/master.m3u8');
            expect(result.keys).toContain('videos/project-1/stream_0/playlist.m3u8');
        });

        it('should strip trailing slashes from pathPrefix', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');

            const result = await service.uploadDirectory(
                makeS3Config({ pathPrefix: 'prefix/' }),
                tmpDir,
                'master.m3u8',
            );

            expect(result.masterPlaylistKey).toBe('prefix/master.m3u8');
        });

        /**
         * A key may begin with '/', but it is an empty first path segment rather
         * than a root: clients drop it when signing, public URLs render it as
         * '//', and the two spellings then disagree about naming one object. A
         * prefix typed as '/videos' put every key in that state, and renaming the
         * prefix to escape it failed as a copy onto itself.
         */
        it('should strip a leading slash from pathPrefix', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');
            mkdirSync(join(tmpDir, 'stream_0'), { recursive: true });
            writeFileSync(join(tmpDir, 'stream_0', 'playlist.m3u8'), '#EXTM3U');

            const result = await service.uploadDirectory(
                makeS3Config({ pathPrefix: '/videos' }),
                tmpDir,
                'master.m3u8',
            );

            expect(result.masterPlaylistKey).toBe('videos/master.m3u8');
            expect(result.keys).toContain('videos/stream_0/playlist.m3u8');
            expect(result.keys.every((k) => !k.startsWith('/'))).toBe(true);
        });

        it('should collapse doubled separators in pathPrefix', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');

            const result = await service.uploadDirectory(
                makeS3Config({ pathPrefix: '//videos//project-1//' }),
                tmpDir,
                'master.m3u8',
            );

            expect(result.masterPlaylistKey).toBe('videos/project-1/master.m3u8');
        });

        it('should treat a prefix of only slashes as no prefix', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');

            const result = await service.uploadDirectory(
                makeS3Config({ pathPrefix: '/' }),
                tmpDir,
                'master.m3u8',
            );

            expect(result.masterPlaylistKey).toBe('master.m3u8');
        });

        it('should report progress via onProgress callback', async () => {
            writeFileSync(join(tmpDir, 'a.m3u8'), 'a');
            writeFileSync(join(tmpDir, 'b.mp4'), 'b');
            writeFileSync(join(tmpDir, 'c.m4s'), 'c');

            const progressValues: number[] = [];
            await service.uploadDirectory(
                makeS3Config(),
                tmpDir,
                'a.m3u8',
                { onProgress: (p) => progressValues.push(p) },
            );

            expect(progressValues).toHaveLength(3);
            expect(progressValues[0]).toBe(33);
            expect(progressValues[1]).toBe(67);
            expect(progressValues[2]).toBe(100);
        });

        it('should handle empty output directory', async () => {
            const result = await service.uploadDirectory(
                makeS3Config(),
                tmpDir,
                'master.m3u8',
            );

            expect(result.keys).toEqual([]);
            expect(result.masterPlaylistKey).toBe('');
            expect(mockFPutObject).not.toHaveBeenCalled();
        });

        it('should throw when fPutObject fails', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');
            mockFPutObject.mockRejectedValue(new Error('Access denied'));

            await expect(
                service.uploadDirectory(makeS3Config(), tmpDir, 'master.m3u8'),
            ).rejects.toThrow('S3 upload failed for master.m3u8: Access denied');
        });

        it('should upload to the correct bucket', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U');

            await service.uploadDirectory(
                makeS3Config({ bucket: 'my-bucket' }),
                tmpDir,
                'master.m3u8',
            );

            expect(mockFPutObject).toHaveBeenCalledWith(
                'my-bucket',
                'master.m3u8',
                expect.any(String),
                expect.any(Object),
            );
        });
    });

    describe('uploadFile', () => {
        it('should upload file with correct content type using fPutObject', async () => {
            const client = new (MockClient as any)();

            await service.uploadFile(client, 'my-bucket', '/tmp/sprite.webp', 'thumbnails/sprite.webp');

            expect(mockFPutObject).toHaveBeenCalledWith(
                'my-bucket',
                'thumbnails/sprite.webp',
                '/tmp/sprite.webp',
                { 'Content-Type': 'image/webp' },
            );
        });

        it('should log debug message after upload', async () => {
            const debugSpy = vi.spyOn((service as any).logger, 'debug');
            const client = new (MockClient as any)();

            await service.uploadFile(client, 'my-bucket', '/tmp/file.m3u8', 'output/file.m3u8');

            expect(debugSpy).toHaveBeenCalledWith('Uploaded: output/file.m3u8');
        });
    });
});
