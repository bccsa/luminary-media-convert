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

        sessionService = new SessionService();
        probeService = { probe: vi.fn() } as any;

        process.env.WORK_DIR = '/tmp/tus-test-work';

        service = new TusUploadService(sessionService, probeService);
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

        it('should reject unknown upload token', async () => {
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo('Bearer bad_token');

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Invalid or expired upload token',
            });
        });

        it('should allow valid Bearer token', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.value.onIncomingRequest;
            const req = makeRequestInfo(`Bearer ${session.uploadToken}`);

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

        it('should fall back to copyFile when rename fails', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as Mock).mockResolvedValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });
            mockRename.mockRejectedValueOnce(new Error('EXDEV: cross-device link'));

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

    describe('handle', () => {
        it('should delegate to tusdServer.handle', () => {
            const req = {} as any;
            const res = {} as any;

            service.handle(req, res);

            expect(mockHandle).toHaveBeenCalledWith(req, res);
        });
    });
});
