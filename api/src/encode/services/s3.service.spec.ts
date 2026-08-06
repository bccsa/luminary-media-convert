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
            expect(getContentType('master.m3u8')).toBe(
                'application/vnd.apple.mpegurl'
            );
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
            expect(getContentType('/tmp/output/v0/playlist.m3u8')).toBe(
                'application/vnd.apple.mpegurl'
            );
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

    describe('createClient (private)', () => {
        it('should create a MinIO client with given config', () => {
            (service as any).createClient(
                makeS3Config({
                    port: 9000,
                    useSSL: false,
                    region: 'us-east-1',
                })
            );

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
                expect.objectContaining({ useSSL: true })
            );
        });

        it('should respect useSSL: false', () => {
            (service as any).createClient(makeS3Config({ useSSL: false }));

            expect(minio.Client).toHaveBeenCalledWith(
                expect.objectContaining({ useSSL: false })
            );
        });
    });

    /**
     * These cases previously ran through `uploadDirectory`, which turned out to
     * have no callers — so they were asserting a fix that never reached storage.
     * Kept as direct tests of the helper, which the live upload path in
     * `encode.service` uses to build every key.
     */
    describe('canonicalPrefix', () => {
        it('drops a leading slash', () => {
            // A key may begin with '/', but it is an empty first path segment
            // rather than a root: clients drop it when signing, public URLs
            // render it as '//', and the two spellings then disagree about
            // naming one object.
            expect(S3Service.canonicalPrefix('/videos')).toBe('videos');
        });

        it('drops a trailing slash', () => {
            expect(S3Service.canonicalPrefix('videos/')).toBe('videos');
        });

        it('collapses doubled separators', () => {
            expect(S3Service.canonicalPrefix('//videos//project-1//')).toBe(
                'videos/project-1'
            );
        });

        it('treats a prefix of only slashes as none', () => {
            expect(S3Service.canonicalPrefix('/')).toBe('');
        });

        it('treats a missing prefix as none', () => {
            expect(S3Service.canonicalPrefix(undefined)).toBe('');
        });

        it('leaves an already-canonical prefix alone', () => {
            expect(S3Service.canonicalPrefix('videos/project-1')).toBe(
                'videos/project-1'
            );
        });
    });

    describe('uploadFile', () => {
        it('should upload file with correct content type using fPutObject', async () => {
            const client = new (MockClient as any)();

            await service.uploadFile(
                client,
                'my-bucket',
                '/tmp/sprite.webp',
                'thumbnails/sprite.webp'
            );

            expect(mockFPutObject).toHaveBeenCalledWith(
                'my-bucket',
                'thumbnails/sprite.webp',
                '/tmp/sprite.webp',
                { 'Content-Type': 'image/webp' }
            );
        });

        it('should log debug message after upload', async () => {
            const debugSpy = vi.spyOn((service as any).logger, 'debug');
            const client = new (MockClient as any)();

            await service.uploadFile(
                client,
                'my-bucket',
                '/tmp/file.m3u8',
                'output/file.m3u8'
            );

            expect(debugSpy).toHaveBeenCalledWith('Uploaded: output/file.m3u8');
        });
    });
});

describe('S3Service — Content-Type for encrypted text assets', () => {
    let service: S3Service;
    let dir: string;

    const LMCENC = (body: string): Buffer =>
        Buffer.concat([
            Buffer.from('LMCENC01', 'ascii'),
            Buffer.alloc(16, 0x11), // IV
            Buffer.from(body),
        ]);

    beforeEach(() => {
        service = new S3Service();
        dir = mkdtempSync(join(tmpdir(), 'lmcenc-ct-'));
        mockFPutObject.mockReset();
        mockFPutObject.mockResolvedValue(undefined);
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function contentTypeOf(name: string, body: Buffer | string): Promise<string> {
        const path = join(dir, name);
        writeFileSync(path, body);
        return service.resolveContentType(path);
    }

    it('stores an encrypted playlist as octet-stream', async () => {
        // Anything that reads the extension and decides to transcode the
        // charset or gzip the body corrupts the ciphertext for every viewer.
        expect(await contentTypeOf('master.m3u8', LMCENC('cipher'))).toBe(
            'application/octet-stream',
        );
    });

    it('stores an encrypted VTT as octet-stream', async () => {
        expect(await contentTypeOf('chapters.vtt', LMCENC('cipher'))).toBe(
            'application/octet-stream',
        );
    });

    it('leaves plaintext playlists and VTTs as they were', async () => {
        expect(await contentTypeOf('master.m3u8', '#EXTM3U\n')).toBe(
            'application/vnd.apple.mpegurl',
        );
        expect(await contentTypeOf('chapters.vtt', 'WEBVTT\n')).toBe('text/vtt');
    });

    it('does not sniff files that were never text assets', async () => {
        expect(await contentTypeOf('segment_000.m4s', LMCENC('x'))).toBe(
            'video/iso.segment',
        );
    });

    it('falls back to the extension when the file cannot be read', async () => {
        expect(
            await service.resolveContentType(join(dir, 'missing.m3u8')),
        ).toBe('application/vnd.apple.mpegurl');
    });

    it('uploads an encrypted playlist with the sniffed content type', async () => {
        const path = join(dir, 'master.m3u8');
        writeFileSync(path, LMCENC('cipher'));
        const client = new (MockClient as any)();

        await service.uploadFile(client, 'bucket', path, 'out/master.m3u8');

        expect(mockFPutObject).toHaveBeenCalledWith(
            'bucket',
            'out/master.m3u8',
            path,
            { 'Content-Type': 'application/octet-stream' },
        );
    });
});
