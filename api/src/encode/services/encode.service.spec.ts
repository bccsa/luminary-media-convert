import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeService } from './encode.service.js';
import { SessionService } from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { EncryptionService } from './encryption.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { S3Service } from './s3.service.js';
import { WebhookService } from './webhook.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

function makeConfig(): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
        webhook: {
            url: 'https://example.com/webhook',
            sessionToken: 'tok',
        },
    };
}

function makeEncodeConfig(): EncodeConfigDto {
    return {
        type: 'video',
        segmentDuration: 6,
        videoRenditions: [
            { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
        ],
        audioGroups: [
            { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
        ],
    };
}

describe('EncodeService', () => {
    let service: EncodeService;
    let sessionService: SessionService;
    let ffmpegService: jest.Mocked<FfmpegService>;
    let encryptionService: jest.Mocked<EncryptionService>;
    let thumbnailService: jest.Mocked<ThumbnailService>;
    let s3Service: jest.Mocked<S3Service>;
    let webhookService: jest.Mocked<WebhookService>;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService();

        ffmpegService = {
            encode: jest.fn().mockResolvedValue({
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [{ name: 'Default', filename: 'master.m3u8' }],
            }),
        } as any;

        encryptionService = {
            encryptHlsOutput: jest.fn().mockReturnValue({
                key: Buffer.alloc(16, 0xcd),
                iv: Buffer.alloc(16, 0xab),
            }),
        } as any;

        thumbnailService = {
            generateThumbnails: jest.fn().mockResolvedValue({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            }),
        } as any;

        s3Service = {
            uploadDirectory: jest.fn().mockResolvedValue({
                keys: ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts'],
                masterPlaylistKey: 'master.m3u8',
            }),
        } as any;

        webhookService = {
            send: jest.fn().mockResolvedValue(undefined),
        } as any;

        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            s3Service,
            webhookService,
        );
    });

    afterEach(() => {
        try {
            rmSync(testWorkDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
        delete process.env.WORK_DIR;
    });

    it('should skip processing for unknown session', async () => {
        await service.processSession('nonexistent');

        expect(ffmpegService.encode).not.toHaveBeenCalled();
        expect(s3Service.uploadDirectory).not.toHaveBeenCalled();
    });

    it('should fail when session has no encode config', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('No encoding configuration provided');
    });

    it('should run full pipeline: encode -> s3 -> completed', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledTimes(1);
        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: session.id,
                inputPath: '/tmp/input.mp4',
                encodeConfig: expect.objectContaining({ type: 'video' }),
            }),
        );

        expect(s3Service.uploadDirectory).toHaveBeenCalledTimes(1);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(updated.files).toEqual([
            'master.m3u8',
            'v0/playlist.m3u8',
            'v0/segment_000.ts',
        ]);
        expect(updated.masterPlaylist).toBe('master.m3u8');
    });

    it('should send encoding started webhook', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                sessionId: session.id,
                status: 'encoding',
                progress: 0,
            }),
        );
    });

    it('should send completed webhook with files', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'completed',
                files: ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts'],
                masterPlaylist: 'master.m3u8',
            }),
        );
    });

    it('should pass byteRange from session config to ffmpeg', async () => {
        const config = makeConfig();
        config.byteRange = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
            }),
        );
    });

    it('should default byteRange to undefined when not set in session config', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: undefined,
            }),
        );
    });

    it('should mark session as failed when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg exited with code 1'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('FFmpeg exited with code 1');
    });

    it('should send failure webhook when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg crashed'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'failed',
                error: 'FFmpeg crashed',
            }),
        );
    });

    it('should mark session as failed when S3 upload errors', async () => {
        s3Service.uploadDirectory.mockRejectedValue(
            new Error('S3 connection refused'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('S3 connection refused');
    });

    it('should update status through encoding phases', async () => {
        const statuses: string[] = [];
        const origUpdateStatus = sessionService.updateStatus.bind(sessionService);
        jest.spyOn(sessionService, 'updateStatus').mockImplementation(
            (id, status) => {
                statuses.push(status);
                origUpdateStatus(id, status);
            },
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(statuses).toContain('encoding');
        expect(statuses).toContain('uploading_to_s3');
    });

    it('should include audio-only angle playlist in completed session and webhook', async () => {
        ffmpegService.encode.mockResolvedValue({
            outputDir: '/tmp/output',
            masterPlaylist: 'master.m3u8',
            anglePlaylists: [
                { name: 'Video', filename: 'master.m3u8' },
                { name: 'Audio only', filename: 'audio_only.m3u8' },
            ],
        });
        s3Service.uploadDirectory.mockResolvedValue({
            keys: ['master.m3u8', 'audio_only.m3u8', 'stream_720p/playlist.m3u8', 'stream_HD_Audio/playlist.m3u8'],
            masterPlaylistKey: 'master.m3u8',
        });

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(updated.masterPlaylist).toBe('master.m3u8');
        expect(updated.anglePlaylists).toEqual([
            { name: 'Video', key: 'master.m3u8' },
            { name: 'Audio only', key: 'audio_only.m3u8' },
        ]);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'completed',
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [
                    { name: 'Video', key: 'master.m3u8' },
                    { name: 'Audio only', key: 'audio_only.m3u8' },
                ],
            }),
        );
    });

    it('should pass preByteRangeHook when encryption is enabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                preByteRangeHook: expect.any(Function),
            }),
        );
    });

    it('should call encryptionService.encryptHlsOutput via preByteRangeHook', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const hook = ffmpegService.encode.mock.calls[0][0].preByteRangeHook!;
        hook('/tmp/output');

        expect(encryptionService.encryptHlsOutput).toHaveBeenCalledWith(
            '/tmp/output',
            session.id,
            'https://myapp.example.com/keys/abc',
        );
    });

    it('should not pass preByteRangeHook when encryption is disabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: false,
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                preByteRangeHook: undefined,
            }),
        );
    });

    it('should not pass preByteRangeHook when no encryption config provided', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                preByteRangeHook: undefined,
            }),
        );
    });

    it('should store encryptionKey and previewPlaylists on session when encryption is used', async () => {
        const encryptionKey = Buffer.alloc(16, 0xcd);
        encryptionService.encryptHlsOutput.mockReturnValue({
            key: encryptionKey,
            iv: Buffer.alloc(16, 0xab),
        });

        ffmpegService.encode.mockImplementation(async (opts) => {
            if (opts.preByteRangeHook) {
                opts.preByteRangeHook(opts.outputDir);
            }
            return {
                outputDir: opts.outputDir,
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [{ name: 'Default', filename: 'master.m3u8' }],
            };
        });

        const mockPlaylists = { 'master.m3u8': '#EXTM3U\n' };
        jest.spyOn(service as any, 'collectPlaylists').mockReturnValue(mockPlaylists);

        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.encryptionKey).toEqual(encryptionKey);
        expect(updated.previewPlaylists).toEqual(mockPlaylists);
    });

    it('should not store encryptionKey when no encryption', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.encryptionKey).toBeUndefined();
    });

    it('should preserve byteRange when encryption is enabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: undefined,
                preByteRangeHook: expect.any(Function),
            }),
        );
    });

    it('should call thumbnailService for video encodes by default', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());
        sessionService.setProbeResult(session.id, {
            format: { duration: 120, bitrateKbps: 5000, formatName: 'matroska' },
            videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 24 }],
            audioTracks: [],
        });

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).toHaveBeenCalledWith(
            expect.objectContaining({
                inputPath: '/tmp/input.mp4',
                duration: 120,
                sourceWidth: 1920,
                sourceHeight: 1080,
            }),
        );
    });

    it('should not call thumbnailService when thumbnails is false', async () => {
        const config = makeConfig();
        (config as any).thumbnails = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).not.toHaveBeenCalled();
    });

    it('should not call thumbnailService for audio-only encodes', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, {
            type: 'audio',
            audioGroups: [
                { id: 'main', label: 'Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
            ],
        });

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).not.toHaveBeenCalled();
    });

    it('should complete session even when thumbnail generation fails', async () => {
        thumbnailService.generateThumbnails.mockRejectedValue(
            new Error('FFmpeg thumbnail error'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(updated.thumbnailsVtt).toBeUndefined();
    });

    it('should include thumbnailsVtt in completed session and webhook', async () => {
        s3Service.uploadDirectory.mockResolvedValue({
            keys: ['master.m3u8', 'v0/playlist.m3u8', 'thumbnails/thumbnails.vtt', 'thumbnails/sprite_001.webp'],
            masterPlaylistKey: 'master.m3u8',
        });

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.thumbnailsVtt).toBe('thumbnails/thumbnails.vtt');

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'completed',
                thumbnailsVtt: 'thumbnails/thumbnails.vtt',
            }),
        );
    });

    it('should not throw even when everything fails', async () => {
        ffmpegService.encode.mockRejectedValue(new Error('fail'));
        webhookService.send.mockRejectedValue(new Error('webhook fail'));

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await expect(
            service.processSession(session.id),
        ).resolves.toBeUndefined();
    });
});
