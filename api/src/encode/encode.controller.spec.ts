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
import { UrlFetchService } from './services/url-fetch.service.js';
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
    let urlFetchService: Mocked<UrlFetchService>;
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
            getAudioTracks: vi.fn().mockReturnValue(null),
            getSegmentStream: vi.fn().mockResolvedValue(null),
            destroy: vi.fn().mockResolvedValue(undefined),
            setTrimSegments: vi.fn(),
        } as any;

        urlFetchService = {
            fetchToSession: vi.fn().mockResolvedValue(undefined),
            abort: vi.fn().mockReturnValue(false),
        } as any;

        const sessionEventsService = { emit: vi.fn(), forSession: vi.fn().mockReturnValue({ pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }) }) } as any;
        controller = new EncodeController(sessionService, sessionEventsService, queueService, ffmpegService, authorizationWebhookService, previewService, urlFetchService);
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

        it('should include trimSegments from the submitted encode config', () => {
            const session = sessionService.create(makeConfig());
            const config = makeEncodeConfig();
            config.trimSegments = [
                { inSec: 10, outSec: 20 },
                { inSec: 40, outSec: 50 },
            ];
            sessionService.setEncodeConfig(session.id, config);
            sessionService.updateStatus(session.id, 'encoding');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.trimSegments).toEqual([
                { inSec: 10, outSec: 20 },
                { inSec: 40, outSec: 50 },
            ]);
        });

        it('should omit trimSegments when the encode config has none', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            sessionService.updateStatus(session.id, 'encoding');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.trimSegments).toBeUndefined();
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

        it('should call setTrimSegments when trimSegments are present', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config = makeEncodeConfig();
            config.trimSegments = [{ inSec: 5, outSec: 30 }, { inSec: 60, outSec: 90 }];

            await controller.startEncode(session.id, config, makeRequest());

            expect(previewService.setTrimSegments).toHaveBeenCalledWith(
                session.id,
                [{ inSec: 5, outSec: 30 }, { inSec: 60, outSec: 90 }],
            );
        });

        it('should not call setTrimSegments when no trimSegments', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            await controller.startEncode(session.id, makeEncodeConfig(), makeRequest());

            expect(previewService.setTrimSegments).not.toHaveBeenCalled();
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
                urlFetchService,
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
                urlFetchService,
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
                    controller.getPreviewMasterPlaylist(session.id, '', undefined, res),
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException for invalid token', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(session.id, 'invalid-token', undefined, res),
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException when token belongs to different session', () => {
                const session1 = sessionService.create(makeConfig());
                const session2 = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(session1.id, session2.sessionToken, undefined, res),
                ).toThrow(UnauthorizedException);
            });
        });

        describe('getPreviewMasterPlaylist', () => {
            it('should return playlist content with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n#EXT-X-STREAM-INF\n');

                controller.getPreviewMasterPlaylist(session.id, session.sessionToken, undefined, res);

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
                    controller.getPreviewMasterPlaylist(session.id, session.sessionToken, undefined, res),
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewRenditionPlaylist', () => {
            it('should return rendition playlist with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n#EXTINF:6\n');

                controller.getPreviewRenditionPlaylist(session.id, '0', session.sessionToken, undefined, res);

                expect(previewService.getPlaylist).toHaveBeenCalledWith(session.id, session.sessionToken, 0, undefined);
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
                    controller.getPreviewRenditionPlaylist(session.id, '0', session.sessionToken, undefined, res),
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewSegment', () => {
            it('should pipe segment stream to response', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                const mockStream = { pipe: vi.fn() };
                previewService.getSegmentStream.mockResolvedValue({ stream: mockStream as any, size: 12345 });

                await controller.getPreviewSegment(session.id, '0', 'segment0.ts', session.sessionToken, undefined, res);

                expect(previewService.getSegmentStream).toHaveBeenCalledWith(session.id, 0, 0, undefined);
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
                    controller.getPreviewSegment(session.id, '0', 'invalid.mp4', session.sessionToken, undefined, res),
                ).rejects.toThrow(NotFoundException);
            });

            it('should throw NotFoundException when segment is not available', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getSegmentStream.mockResolvedValue(null);

                await expect(
                    controller.getPreviewSegment(session.id, '0', 'segment0.ts', session.sessionToken, undefined, res),
                ).rejects.toThrow(NotFoundException);
            });
        });

        describe('getPreviewAudioTracks', () => {
            it('should return audio tracks', () => {
                const session = sessionService.create(makeConfig());
                const tracks = [{ index: 0, streamIndex: 0, name: 'English', isDefault: true }];
                previewService.getAudioTracks.mockReturnValue(tracks);

                const result = controller.getPreviewAudioTracks(session.id, session.sessionToken);

                expect(previewService.getAudioTracks).toHaveBeenCalledWith(session.id);
                expect(result).toEqual(tracks);
            });

            it('should throw NotFoundException when preview not ready', () => {
                const session = sessionService.create(makeConfig());
                previewService.getAudioTracks.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewAudioTracks(session.id, session.sessionToken),
                ).toThrow(NotFoundException);
            });
        });

        describe('audio query param forwarding', () => {
            it('should pass audio param to getPlaylist for master playlist', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n');

                controller.getPreviewMasterPlaylist(session.id, session.sessionToken, '2', res);

                expect(previewService.getPlaylist).toHaveBeenCalledWith(session.id, session.sessionToken, undefined, 2);
            });

            it('should pass audio param to getPlaylist for rendition playlist', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n');

                controller.getPreviewRenditionPlaylist(session.id, '0', session.sessionToken, '3', res);

                expect(previewService.getPlaylist).toHaveBeenCalledWith(session.id, session.sessionToken, 0, 3);
            });

            it('should pass audio param to getSegmentStream', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                const mockStream = { pipe: vi.fn() };
                previewService.getSegmentStream.mockResolvedValue({ stream: mockStream as any, size: 100 });

                await controller.getPreviewSegment(session.id, '0', 'segment0.ts', session.sessionToken, '4', res);

                expect(previewService.getSegmentStream).toHaveBeenCalledWith(session.id, 0, 0, 4);
            });
        });
    });

    describe('getStatus - probeResult availability', () => {
        it('should include probeResult when status is uploaded', () => {
            const session = sessionService.create(makeConfig());
            const probeResult = {
                format: { duration: 60, bitrateKbps: 5000, formatName: 'mp4' },
                videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 30 }],
                audioTracks: [],
            };
            sessionService.setProbeResult(session.id, probeResult);
            sessionService.updateStatus(session.id, 'uploaded');

            const result = controller.getStatus(session.id, makeRequest());
            expect(result.probeResult).toEqual(probeResult);
        });

        it('should not include probeResult when status is still uploading', () => {
            const session = sessionService.create(makeConfig());
            const probeResult = {
                format: { duration: 60, bitrateKbps: 5000, formatName: 'mp4' },
                videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 30 }],
                audioTracks: [],
            };
            sessionService.setProbeResult(session.id, probeResult);
            // Status is still 'created' — probeResult should NOT be returned
            const result = controller.getStatus(session.id, makeRequest());
            expect(result.probeResult).toBeUndefined();
        });

        it('should include encryptionKeyHex when completed with encryption', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(
                session.id,
                ['master.m3u8'],
                'master.m3u8',
                undefined,
                undefined,
                undefined,
                'abcd1234abcd1234abcd1234abcd1234',
            );

            const result = controller.getStatus(session.id, makeRequest());
            expect(result.encryptionKeyHex).toBe('abcd1234abcd1234abcd1234abcd1234');
        });

        it('should not include probeResult when session does not have it', () => {
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id, makeRequest());
            expect(result.probeResult).toBeUndefined();
        });
    });

    describe('startUrlUpload', () => {
        it('should kick off the URL fetch and return 202-style response', async () => {
            const session = sessionService.create(makeConfig());

            const result = await controller.startUrlUpload(session.id, {
                url: 'https://example.com/file.mp4',
            });

            expect(result).toEqual({ sessionId: session.id, status: 'uploading' });
            expect(urlFetchService.fetchToSession).toHaveBeenCalledWith(
                session.id,
                'https://example.com/file.mp4',
                undefined,
            );
        });

        it('should pass filename override through to UrlFetchService', async () => {
            const session = sessionService.create(makeConfig());

            await controller.startUrlUpload(session.id, {
                url: 'https://example.com/opaque',
                filename: 'meeting.mp4',
            });

            expect(urlFetchService.fetchToSession).toHaveBeenCalledWith(
                session.id,
                'https://example.com/opaque',
                'meeting.mp4',
            );
        });

        it('should accept session in uploading status (idempotent retry)', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');

            await expect(
                controller.startUrlUpload(session.id, { url: 'https://example.com/file.mp4' }),
            ).resolves.toEqual({ sessionId: session.id, status: 'uploading' });
        });

        it('should reject when session does not exist', async () => {
            await expect(
                controller.startUrlUpload('nonexistent', { url: 'https://example.com/file.mp4' }),
            ).rejects.toThrow(NotFoundException);
            expect(urlFetchService.fetchToSession).not.toHaveBeenCalled();
        });

        it('should reject when session is past the upload phase', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');

            await expect(
                controller.startUrlUpload(session.id, { url: 'https://example.com/file.mp4' }),
            ).rejects.toThrow(BadRequestException);
            expect(urlFetchService.fetchToSession).not.toHaveBeenCalled();
        });

        it('should not await the background fetch (fire-and-forget)', async () => {
            const session = sessionService.create(makeConfig());
            // Make fetchToSession hang — controller must still resolve quickly.
            urlFetchService.fetchToSession.mockImplementation(
                () => new Promise(() => {}),
            );

            await expect(
                controller.startUrlUpload(session.id, { url: 'https://example.com/file.mp4' }),
            ).resolves.toBeDefined();
        });
    });

    describe('deleteSession - URL ingest abort', () => {
        it('should abort an in-flight URL download', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');

            await controller.deleteSession(session.id);

            expect(urlFetchService.abort).toHaveBeenCalledWith(session.id);
        });

        it('should not call abort for non-uploading statuses', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'queued');

            await controller.deleteSession(session.id);

            expect(urlFetchService.abort).not.toHaveBeenCalled();
        });
    });

    describe('getStatus - uploading phase fields', () => {
        it('should expose progress during URL ingestion', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');
            sessionService.updateProgress(session.id, 42);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.status).toBe('uploading');
            expect(result.progress).toBe(42);
        });

        it('should expose ingestTotalBytes once the probe reports it', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');
            sessionService.setIngestTotal(session.id, 524_288_000);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.ingestTotalBytes).toBe(524_288_000);
        });

        it('should not include ingestTotalBytes when not set', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.ingestTotalBytes).toBeUndefined();
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

