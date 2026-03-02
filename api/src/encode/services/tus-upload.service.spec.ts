import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';

let capturedServerConfig: any;
const mockCleanUpExpiredUploads = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
const mockHandle = jest.fn();

jest.mock('@tus/server', () => ({
    Server: jest.fn().mockImplementation((config: any) => {
        capturedServerConfig = config;
        return {
            cleanUpExpiredUploads: mockCleanUpExpiredUploads,
            on: mockOn,
            handle: mockHandle,
        };
    }),
    EVENTS: { POST_CREATE: 'POST_CREATE' },
}));

jest.mock('@tus/file-store', () => ({
    FileStore: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        mkdirSync: jest.fn(),
        renameSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        unlinkSync: jest.fn(),
        copyFileSync: jest.fn(),
    };
});

import { TusUploadService } from './tus-upload.service.js';
import { mkdirSync, renameSync, existsSync, unlinkSync } from 'fs';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockRenameSync = renameSync as jest.MockedFunction<typeof renameSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>;

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

function makeHeaders(authHeader?: string): Headers {
    const h = new Headers();
    if (authHeader) h.set('authorization', authHeader);
    return h;
}

describe('TusUploadService', () => {
    let service: TusUploadService;
    let sessionService: SessionService;
    let probeService: ProbeService;

    beforeEach(() => {
        capturedServerConfig = undefined;
        jest.clearAllMocks();

        sessionService = new SessionService();
        probeService = { probe: jest.fn() } as any;

        process.env.WORK_DIR = '/tmp/tus-test-work';

        service = new TusUploadService(sessionService, probeService);
        service.onModuleInit();
    });

    afterEach(() => {
        delete process.env.WORK_DIR;
    });

    describe('onIncomingRequest', () => {
        it('should reject missing Authorization header', async () => {
            const hook = capturedServerConfig.onIncomingRequest;
            const req = { headers: makeHeaders() };

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Missing or invalid Authorization header',
            });
        });

        it('should reject non-Bearer scheme', async () => {
            const hook = capturedServerConfig.onIncomingRequest;
            const req = { headers: makeHeaders('Basic abc123') };

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Missing or invalid Authorization header',
            });
        });

        it('should reject empty Bearer token', async () => {
            const hook = capturedServerConfig.onIncomingRequest;
            // Bypass Headers trimming by providing a raw object with get()
            const req = {
                headers: { get: (name: string) => name === 'authorization' ? 'Bearer ' : null },
            };

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Empty bearer token',
            });
        });

        it('should reject unknown upload token', async () => {
            const hook = capturedServerConfig.onIncomingRequest;
            const req = { headers: makeHeaders('Bearer bad_token') };

            await expect(hook(req)).rejects.toEqual({
                status_code: 401,
                body: 'Invalid or expired upload token',
            });
        });

        it('should allow valid Bearer token', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.onIncomingRequest;
            const req = { headers: makeHeaders(`Bearer ${session.uploadToken}`) };

            await expect(hook(req)).resolves.toBeUndefined();
        });
    });

    describe('onUploadCreate', () => {
        it('should set session status to uploading', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.onUploadCreate;

            const result = await hook({}, { metadata: { sessionId: session.id } });

            expect(result).toEqual({});
            expect(sessionService.get(session.id)!.status).toBe('uploading');
        });

        it('should reject unknown session', async () => {
            const hook = capturedServerConfig.onUploadCreate;

            await expect(
                hook({}, { metadata: { sessionId: 'nonexistent' } }),
            ).rejects.toEqual({
                status_code: 404,
                body: 'Session nonexistent not found',
            });
        });

        it('should reject session not in created/uploading status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');
            const hook = capturedServerConfig.onUploadCreate;

            await expect(
                hook({}, { metadata: { sessionId: session.id } }),
            ).rejects.toEqual({
                status_code: 400,
                body: `Session is not accepting uploads (current status: encoding)`,
            });
        });

        it('should allow partial uploads without metadata', async () => {
            const hook = capturedServerConfig.onUploadCreate;

            const result = await hook({}, { metadata: {} });

            expect(result).toEqual({});
        });

        it('should allow session in uploading status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');
            const hook = capturedServerConfig.onUploadCreate;

            const result = await hook({}, { metadata: { sessionId: session.id } });

            expect(result).toEqual({});
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
            (probeService.probe as jest.Mock).mockReturnValue(probeResult);

            const hook = capturedServerConfig.onUploadFinish;
            const upload = {
                id: 'upload-1',
                metadata: { sessionId: session.id, filename: 'video.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-1' },
            };

            const result = await hook({}, upload);

            expect(result).toEqual({});
            expect(mockRenameSync).toHaveBeenCalledWith(
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
            (probeService.probe as jest.Mock).mockReturnValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const hook = capturedServerConfig.onUploadFinish;
            const upload = {
                id: 'upload-2',
                metadata: { sessionId: session.id },
                storage: { path: '/tmp/tus-uploads/upload-2' },
            };

            await hook({}, upload);

            expect(mockRenameSync).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-2',
                expect.stringContaining('/input'),
            );
        });

        it('should handle partial upload completion (no sessionId)', async () => {
            const hook = capturedServerConfig.onUploadFinish;

            const result = await hook({}, { metadata: {}, storage: { path: '/tmp/x' } });

            expect(result).toEqual({});
            expect(probeService.probe).not.toHaveBeenCalled();
        });

        it('should return early when storage path is missing', async () => {
            const session = sessionService.create(makeConfig());
            const hook = capturedServerConfig.onUploadFinish;

            const result = await hook({}, {
                id: 'upload-3',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
                storage: {},
            });

            expect(result).toEqual({});
            expect(probeService.probe).not.toHaveBeenCalled();
        });

        it('should clean up tus metadata sidecar when it exists', async () => {
            const session = sessionService.create(makeConfig());
            (probeService.probe as jest.Mock).mockReturnValue({
                format: { duration: 10, bitrateKbps: 1000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });
            mockExistsSync.mockReturnValue(true);

            const hook = capturedServerConfig.onUploadFinish;
            await hook({}, {
                id: 'upload-4',
                metadata: { sessionId: session.id, filename: 'test.mp4' },
                storage: { path: '/tmp/tus-uploads/upload-4' },
            });

            expect(mockUnlinkSync).toHaveBeenCalledWith(
                '/tmp/tus-uploads/upload-4.json',
            );
        });

        // Dynamic import('fs') in the cross-device fallback path requires
        // --experimental-vm-modules which is not available in standard Jest.
    });

    describe('onModuleDestroy', () => {
        it('should call cleanUpExpiredUploads', async () => {
            await service.onModuleDestroy();

            expect(mockCleanUpExpiredUploads).toHaveBeenCalledTimes(1);
        });

        it('should not throw when cleanup fails', async () => {
            mockCleanUpExpiredUploads.mockRejectedValueOnce(new Error('cleanup error'));

            await expect(service.onModuleDestroy()).resolves.toBeUndefined();
        });
    });

    describe('handle', () => {
        it('should delegate to tusServer.handle', () => {
            const req = {} as any;
            const res = {} as any;

            service.handle(req, res);

            expect(mockHandle).toHaveBeenCalledWith(req, res);
        });
    });
});
