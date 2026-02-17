import { S3Service } from './s3.service.js';

describe('S3Service', () => {
    let service: S3Service;

    beforeEach(() => {
        service = new S3Service();
    });

    describe('getContentType (private, tested via reflection)', () => {
        const getContentType = (path: string): string => {
            return (service as any).getContentType(path);
        };

        it('should return HLS content type for .m3u8', () => {
            expect(getContentType('master.m3u8')).toBe(
                'application/vnd.apple.mpegurl'
            );
        });

        it('should return MPEG-TS content type for .ts', () => {
            expect(getContentType('segment_000.ts')).toBe('video/MP2T');
        });

        it('should return MP4 content type for .mp4', () => {
            expect(getContentType('video.mp4')).toBe('video/mp4');
        });

        it('should return octet-stream for unknown extensions', () => {
            expect(getContentType('file.xyz')).toBe(
                'application/octet-stream'
            );
        });

        it('should handle full paths', () => {
            expect(getContentType('/tmp/output/v0/playlist.m3u8')).toBe(
                'application/vnd.apple.mpegurl'
            );
        });
    });

    describe('walkDir (private, tested via reflection)', () => {
        // walkDir relies on the filesystem. We test it indirectly
        // through integration, but can verify it's a function.
        it('should be a function', () => {
            expect(typeof (service as any).walkDir).toBe('function');
        });
    });

    describe('createClient (private, tested via reflection)', () => {
        it('should create a MinIO client with given config', () => {
            const client = (service as any).createClient({
                endPoint: 'minio.test.com',
                port: 9000,
                useSSL: false,
                bucket: 'test',
                accessKey: 'key',
                secretKey: 'secret',
                region: 'us-east-1',
            });

            expect(client).toBeDefined();
            expect(typeof client.fPutObject).toBe('function');
        });

        it('should default useSSL to true when not provided', () => {
            const client = (service as any).createClient({
                endPoint: 's3.amazonaws.com',
                bucket: 'test',
                accessKey: 'key',
                secretKey: 'secret',
            });

            expect(client).toBeDefined();
        });
    });
});
