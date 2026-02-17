import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeService } from './encode.service.js';
import { SessionService } from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { S3Service } from './s3.service.js';
import { WebhookService } from './webhook.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(): CreateSessionDto {
    return {
        type: 'video',
        renditions: [
            { width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
        ],
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

describe('EncodeService', () => {
    let service: EncodeService;
    let sessionService: SessionService;
    let ffmpegService: jest.Mocked<FfmpegService>;
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
            s3Service,
            webhookService
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

    it('should run full pipeline: encode -> s3 -> completed', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        // FFmpeg was called
        expect(ffmpegService.encode).toHaveBeenCalledTimes(1);
        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: session.id,
                inputPath: '/tmp/input.mp4',
                type: 'video',
            })
        );

        // S3 upload was called
        expect(s3Service.uploadDirectory).toHaveBeenCalledTimes(1);

        // Session marked as completed
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

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                sessionId: session.id,
                status: 'encoding',
                progress: 0,
            })
        );
    });

    it('should send completed webhook with files', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'completed',
                files: ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts'],
                masterPlaylist: 'master.m3u8',
            })
        );
    });

    it('should mark session as failed when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg exited with code 1')
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('FFmpeg exited with code 1');
    });

    it('should send failure webhook when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg crashed')
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/webhook',
            'tok',
            expect.objectContaining({
                status: 'failed',
                error: 'FFmpeg crashed',
            })
        );
    });

    it('should mark session as failed when S3 upload errors', async () => {
        s3Service.uploadDirectory.mockRejectedValue(
            new Error('S3 connection refused')
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

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
            }
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        expect(statuses).toContain('encoding');
        expect(statuses).toContain('uploading_to_s3');
    });

    it('should not throw even when everything fails', async () => {
        ffmpegService.encode.mockRejectedValue(new Error('fail'));
        webhookService.send.mockRejectedValue(new Error('webhook fail'));

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await expect(
            service.processSession(session.id)
        ).resolves.toBeUndefined();
    });
});
