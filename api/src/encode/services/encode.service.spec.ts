import { type Mocked } from 'vitest';
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
import { SegmentPipelineService, type SegmentPipeline } from './segment-pipeline.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

function makeMockPipeline(keys: string[] = ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts']): SegmentPipeline {
    return {
        start: vi.fn(),
        drain: vi.fn().mockResolvedValue(keys),
        abort: vi.fn(),
        uploadRemainingFiles: vi.fn().mockResolvedValue([]),
        get error() { return null; },
        get keys() { return keys; },
    } as any;
}

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
    let ffmpegService: Mocked<FfmpegService>;
    let encryptionService: Mocked<EncryptionService>;
    let thumbnailService: Mocked<ThumbnailService>;
    let s3Service: Mocked<S3Service>;
    let webhookService: Mocked<WebhookService>;
    let segmentPipelineService: Mocked<SegmentPipelineService>;
    let mockPipeline: SegmentPipeline;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService({ emit: () => {} } as any);

        ffmpegService = {
            encode: vi.fn().mockResolvedValue({
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [{ name: 'Default', filename: 'master.m3u8' }],
            }),
        } as any;

        encryptionService = {
            encryptHlsOutput: vi.fn().mockResolvedValue({
                key: Buffer.alloc(16, 0xcd),
                iv: Buffer.alloc(16, 0xab),
            }),
            deriveKey: vi.fn().mockReturnValue(Buffer.alloc(16, 0xcd)),
            generateSalt: vi.fn().mockReturnValue(Buffer.alloc(16, 0xaa)),
            generateIV: vi.fn().mockReturnValue(Buffer.alloc(16, 0xab)),
            encryptSegment: vi.fn().mockResolvedValue(undefined),
            injectKeyTagsIntoPlaylists: vi.fn().mockResolvedValue(undefined),
        } as any;

        thumbnailService = {
            generateThumbnails: vi.fn().mockResolvedValue({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            }),
        } as any;

        s3Service = {
            uploadDirectory: vi.fn().mockResolvedValue({
                keys: ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts'],
                masterPlaylistKey: 'master.m3u8',
            }),
        } as any;

        webhookService = {
            send: vi.fn().mockResolvedValue(undefined),
        } as any;

        mockPipeline = makeMockPipeline();

        segmentPipelineService = {
            createPipeline: vi.fn().mockReturnValue(mockPipeline),
        } as any;

        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            s3Service,
            webhookService,
            segmentPipelineService,
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
        expect(segmentPipelineService.createPipeline).not.toHaveBeenCalled();
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

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledTimes(1);
        expect(mockPipeline.start).toHaveBeenCalledTimes(1);
        expect(mockPipeline.drain).toHaveBeenCalledTimes(1);

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

    it('should always pass byteRange: false to ffmpeg (pipeline handles byte-range)', async () => {
        const config = makeConfig();
        config.byteRange = true;
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

    it('should pass session byteRange config to the pipeline', async () => {
        const config = makeConfig();
        config.byteRange = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
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

    it('should mark session as failed when pipeline drain errors', async () => {
        (mockPipeline.drain as ReturnType<typeof vi.fn>).mockRejectedValue(
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
        vi.spyOn(sessionService, 'updateStatus').mockImplementation(
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
        mockPipeline = makeMockPipeline(['master.m3u8', 'audio_only.m3u8', 'stream_720p/playlist.m3u8', 'stream_HD_Audio/playlist.m3u8']);
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockReturnValue(mockPipeline);

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

    it('should pre-compute encryption materials and pass to pipeline when encryption is enabled', async () => {
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

        expect(encryptionService.deriveKey).toHaveBeenCalled();
        expect(encryptionService.generateSalt).toHaveBeenCalled();
        expect(encryptionService.generateIV).toHaveBeenCalled();

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: expect.any(Buffer),
                encryptionIV: expect.any(Buffer),
            }),
        );
    });

    it('should inject key tags into playlists after drain when encryption is enabled', async () => {
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

        expect(encryptionService.injectKeyTagsIntoPlaylists).toHaveBeenCalledWith(
            expect.any(String),
            'https://myapp.example.com/keys/abc',
            expect.any(Buffer),
        );
    });

    it('should not set encryption materials on pipeline when encryption is disabled', async () => {
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

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: undefined,
                encryptionIV: undefined,
            }),
        );
    });

    it('should not set encryption materials when no encryption config provided', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: undefined,
                encryptionIV: undefined,
            }),
        );
    });

    it('should send encryptionKeyHex in webhook when encryption is used', async () => {
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

        // Verify encryptionKeyHex was sent in the completion webhook
        expect(webhookService.send).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.objectContaining({
                status: 'completed',
                encryptionKeyHex: expect.any(String),
            }),
        );
    });

    it('should pass encryption config to pipeline when encryption is enabled', async () => {
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

        // FFmpeg always gets byteRange: false, no preByteRangeHook (pipeline handles both)
        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
                preByteRangeHook: undefined,
            }),
        );

        // Pipeline should receive encryption key/IV
        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: expect.any(Buffer),
                encryptionIV: expect.any(Buffer),
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
        mockPipeline = makeMockPipeline(['master.m3u8', 'v0/playlist.m3u8', 'thumbnails/thumbnails.vtt', 'thumbnails/sprite_001.webp']);
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockReturnValue(mockPipeline);

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

    it('should complete session even when work directory does not exist for cleanup', async () => {
        // Point WORK_DIR to a non-existent path; rm with force:true won't throw
        process.env.WORK_DIR = '/tmp/nonexistent-luminary-test-cleanup';
        // Re-create service so it picks up the new WORK_DIR
        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            s3Service,
            webhookService,
            segmentPipelineService,
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
    });

    it('should invoke pipeline onProgress and update session pipeline progress', async () => {
        let capturedOnProgress: ((update: any) => void) | undefined;
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockImplementation(
            (opts: any) => {
                capturedOnProgress = opts.onProgress;
                return mockPipeline;
            },
        );

        const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(capturedOnProgress).toBeDefined();
        // Invoke the pipeline onProgress callback with encrypting/uploading values
        capturedOnProgress!({ encrypting: 30, uploading: 20 });

        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({
                encrypting: 30,
                uploading: 20,
            }),
        );
    });

    it('should invoke encoding onProgress and send webhooks at 5% intervals', async () => {
        let capturedOnProgress: ((percent: number) => void) | undefined;
        ffmpegService.encode.mockImplementation(async (opts: any) => {
            capturedOnProgress = opts.onProgress;
            return {
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                anglePlaylists: [{ name: 'Default', filename: 'master.m3u8' }],
            };
        });

        const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(capturedOnProgress).toBeDefined();

        // Reset webhook call count after processSession completed
        webhookService.send.mockClear();
        updateSpy.mockClear();

        // 10% — should trigger webhook (10 % 5 < 1 => 0 < 1 => true)
        capturedOnProgress!(10);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 10 }),
        );
        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                sessionId: session.id,
                status: 'encoding',
                progress: 10,
            }),
        );

        webhookService.send.mockClear();

        // 3% — should NOT trigger webhook (3 % 5 = 3, 3 < 1 => false)
        capturedOnProgress!(3);
        expect(webhookService.send).not.toHaveBeenCalled();

        webhookService.send.mockClear();

        // 99% — should trigger webhook (percent >= 99)
        capturedOnProgress!(99);
        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                sessionId: session.id,
                status: 'encoding',
                progress: 99,
            }),
        );
    });

    it('should warn but not throw when cleanup fails', async () => {
        // Point WORK_DIR to /dev/null — rm recursive on a device file triggers ENOTDIR
        process.env.WORK_DIR = '/dev/null';
        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            s3Service,
            webhookService,
            segmentPipelineService,
        );

        const loggerWarnSpy = vi.spyOn((service as any).logger, 'warn');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(loggerWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to clean up session'),
        );
    });

    it('should throw when pipeline.error is set after FFmpeg completes', async () => {
        const errorPipeline = {
            start: vi.fn(),
            drain: vi.fn().mockResolvedValue([]),
            abort: vi.fn(),
            uploadRemainingFiles: vi.fn().mockResolvedValue([]),
            get error() { return new Error('Pipeline segment upload failed'); },
            get keys() { return []; },
        } as any;
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockReturnValue(errorPipeline);

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('Pipeline segment upload failed');
    });
});
