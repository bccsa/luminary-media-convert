import { BadRequestException, NotFoundException } from '@nestjs/common';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
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
    let queueService: jest.Mocked<QueueService>;
    let ffmpegService: jest.Mocked<FfmpegService>;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService();

        queueService = {
            enqueue: jest.fn().mockReturnValue(1),
            getPosition: jest.fn().mockReturnValue(null),
            dequeue: jest.fn().mockReturnValue(true),
            length: 0,
            isProcessing: false,
        } as any;

        ffmpegService = {
            getAccelMode: jest.fn().mockReturnValue('cpu'),
            isGpuAvailable: jest.fn().mockReturnValue(false),
            killActiveProcess: jest.fn(),
        } as any;

        controller = new EncodeController(sessionService, queueService, ffmpegService);
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
        it('should create a session and return tus endpoint', () => {
            const dto = makeConfig();
            const req = makeRequest();

            const result = controller.createSession(dto, req);

            expect(result.sessionId).toBeDefined();
            expect(result.tusEndpoint).toBe('http://localhost:3000/api/tus');
            expect(result.uploadToken).toMatch(/^tok_/);
            expect(result.maxUploadSize).toBeGreaterThan(0);
        });

        it('should build tusEndpoint from request protocol and host', () => {
            const dto = makeConfig();
            const req = makeRequest({
                protocol: 'https',
                get: (h: string) =>
                    h === 'host' ? 'api.example.com' : undefined,
            });

            const result = controller.createSession(dto, req);

            expect(result.tusEndpoint).toBe('https://api.example.com/api/tus');
        });

        it('should use MAX_UPLOAD_SIZE from env when set', () => {
            process.env.MAX_UPLOAD_SIZE = '5368709120';
            const result = controller.createSession(makeConfig(), makeRequest());

            expect(result.maxUploadSize).toBe(5368709120);
        });

        it('should default maxUploadSize to 10 GB', () => {
            const result = controller.createSession(makeConfig(), makeRequest());

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

        it('should include previewBaseUrl and previewToken when encryption key is present', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');
            const sess = sessionService.get(session.id)!;
            sess.encryptionKey = Buffer.alloc(16, 0xab);
            sess.previewPlaylists = { 'master.m3u8': '#EXTM3U\n' };

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.previewBaseUrl).toBe(
                `http://localhost:3000/api/sessions/${session.id}/preview`,
            );
            expect(result.previewToken).toBe(session.uploadToken);
        });

        it('should not include previewBaseUrl when no encryption key', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.previewBaseUrl).toBeUndefined();
            expect(result.previewToken).toBeUndefined();
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
        it('should reject when session is not in uploaded state', () => {
            const session = sessionService.create(makeConfig());

            expect(() =>
                controller.startEncode(session.id, makeEncodeConfig()),
            ).toThrow(BadRequestException);
        });

        it('should reject when session not found', () => {
            expect(() =>
                controller.startEncode('nonexistent', makeEncodeConfig()),
            ).toThrow(NotFoundException);
        });

        it('should enqueue session and return queued status', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const result = controller.startEncode(session.id, makeEncodeConfig());

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('queued');
            expect(result.queuePosition).toBe(1);
            expect(queueService.enqueue).toHaveBeenCalledWith(session.id);
        });

        it('should reject video config without videoRenditions', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                audioGroups: [{ id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 }],
            };

            expect(() =>
                controller.startEncode(session.id, config),
            ).toThrow(BadRequestException);
        });

        it('should reject video config without audioGroups', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [{ width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd' }],
            };

            expect(() =>
                controller.startEncode(session.id, config),
            ).toThrow(BadRequestException);
        });

        it('should reject audio config without audioGroups', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = { type: 'audio' };

            expect(() =>
                controller.startEncode(session.id, config),
            ).toThrow(BadRequestException);
        });

        it('should reject unknown audioGroupId in video rendition', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [{ width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'nonexistent' }],
                audioGroups: [{ id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 }],
            };

            expect(() =>
                controller.startEncode(session.id, config),
            ).toThrow(BadRequestException);
        });
    });

    describe('getPreviewKey', () => {
        function makeResponse(): jest.Mocked<Response> {
            return {
                set: jest.fn().mockReturnThis(),
                send: jest.fn().mockReturnThis(),
            } as any;
        }

        it('should return the encryption key as raw bytes', () => {
            const session = sessionService.create(makeConfig());
            const key = Buffer.alloc(16, 0xab);
            const sess = sessionService.get(session.id)!;
            sess.encryptionKey = key;

            const res = makeResponse();
            controller.getPreviewKey(session.id, res);

            expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
                'Content-Type': 'application/octet-stream',
                'Content-Length': '16',
            }));
            expect(res.send).toHaveBeenCalledWith(key);
        });

        it('should throw NotFoundException when no encryption key', () => {
            const session = sessionService.create(makeConfig());

            const res = makeResponse();
            expect(() => controller.getPreviewKey(session.id, res)).toThrow(
                NotFoundException,
            );
        });

        it('should throw NotFoundException for unknown session', () => {
            const res = makeResponse();
            expect(() => controller.getPreviewKey('nonexistent', res)).toThrow(
                NotFoundException,
            );
        });
    });

    describe('getPreviewPlaylist', () => {
        function makeResponse(): jest.Mocked<Response> {
            return {
                set: jest.fn().mockReturnThis(),
                send: jest.fn().mockReturnThis(),
            } as any;
        }

        function setupEncryptedSession() {
            const config = makeConfig();
            const session = sessionService.create(config);
            const sess = sessionService.get(session.id)!;
            sess.encryptionKey = Buffer.alloc(16, 0xab);
            sess.previewPlaylists = {
                'master.m3u8': [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="HD Audio",URI="stream_HD_Audio/playlist.m3u8"',
                    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="group_hd"',
                    'stream_720p/playlist.m3u8',
                ].join('\n'),
                'stream_720p/playlist.m3u8': [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-TARGETDURATION:6',
                    '#EXT-X-KEY:METHOD=AES-128,URI="https://prod.example.com/key"',
                    '#EXT-X-MAP:URI="init.mp4"',
                    '#EXTINF:6.000,',
                    'segment_000.m4s',
                    '#EXT-X-ENDLIST',
                ].join('\n'),
            };
            return session;
        }

        it('should rewrite key URI in media playlist', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            controller.getPreviewPlaylist(session.id, 'stream_720p/playlist.m3u8', req, res);

            const body = res.send.mock.calls[0][0] as string;
            expect(body).toContain('URI="http://localhost:3000/api/sessions/' + session.id + '/preview/key"');
            expect(body).not.toContain('https://prod.example.com/key');
        });

        it('should rewrite segment URIs to absolute S3 URLs', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            controller.getPreviewPlaylist(session.id, 'stream_720p/playlist.m3u8', req, res);

            const body = res.send.mock.calls[0][0] as string;
            expect(body).toContain('https://s3.example.com/test/stream_720p/segment_000.m4s');
        });

        it('should rewrite EXT-X-MAP URI to absolute S3 URL', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            controller.getPreviewPlaylist(session.id, 'stream_720p/playlist.m3u8', req, res);

            const body = res.send.mock.calls[0][0] as string;
            expect(body).toContain('URI="https://s3.example.com/test/stream_720p/init.mp4"');
        });

        it('should rewrite master playlist sub-playlist URIs to preview URLs', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            controller.getPreviewPlaylist(session.id, 'master.m3u8', req, res);

            const body = res.send.mock.calls[0][0] as string;
            const previewBase = `http://localhost:3000/api/sessions/${session.id}/preview`;
            expect(body).toContain(`${previewBase}/stream_720p/playlist.m3u8`);
            expect(body).toContain(`URI="${previewBase}/stream_HD_Audio/playlist.m3u8"`);
        });

        it('should set correct content type header', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            controller.getPreviewPlaylist(session.id, 'master.m3u8', req, res);

            expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
                'Content-Type': 'application/vnd.apple.mpegurl',
            }));
        });

        it('should throw NotFoundException when no preview playlists', () => {
            const session = sessionService.create(makeConfig());
            const res = makeResponse();
            const req = makeRequest();

            expect(() => controller.getPreviewPlaylist(session.id, 'master.m3u8', req, res)).toThrow(
                NotFoundException,
            );
        });

        it('should throw NotFoundException for unknown playlist path', () => {
            const session = setupEncryptedSession();
            const res = makeResponse();
            const req = makeRequest();

            expect(() => controller.getPreviewPlaylist(session.id, 'nonexistent.m3u8', req, res)).toThrow(
                NotFoundException,
            );
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
});
