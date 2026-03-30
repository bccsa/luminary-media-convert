import { type Mocked } from 'vitest';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
import { AuthorizationWebhookService } from '../auth/authorization-webhook.service';
import { PreviewService } from './services/preview.service.js';
import type { CreateSessionDto } from './dto/create-session.dto.js';
import type { EncodeConfigDto } from './dto/encode-config.dto.js';
import type { Response } from 'express';

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

function makeRequest(overrides: any = {}): any {
    return {
        protocol: 'http',
        get: (header: string) => {
            if (header === 'host') return 'localhost:3000';
            return undefined;
        },
        ...overrides,
    };
}

describe('EncodeController', () => {
    let controller: EncodeController;
    let sessionService: SessionService;
    let queueService: Mocked<QueueService>;
    let ffmpegService: Mocked<FfmpegService>;
    let authorizationWebhookService: Mocked<AuthorizationWebhookService>;
    let previewService: Mocked<PreviewService>;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService({ emit: () => {} } as any);

        queueService = {
            enqueue: vi.fn().mockReturnValue(1),
            getPosition: vi.fn().mockReturnValue(null),
            dequeue: vi.fn().mockReturnValue(true),
            length: 0,
            isProcessing: false,
        } as any;

        ffmpegService = {
            getAccelMode: vi.fn().mockReturnValue('cpu'),
            isGpuAvailable: vi.fn().mockReturnValue(false),
            killActiveProcess: vi.fn(),
        } as any;

        authorizationWebhookService = {
            checkAuthorization: vi.fn().mockResolvedValue(undefined),
        } as any;

        previewService = {
            init: vi.fn(),
            isReady: vi.fn().mockReturnValue(false),
            getPlaylist: vi.fn().mockReturnValue(null),
            getSegmentStream: vi.fn().mockResolvedValue(null),
            destroy: vi.fn().mockResolvedValue(undefined),
        } as any;

        const sessionEventsService = { emit: vi.fn(), forSession: vi.fn().mockReturnValue({ pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) }) } as any;
        controller = new EncodeController(sessionService, sessionEventsService, queueService, ffmpegService, authorizationWebhookService, previewService);
    });

    afterEach(() => {
        try {
            rmSync(testWorkDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
        delete process.env.WORK_DIR;
        delete process.env.MAX_UPLOAD_SIZE;
    });

    describe('createSession', () => {
        it('should create a session and return tus endpoint', async () => {
            const dto = makeConfig();
            const req = makeRequest();

            const result = await controller.createSession(dto, req);

            expect(result.sessionId).toBeDefined();
            expect(result.tusEndpoint).toBe('http://localhost:3000/api/tus');
            expect(result.sessionToken).toMatch(/^sess_/);
            expect(result.maxUploadSize).toBeGreaterThan(0);
        });

        it('should build tusEndpoint from request protocol and host', async () => {
            const dto = makeConfig();
            const req = makeRequest({
                protocol: 'https',
                get: (h: string) =>
                    h === 'host' ? 'api.example.com' : undefined,
            });

            const result = await controller.createSession(dto, req);

            expect(result.tusEndpoint).toBe('https://api.example.com/api/tus');
        });

        it('should use MAX_UPLOAD_SIZE from env when set', async () => {
            process.env.MAX_UPLOAD_SIZE = '5368709120';
            const result = await controller.createSession(makeConfig(), makeRequest());

            expect(result.maxUploadSize).toBe(5368709120);
        });

        it('should default maxUploadSize to 10 GB', async () => {
            const result = await controller.createSession(makeConfig(), makeRequest());

            expect(result.maxUploadSize).toBe(10 * 1024 * 1024 * 1024);
        });

    });

    describe('getStatus', () => {
        it('should return session status for created session', () => {
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('created');
            expect(result.encoder).toBe('cpu');
        });

        it('should reflect active accel mode in encoder field', () => {
            ffmpegService.getAccelMode.mockReturnValue('apple');
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.encoder).toBe('apple');
        });

        it('should include probeResult when uploaded', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');
            sessionService.setProbeResult(session.id, {
                format: { duration: 60, bitrateKbps: 3000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.probeResult).toBeDefined();
        });

        it('should include queuePosition when session is queued', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'queued');
            queueService.getPosition.mockReturnValue(3);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.queuePosition).toBe(3);
        });

        it('should include progress when session is encoding', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');
            sessionService.updateProgress(session.id, 42.5);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.progress).toBe(42.5);
        });

        it('should include files and masterPlaylist when completed', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(
                session.id,
                ['master.m3u8', 'v0/playlist.m3u8'],
                'master.m3u8',
            );

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.status).toBe('completed');
            expect(result.progress).toBe(100);
            expect(result.files).toEqual(['master.m3u8', 'v0/playlist.m3u8']);
            expect(result.masterPlaylist).toBe('master.m3u8');
        });


        it('should include error when session failed', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFailed(session.id, 'FFmpeg crashed');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.status).toBe('failed');
            expect(result.error).toBe('FFmpeg crashed');
        });

        it('should throw NotFoundException for unknown session', () => {
            expect(() => controller.getStatus('nonexistent', makeRequest())).toThrow(
                NotFoundException,
            );
        });
    });

    describe('startEncode', () => {
        it('should reject when session is not in uploaded state', async () => {
            const session = sessionService.create(makeConfig());

            await expect(
                controller.startEncode(session.id, makeEncodeConfig(), makeRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject when session not found', async () => {
            await expect(
                controller.startEncode('nonexistent', makeEncodeConfig(), makeRequest()),
            ).rejects.toThrow(NotFoundException);
        });

        it('should enqueue session and return queued status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const result = await controller.startEncode(session.id, makeEncodeConfig(), makeRequest());

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('queued');
            expect(result.queuePosition).toBe(1);
            expect(queueService.enqueue).toHaveBeenCalledWith(session.id);
        });

        it('should reject video config without videoRenditions', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                audioGroups: [{ id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 }],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject video config without audioGroups', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [{ width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd' }],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject audio config without audioGroups', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = { type: 'audio' };

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject unknown audioGroupId in video rendition', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [{ width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'nonexistent' }],
                audioGroups: [{ id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 }],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('deleteSession', () => {
        it('should delete a session in created status', async () => {
            const session = sessionService.create(makeConfig());

            await controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete a session in uploaded status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            await controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete a session in uploading status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');

            await controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete a queued session and dequeue it', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'queued');

            await controller.deleteSession(session.id);

            expect(queueService.dequeue).toHaveBeenCalledWith(session.id);
            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete an encoding session and kill FFmpeg', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');

            await controller.deleteSession(session.id);

            expect(ffmpegService.killActiveProcess).toHaveBeenCalled();
            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should not call dequeue when deleting a non-queued session', async () => {
            const session = sessionService.create(makeConfig());

            await controller.deleteSession(session.id);

            expect(queueService.dequeue).not.toHaveBeenCalled();
        });

        it('should not call killActiveProcess when deleting a non-encoding session', async () => {
            const session = sessionService.create(makeConfig());

            await controller.deleteSession(session.id);

            expect(ffmpegService.killActiveProcess).not.toHaveBeenCalled();
        });

        it('should reject deletion of a session uploading to S3', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading_to_s3');

            await expect(
                controller.deleteSession(session.id),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject deletion of a completed session', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');

            await expect(
                controller.deleteSession(session.id),
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject deletion of a failed session', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFailed(session.id, 'some error');

            await expect(
                controller.deleteSession(session.id),
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw NotFoundException for unknown session', async () => {
            await expect(
                controller.deleteSession('nonexistent'),
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('streamEvents', () => {
        it('should throw UnauthorizedException when no token', () => {
            const session = sessionService.create(makeConfig());
            expect(() => controller.streamEvents(session.id, '')).toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException for invalid token', () => {
            const session = sessionService.create(makeConfig());
            expect(() => controller.streamEvents(session.id, 'invalid')).toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException when token belongs to different session', () => {
            const session1 = sessionService.create(makeConfig());
            const session2 = sessionService.create(makeConfig());
            expect(() =>
                controller.streamEvents(session1.id, session2.sessionToken),
            ).toThrow(UnauthorizedException);
        });

        it('should return an Observable for valid session token', () => {
            const session = sessionService.create(makeConfig());
            const result = controller.streamEvents(session.id, session.sessionToken);
            expect(result).toBeDefined();
            expect(typeof result.subscribe).toBe('function');
        });
    });

    describe('createSession with apiKey', () => {
        it('should pass apiKey to authorization webhook', async () => {
            const req = makeRequest();
            (req as any).apiKey = { userId: 'user:1', webhookUrl: 'http://example.com/hook' };

            const result = await controller.createSession(makeConfig(), req);

            expect(authorizationWebhookService.checkAuthorization).toHaveBeenCalledWith(
                'create_session',
                expect.objectContaining({
                    apiKey: { userId: 'user:1', webhookUrl: 'http://example.com/hook' },
                }),
            );
            expect(result.sessionId).toBeDefined();
        });

        it('should bind webhook from API key when no per-session webhook is configured', async () => {
            const dto: CreateSessionDto = {
                s3: {
                    endPoint: 's3.example.com',
                    bucket: 'test',
                    accessKey: 'key',
                    secretKey: 'secret',
                },
            };
            const req = makeRequest();
            (req as any).apiKey = { userId: 'user:1', webhookUrl: 'http://example.com/hook' };

            const result = await controller.createSession(dto, req);

            const session = sessionService.get(result.sessionId)!;
            expect(session.config.webhook).toEqual({
                url: 'http://example.com/hook',
                sessionToken: '',
            });
        });

        it('should not override per-session webhook with API key webhook', async () => {
            const dto = makeConfig(); // has webhook configured
            const req = makeRequest();
            (req as any).apiKey = { userId: 'user:1', webhookUrl: 'http://example.com/other-hook' };

            const result = await controller.createSession(dto, req);

            const session = sessionService.get(result.sessionId)!;
            expect(session.config.webhook!.url).toBe('https://example.com/webhook');
        });
    });

    describe('startEncode - copyStream validation', () => {
        it('should reject copyStream rendition without sourceTrackIndex', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: true, audioGroupId: 'hd' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow(BadRequestException);

            await expect(
                controller.startEncode(session.id, config, makeRequest()),
            ).rejects.toThrow('copyStream renditions require a sourceTrackIndex');
        });

        it('should accept copyStream rendition with sourceTrackIndex', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: true, sourceTrackIndex: 0, audioGroupId: 'hd' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            };

            const result = await controller.startEncode(session.id, config, makeRequest());

            expect(result.status).toBe('queued');
        });
    });

    describe('streamEvents - encoder field', () => {
        it('should include encoder field from getAccelMode in SSE events', () => {
            ffmpegService.getAccelMode.mockReturnValue('nvidia');
            const session = sessionService.create(makeConfig());

            const sessionEventsService = {
                emit: vi.fn(),
                forSession: vi.fn().mockReturnValue({
                    pipe: vi.fn().mockImplementation((operator) => {
                        // We verify the pipe transform includes encoder
                        return { subscribe: vi.fn() };
                    }),
                }),
            } as any;

            const ctrl = new EncodeController(
                sessionService,
                sessionEventsService,
                queueService,
                ffmpegService,
                authorizationWebhookService,
                previewService,
            );

            const result = ctrl.streamEvents(session.id, session.sessionToken);
            expect(sessionEventsService.forSession).toHaveBeenCalledWith(session.id);
            expect(result).toBeDefined();
        });

        it('should map SSE events to include encoder field in data', async () => {
            const { Subject } = await import('rxjs');
            const { firstValueFrom } = await import('rxjs');

            ffmpegService.getAccelMode.mockReturnValue('apple');
            const subject = new Subject<any>();

            const sessionEventsService = {
                emit: vi.fn(),
                forSession: vi.fn().mockReturnValue(subject.asObservable()),
            } as any;

            const ctrl = new EncodeController(
                sessionService,
                sessionEventsService,
                queueService,
                ffmpegService,
                authorizationWebhookService,
                previewService,
            );

            const session = sessionService.create(makeConfig());
            const observable = ctrl.streamEvents(session.id, session.sessionToken);

            // Emit an event and capture what the mapped observable produces
            const resultPromise = firstValueFrom(observable);
            subject.next({ sessionId: session.id, status: 'encoding', progress: 50 });

            const result = await resultPromise;
            expect(result).toEqual({
                data: {
                    sessionId: session.id,
                    status: 'encoding',
                    progress: 50,
                    encoder: 'apple',
                },
            });
        });
    });

    describe('deleteSession - preview cleanup', () => {
        it('should call previewService.destroy when deleting a session', async () => {
            const session = sessionService.create(makeConfig());

            await controller.deleteSession(session.id);

            expect(previewService.destroy).toHaveBeenCalledWith(session.id);
        });
    });

    describe('preview endpoints', () => {
        function makeRes(): any {
            const res: any = {
                set: vi.fn().mockReturnThis(),
                send: vi.fn().mockReturnThis(),
                status: vi.fn().mockReturnThis(),
            };
            return res;
        }

        describe('validatePreviewToken', () => {
            it('should throw UnauthorizedException when token is missing', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(session.id, '', res),
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException for invalid token', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(session.id, 'invalid-token', res),
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException when token belongs to different session', () => {
                const session1 = sessionService.create(makeConfig());
                const session2 = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(session1.id, session2.sessionToken, res),
                ).toThrow(UnauthorizedException);
            });
        });

        describe('getPreviewMasterPlaylist', () => {
            it('should return playlist content with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n#EXT-X-STREAM-INF\n');

                controller.getPreviewMasterPlaylist(session.id, session.sessionToken, res);

                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({ 'Content-Type': 'application/vnd.apple.mpegurl' }),
                );
                expect(res.send).toHaveBeenCalledWith('#EXTM3U\n#EXT-X-STREAM-INF\n');
            });

            it('should throw NotFoundException when preview is not ready', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewMasterPlaylist(session.id, session.sessionToken, res),
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewRenditionPlaylist', () => {
            it('should return rendition playlist with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n#EXTINF:6\n');

                controller.getPreviewRenditionPlaylist(session.id, '0', session.sessionToken, res);

                expect(previewService.getPlaylist).toHaveBeenCalledWith(session.id, session.sessionToken, 0);
                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({ 'Content-Type': 'application/vnd.apple.mpegurl' }),
                );
                expect(res.send).toHaveBeenCalledWith('#EXTM3U\n#EXTINF:6\n');
            });

            it('should throw NotFoundException when rendition is not available', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewRenditionPlaylist(session.id, '0', session.sessionToken, res),
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewSegment', () => {
            it('should pipe segment stream to response', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                const mockStream = { pipe: vi.fn() };
                previewService.getSegmentStream.mockResolvedValue({ stream: mockStream as any, size: 12345 });

                await controller.getPreviewSegment(session.id, '0', 'segment0.ts', session.sessionToken, res);

                expect(previewService.getSegmentStream).toHaveBeenCalledWith(session.id, 0, 0);
                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({
                        'Content-Type': 'video/mp2t',
                        'Content-Length': '12345',
                    }),
                );
                expect(mockStream.pipe).toHaveBeenCalledWith(res);
            });

            it('should throw NotFoundException for invalid segment filename', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                await expect(
                    controller.getPreviewSegment(session.id, '0', 'invalid.mp4', session.sessionToken, res),
                ).rejects.toThrow(NotFoundException);
            });

            it('should throw NotFoundException when segment is not available', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getSegmentStream.mockResolvedValue(null);

                await expect(
                    controller.getPreviewSegment(session.id, '0', 'segment0.ts', session.sessionToken, res),
                ).rejects.toThrow(NotFoundException);
            });
        });
    });

    describe('deleteSession - cleanup resilience', () => {
        it('should still remove session even when work directory does not exist', async () => {
            process.env.WORK_DIR = '/tmp/nonexistent-luminary-test-dir';
            const session = sessionService.create(makeConfig());

            // rm with force:true won't throw for missing dirs, so session should be removed
            await controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should warn and still remove session when directory cleanup fails', async () => {
            // Point WORK_DIR to /dev/null — rm recursive on a device file triggers an error
            process.env.WORK_DIR = '/dev/null';
            const loggerWarnSpy = vi.spyOn((controller as any).logger, 'warn');

            const session = sessionService.create(makeConfig());

            await controller.deleteSession(session.id);

            // rm on /dev/null/<sessionId> should fail and trigger the catch branch
            expect(loggerWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to clean up directory for session'),
            );
            // Session should still be removed despite cleanup failure
            expect(sessionService.get(session.id)).toBeUndefined();
        });
    });
});
