import { BadRequestException, NotFoundException } from '@nestjs/common';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { ProbeService } from './services/probe.service.js';
import type { CreateSessionDto } from './dto/create-session.dto.js';
import type { EncodeConfigDto } from './dto/encode-config.dto.js';

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
    let probeService: jest.Mocked<ProbeService>;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService();

        queueService = {
            enqueue: jest.fn().mockReturnValue(1),
            getPosition: jest.fn().mockReturnValue(null),
            length: 0,
            isProcessing: false,
        } as any;

        probeService = {
            probe: jest.fn().mockReturnValue({
                format: { duration: 120, bitrateKbps: 5000, formatName: 'mov,mp4' },
                videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 30 }],
                audioTracks: [{ index: 0, codec: 'aac', bitrateKbps: 128, channels: 2, sampleRate: 44100 }],
            }),
            suggest: jest.fn().mockReturnValue({
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    { width: 1920, height: 1080, videoBitrateKbps: 5000, copyStream: false, audioGroupId: 'hd', label: '1080p' },
                ],
                audioGroups: [
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            }),
        } as any;

        controller = new EncodeController(sessionService, queueService, probeService);
    });

    afterEach(() => {
        try {
            rmSync(testWorkDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
        delete process.env.WORK_DIR;
    });

    describe('createSession', () => {
        it('should create a session and return upload details', () => {
            const dto = makeConfig();
            const req = makeRequest();

            const result = controller.createSession(dto, req);

            expect(result.sessionId).toBeDefined();
            expect(result.uploadUrl).toContain('/api/sessions/');
            expect(result.uploadUrl).toContain('/upload');
            expect(result.uploadToken).toMatch(/^tok_/);
        });

        it('should build uploadUrl from request protocol and host', () => {
            const dto = makeConfig();
            const req = makeRequest({
                protocol: 'https',
                get: (h: string) =>
                    h === 'host' ? 'api.example.com' : undefined,
            });

            const result = controller.createSession(dto, req);

            expect(result.uploadUrl).toMatch(
                /^https:\/\/api\.example\.com\/api\/sessions\/.+\/upload$/,
            );
        });
    });

    describe('getStatus', () => {
        it('should return session status for created session', () => {
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id);

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('created');
        });

        it('should include probeResult and suggestedConfig when uploaded', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');
            sessionService.setProbeResult(session.id, {
                format: { duration: 60, bitrateKbps: 3000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            }, { type: 'audio', segmentDuration: 6, audioRenditions: [] });

            const result = controller.getStatus(session.id);

            expect(result.probeResult).toBeDefined();
            expect(result.suggestedConfig).toBeDefined();
        });

        it('should include queuePosition when session is queued', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'queued');
            queueService.getPosition.mockReturnValue(3);

            const result = controller.getStatus(session.id);

            expect(result.queuePosition).toBe(3);
        });

        it('should include progress when session is encoding', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'encoding');
            sessionService.updateProgress(session.id, 42.5);

            const result = controller.getStatus(session.id);

            expect(result.progress).toBe(42.5);
        });

        it('should include files and masterPlaylist when completed', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(
                session.id,
                ['master.m3u8', 'v0/playlist.m3u8'],
                'master.m3u8',
            );

            const result = controller.getStatus(session.id);

            expect(result.status).toBe('completed');
            expect(result.progress).toBe(100);
            expect(result.files).toEqual(['master.m3u8', 'v0/playlist.m3u8']);
            expect(result.masterPlaylist).toBe('master.m3u8');
        });

        it('should include error when session failed', () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFailed(session.id, 'FFmpeg crashed');

            const result = controller.getStatus(session.id);

            expect(result.status).toBe('failed');
            expect(result.error).toBe('FFmpeg crashed');
        });

        it('should throw NotFoundException for unknown session', () => {
            expect(() => controller.getStatus('nonexistent')).toThrow(
                NotFoundException,
            );
        });
    });

    describe('uploadFile', () => {
        it('should reject when no file is provided', () => {
            expect(() =>
                controller.uploadFile('sess-1', null),
            ).toThrow(BadRequestException);
        });

        it('should reject when file buffer is empty', () => {
            const uploaded = {
                buffer: Buffer.alloc(0),
                size: 0,
                originalname: 'test.mp4',
            };

            expect(() =>
                controller.uploadFile('sess-1', uploaded),
            ).toThrow(BadRequestException);
        });

        it('should probe file and return uploaded status', () => {
            const session = sessionService.create(makeConfig());
            const uploaded = {
                buffer: Buffer.from('fake-video-data'),
                size: 15,
                originalname: 'test.mp4',
            };

            const result = controller.uploadFile(session.id, uploaded);

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('uploaded');
            expect(result.probeResult).toBeDefined();
            expect(result.suggestedConfig).toBeDefined();
            expect(probeService.probe).toHaveBeenCalled();
            expect(probeService.suggest).toHaveBeenCalled();
        });

        it('should set file path on the session', () => {
            const session = sessionService.create(makeConfig());
            const uploaded = {
                buffer: Buffer.from('data'),
                size: 4,
                originalname: 'video.mp4',
            };

            controller.uploadFile(session.id, uploaded);

            const updated = sessionService.get(session.id)!;
            expect(updated.filePath).toContain('video.mp4');
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

        it('should reject audio config without audioRenditions', () => {
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
});