describe('EncodeController — source storyboard', () => {
    let sessionService: SessionService;
    let thumbnailService: any;
    let ctrl: EncodeController;

    const VTT = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:05.000',
        'sprite_000.webp#xywh=0,0,160,90',
        '',
    ].join('\n');

    function makeRes() {
        return {
            set: vi.fn(),
            send: vi.fn(),
        } as any;
    }

    const req = {
        protocol: 'http',
        get: () => 'api.test:3000',
    } as any;

    function uploadedSession() {
        const session = sessionService.create(makeConfig());
        (session as any).filePath = '/tmp/source.mp4';
        (session as any).probeResult = {
            format: { duration: 120 },
            videoTracks: [{ width: 1920, height: 1080 }],
            audioTracks: [],
        };
        return session;
    }

    beforeEach(() => {
        sessionService = new SessionService();
        thumbnailService = {
            getOrGeneratePreview: vi.fn().mockResolvedValue({ vtt: VTT, dir: '/tmp/x' }),
            previewDir: vi.fn().mockReturnValue('/tmp/preview-thumbnails'),
        };
        ctrl = new EncodeController(
            sessionService,
            { emit: vi.fn(), forSession: vi.fn() } as any,
            { getPosition: vi.fn() } as any,
            { getAccelMode: vi.fn().mockReturnValue('cpu') } as any,
            { checkAuthorization: vi.fn() } as any,
            {} as any,
            {} as any,
            {} as any,
            thumbnailService,
        );
    });

    it('rejects a request without the session token', async () => {
        const session = uploadedSession();
        await expect(
            ctrl.getPreviewThumbnailVtt(session.id, 'wrong-token', req, makeRes()),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('has no storyboard before the source is uploaded', async () => {
        const session = sessionService.create(makeConfig());
        await expect(
            ctrl.getPreviewThumbnailVtt(session.id, session.sessionToken, req, makeRes()),
        ).rejects.toThrow(NotFoundException);
    });

    it('has no storyboard for a source without video', async () => {
        const session = uploadedSession();
        (session as any).probeResult.videoTracks = [];
        await expect(
            ctrl.getPreviewThumbnailVtt(session.id, session.sessionToken, req, makeRes()),
        ).rejects.toThrow(NotFoundException);
    });

    it('points sprite references at the sprite route, token included', async () => {
        const session = uploadedSession();
        const res = makeRes();
        await ctrl.getPreviewThumbnailVtt(session.id, session.sessionToken, req, res);

        const sent: string = res.send.mock.calls[0][0];
        // A bare filename would be resolved against the VTT URL and lose the token.
        expect(sent).toContain(
            `http://api.test:3000/api/sessions/${session.id}/thumbnails/sprite_000.webp?token=${session.sessionToken}`,
        );
        expect(sent).toContain('#xywh=0,0,160,90');
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({ 'Content-Type': 'text/vtt' }),
        );
    });

    it('generates from the probed source dimensions and duration', async () => {
        const session = uploadedSession();
        await ctrl.getPreviewThumbnailVtt(session.id, session.sessionToken, req, makeRes());
        expect(thumbnailService.getOrGeneratePreview).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({
                inputPath: '/tmp/source.mp4',
                duration: 120,
                sourceWidth: 1920,
                sourceHeight: 1080,
            }),
        );
    });

    it('refuses a sprite name that is not one it produces', async () => {
        const session = uploadedSession();
        for (const name of ['../../../etc/passwd', 'sprite_000.svg', 'evil.webp']) {
            await expect(
                ctrl.getPreviewThumbnailSprite(session.id, name, session.sessionToken, makeRes()),
            ).rejects.toThrow(NotFoundException);
        }
    });

    it('refuses a sprite request without the session token', async () => {
        const session = uploadedSession();
        await expect(
            ctrl.getPreviewThumbnailSprite(session.id, 'sprite_000.webp', 'nope', makeRes()),
        ).rejects.toThrow(UnauthorizedException);
    });
});
