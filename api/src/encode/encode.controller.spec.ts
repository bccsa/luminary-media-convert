import { BadRequestException, NotFoundException } from '@nestjs/common';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
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

        controller = new EncodeController(sessionService, queueService);
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

            const result = controller.getStatus(session.id);

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('created');
        });

        it('should include probeResult when uploaded', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');
            sessionService.setProbeResult(session.id, {
                format: { duration: 60, bitrateKbps: 3000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            });

            const result = controller.getStatus(session.id);

            expect(result.probeResult).toBeDefined();
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

    describe('deleteSession', () => {
        it('should delete a session in created status', () => {
            const session = sessionService.create(makeConfig());

            controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete a session in uploaded status', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should delete a session in uploading status', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading');

            controller.deleteSession(session.id);

            expect(sessionService.get(session.id)).toBeUndefined();
        });

        it('should reject deletion of a queued session', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'queued');

            expect(() =>
                controller.deleteSession(session.id),
            ).toThrow(BadRequestException);
        });

        it('should throw NotFoundException for unknown session', () => {
            expect(() =>
                controller.deleteSession('nonexistent'),
            ).toThrow(NotFoundException);
        });
    });
});
