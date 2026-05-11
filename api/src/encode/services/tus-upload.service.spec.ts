import { type Mock } from 'vitest';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';

const {
    mockStart,
    mockStop,
    mockCleanUpExpiredUploads,
    mockHandle,
    capturedServerConfig,
    mockRename,
    mockCopyFile,
    mockUnlink,
    mockMkdir,
    mockAccess,
} = vi.hoisted(() => ({
    mockStart: vi.fn().mockResolvedValue(undefined),
    mockStop: vi.fn().mockResolvedValue(undefined),
    mockCleanUpExpiredUploads: vi.fn().mockResolvedValue(0),
    mockHandle: vi.fn(),
    capturedServerConfig: { value: null as any },
    mockRename: vi.fn().mockResolvedValue(undefined),
    mockCopyFile: vi.fn().mockResolvedValue(undefined),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    // Rejects by default → file does not exist yet → move proceeds normally.
    mockAccess: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

vi.mock('node-tusd', () => ({
    TusdServer: vi.fn().mockImplementation(function (this: any, config: any) {
        capturedServerConfig.value = config;
        this.start = mockStart;
        this.stop = mockStop;
        this.cleanUpExpiredUploads = mockCleanUpExpiredUploads;
        this.handle = mockHandle;
    }),
}));

vi.mock('fs/promises', () => ({
    rename: (...args: any[]) => mockRename(...args),
    copyFile: (...args: any[]) => mockCopyFile(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    access: (...args: any[]) => mockAccess(...args),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        mkdirSync: vi.fn(),
    };
});

import { TusUploadService } from './tus-upload.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
    };
}

function makeRequestInfo(authHeader?: string): { headers: Record<string, string>; method: string; url: string } {
    const headers: Record<string, string> = {};
    if (authHeader) headers['authorization'] = authHeader;
    return { headers, method: 'POST', url: '/api/tus' };
}

describe('TusUploadService', () => {
    let service: TusUploadService;
    let sessionService: SessionService;
    let probeService: ProbeService;

    beforeEach(async () => {
        capturedServerConfig.value = undefined;
        vi.clearAllMocks();

        sessionService = new SessionService({ emit: () => {} } as any);
        probeService = { probe: vi.fn() } as any;
        const webhookService = { send: vi.fn().mockResolvedValue(undefined) } as any;

        process.env.WORK_DIR = '/tmp/tus-test-work';

        const previewService = { init: vi.fn().mockResolvedValue(undefined), destroy: vi.fn().mockResolvedValue(undefined) } as any;
        service = new TusUploadService(sessionService, probeService, previewService, webhookService);
        await service.onModuleInit();
    });

    afterEach(() => {
        delete process.env.WORK_DIR;
    });

    describe('onModuleInit', () => {
        it('should start the tusd server', () => {
            expect(mockStart).toHaveBeenCalledTimes(1);
        });
    });

    describe('onIncomingRequest', () => {
        it('should reject missing Authorization header', async () => {
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo();

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Missing or invalid Authorization header',
            });
        });

        it('should reject non-Bearer scheme', async () => {
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo('Basic abc123');

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Missing or invalid Authorization header',
            });
        });

        it('should reject empty Bearer token', async () => {
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo('Bearer ');

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Empty bearer token',
            });
        });

        it('should reject unknown session token', async () => {
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo('Bearer bad_token');

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Invalid or expired session token',
            });
        });

        it('should allow valid Bearer token', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo(`Bearer ${session.sessionToken}`);

            await expect(hook(req)).resolves.toBeUndefined();
        });
    });

    describe('onUploadCreate', () => {
        it('should set session status to uploading', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onUploadCreate;

            await hook(makeRequestInfo(), { metadata: { sessionId: session.id } });

            expect(sessionService.get(session.id)!.status).toBe('uploading');
        });

        it('should reject unknown session', async () => {
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: { sessionId: 'nonexistent' } }),
            ).rejects.toEqual({
                status_code: 404,
                body: 'Session nonexistent not found',
            });
        });

        it('should reject session not in created/uploading status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: { sessionId: session.id } }),
            ).rejects.toEqual({
                status_code: 400,
                body: `Session is not accepting uploads (current status: encoding)`,
            });
        });

        it('should allow partial uploads without metadata', async () => {
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: {} }),
            ).resolves.toBeUndefined();
        });

        it('should reject unsupported file extensions', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: { sessionId: session.id, filename: 'malware.exe' } }),
            ).rejects.toEqual({
                status_code: 415,
                body: 'Unsupported file type. Allowed: media files (video/audio).',
            });
        });

        it('should allow supported media file extensions', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: { sessionId: session.id, filename: 'video.mp4' } }),
            ).resolves.toBeUndefined();
        });

        it('should allow uploads without filename metadata', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onUploadCreate;

            await expect(
                hook(makeRequestInfo(), { metadata: { sessionId: session.id } }),
            ).resolves.toBeUndefined();
        });

        it('should allow session in uploading status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');
            const hook = capturedServerConfig.value.onUploadCreate;

            await hook(makeRequestInfo(), { metadata: { sessionId: session.id } });

            expect(sessionService.get(session.id)!.status).toBe('uploading');
        });
    });

    describe('onUploadFinish', () => {
        it('should move file, probe it, and update session to uploaded', async () => {
            const session = sessionService.create(makeConfig());
            const probeResult = {
                format: { duration: 60, bitrateKbps: 5000, formatName: 'mp4' },
                videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 30 }],
                audioTracks: [{ index: 0, codec: 'aac', bitrateKbps: 192, channels: 2, sampleRate: 48000 }],
            };
            (probeService.probe as Mock).mockResolvedValue(probeResult);

            const hook = capturedServerConfig.value.onUploadFinish;
            const upload = {
                id: 'upload-1',
                metadata: { sessionId: session.id, filename: 'video.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-1' },
            };

            await hook(makeRequestInfo(), upload);

            expect(mockRename).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-1',
                `/tmp/tus-test-work/${session.id}/video.mp4`,
            );
            expect(probeService.probe).toHaveBeenCalledWith(
                `/tmp/tus-test-work/${session.id}/video.mp4`,
            );
            expect(sessionService.get(session.id)!.status).toBe('uploaded');
            expect(sessionService.get(session.id)!.probeResult).toEqual(probeResult);
            expect(sessionService.get(session.id)!.filePath).toBe(
                `/tmp/tus-test-work/${session.id}/video.mp4`,
            );
        });

        it('should use "input" as default filename when metadata lacks filename', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const hook = capturedServerConfig.value.onUploadFinish;
            const upload = {
                id: 'upload-2',
                metadata: { sessionId: session.id },
                storage: { path: '/tmp/tus-uploads/upload-2' },
            };

            await hook(makeRequestInfo(), upload);

            expect(mockRename).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-2',
                expect.stringContaining('/input'),
            );
        });

        it('should handle partial upload completion (no sessionId)', async () => {
            const hook = capturedServerConfig.value.onUploadFinish;

            await hook(makeRequestInfo(), { metadata: {}, storage: { path: '/tmp/x' } });

            expect(probeService.probe).not.toHaveBeenCalled();
        });

        it('should return early when storage path is missing', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onUploadFinish;

            await hook(makeRequestInfo(), {
                id: 'upload-3',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
            });

            expect(probeService.probe).not.toHaveBeenCalled();
        });

        it('should clean up tusd metadata sidecar (.info)', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const hook = capturedServerConfig.value.onUploadFinish;
            await hook(makeRequestInfo(), {
                id: 'upload-4',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-4' },
            });

            expect(mockUnlink).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-4.info',
            );
        });

        it('should sanitize path traversal in filename', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const hook = capturedServerConfig.value.onUploadFinish;
            await hook(makeRequestInfo(), {
                id: 'upload-traversal',
                metadata: { sessionId: session.id, filename: '../../etc/passwd' },
                storage: { path: '/tmp/tus-uploads/upload-traversal' },
            });

            expect(mockRename).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-traversal',
                `/tmp/tus-test-work/${session.id}/passwd`,
            );
        });

        it('should sanitize filename with directory separators', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const hook = capturedServerConfig.value.onUploadFinish;
            await hook(makeRequestInfo(), {
                id: 'upload-slashes',
                metadata: { sessionId: session.id, filename: 'subdir/file.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-slashes' },
            });

            expect(mockRename).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-slashes',
                `/tmp/tus-test-work/${session.id}/file.mp4`,
            );
        });

        it('should skip move when file is already at destination (idempotency)', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });
            // access resolves → file already exists → rename should be skipped
            mockAccess.mockResolvedValueOnce(undefined);

            const hook = capturedServerConfig.value.onUploadFinish;
            await hook(makeRequestInfo(), {
                id: 'upload-idempotent',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-idempotent' },
            });

            expect(mockRename).not.toHaveBeenCalled();
            expect(mockCopyFile).not.toHaveBeenCalled();
            expect(sessionService.get(session.id)!.status).toBe('uploaded');
        });

        it('should fall back to copyFile when rename fails', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });
            mockRename.mockRejectedValueOnce(
                Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }),
            );

            const hook = capturedServerConfig.value.onUploadFinish;
            await hook(makeRequestInfo(), {
                id: 'upload-5',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-5' },
            });

            expect(mockCopyFile).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-5',
                `/tmp/tus-test-work/${session.id}/test.mp4`,
            );
            expect(mockUnlink).toHaveBeenCalledWith('/tmp/tus-uploads/upload-5');
        });
    });

    describe('onModuleDestroy', () => {
        it('should call cleanUpExpiredUploads and stop', async () => {
            await service.onModuleDestroy();

            expect(mockCleanUpExpiredUploads).toHaveBeenCalledTimes(1);
            expect(mockStop).toHaveBeenCalledTimes(1);
        });

        it('should not throw when cleanup fails', async () => {
            mockCleanUpExpiredUploads.mockRejectedValueOnce(new Error('cleanup error'));

            await expect(service.onModuleDestroy()).resolves.toBeUndefined();
        });

        it('should not throw when stop fails', async () => {
            mockStop.mockRejectedValueOnce(new Error('stop error'));

            await expect(service.onModuleDestroy()).resolves.toBeUndefined();
        });
    });

    describe('finalizeUpload', () => {
        it('runs probe, preview init, status flip, and webhook', async () => {
            const config: CreateSessionDto = {
                ...makeConfig(),
                webhook: { url: 'https://example.com/webhook', sessionToken: 'tok' },
            };
            const session = sessionService.create(config);
            const probeResult = {
                format: { duration: 60, bitrateKbps: 5000, formatName: 'mp4' },
                videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 30 }],
                audioTracks: [{ index: 0, codec: 'aac', bitrateKbps: 192, channels: 2, sampleRate: 48000 }],
            };
            (probeService.probe as Mock).mockResolvedValue(probeResult);
            const previewService = (service as any).previewService;
            const webhookService = (service as any).webhookService;

            await service.finalizeUpload(session.id, '/tmp/destination/video.mp4');

            expect(probeService.probe).toHaveBeenCalledWith('/tmp/destination/video.mp4');
            expect(previewService.init).toHaveBeenCalledWith(session.id);
            const updated = sessionService.get(session.id)!;
            expect(updated.status).toBe('uploaded');
            expect(updated.filePath).toBe('/tmp/destination/video.mp4');
            expect(updated.probeResult).toEqual(probeResult);
            expect(webhookService.send).toHaveBeenCalledWith(
                'https://example.com/webhook',
                'tok',
                expect.objectContaining({ sessionId: session.id, status: 'uploaded' }),
            );
        });

        it('still flips to uploaded when preview init throws', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });
            const previewService = (service as any).previewService;
            previewService.init.mockRejectedValueOnce(new Error('preview boom'));

            await service.finalizeUpload(session.id, '/tmp/destination/audio.mp3');

            expect(sessionService.get(session.id)!.status).toBe('uploaded');
        });
    });

    describe('handle', () => {
        it('should delegate to tusdServer.handle', () => {
            const req = {} as any;
            const res = {} as any;

            service.handle(req, res);

            expect(mockHandle).toHaveBeenCalledWith(req, res);
        });
    });

    describe('periodic cleanup', () => {
        it('should run cleanup on interval and log when uploads are removed', async () => {
            vi.useFakeTimers();
            vi.clearAllMocks();

            // Create a fresh service with fake timers active
            const svc2 = new TusUploadService(sessionService, probeService, { init: vi.fn(), destroy: vi.fn() } as any, { send: vi.fn().mockResolvedValue(undefined) } as any);
            await svc2.onModuleInit();
            mockCleanUpExpiredUploads.mockResolvedValueOnce(3);

            // Advance past the 30-minute interval
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

            // cleanup called once from the interval tick
            expect(mockCleanUpExpiredUploads).toHaveBeenCalled();

            vi.useRealTimers();
        });

        it('should not throw when periodic cleanup fails', async () => {
            vi.useFakeTimers();
            vi.clearAllMocks();

            const svc2 = new TusUploadService(sessionService, probeService, { init: vi.fn(), destroy: vi.fn() } as any, { send: vi.fn().mockResolvedValue(undefined) } as any);
            await svc2.onModuleInit();
            mockCleanUpExpiredUploads.mockRejectedValueOnce(new Error('cleanup failed'));

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

            // Should not throw — just logs
            vi.useRealTimers();
        });
    });

    describe('sendStatusWebhook', () => {
        it('should send webhook when session has webhook config', async () => {
            const config: CreateSessionDto = {
                s3: {
                    endPoint: 's3.example.com',
                    bucket: 'test',
                    accessKey: 'key',
                    secretKey: 'secret',
                },
                webhook: {
                    url: 'https://example.com/webhook',
                    sessionToken: 'tok-123',
                },
            };
            const session = sessionService.create(config);
            const webhookService = (service as any).webhookService;

            const hook = capturedServerConfig.value.onUploadCreate;
            await hook(makeRequestInfo(), { metadata: { sessionId: session.id } });

            expect(webhookService.send).toHaveBeenCalledWith(
                'https://example.com/webhook',
                'tok-123',
                expect.objectContaining({
                    sessionId: session.id,
                    status: 'uploading',
                }),
            );
        });

        it('should not send webhook when session has no webhook config', async () => {
            const session = sessionService.create(makeConfig());
            const webhookService = (service as any).webhookService;

            const hook = capturedServerConfig.value.onUploadCreate;
            await hook(makeRequestInfo(), { metadata: { sessionId: session.id } });

            expect(webhookService.send).not.toHaveBeenCalled();
        });
    });
});
