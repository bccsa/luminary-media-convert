import { BadRequestException, NotFoundException } from '@nestjs/common';
import { rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeController } from './encode.controller.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import type { CreateSessionDto } from './dto/create-session.dto.js';

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
        // Use a temp directory so tests don't pollute the project root
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
        // Clean up the temp work directory
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
                /^https:\/\/api\.example\.com\/api\/sessions\/.+\/upload$/
            );
        });

        it('should reject video renditions without required fields', () => {
            const dto = makeConfig();
            dto.renditions = [{ audioBitrateKbps: 128 } as any];

            expect(() =>
                controller.createSession(dto, makeRequest())
            ).toThrow(BadRequestException);
        });

        it('should accept audio renditions without video fields', () => {
            const dto = makeConfig();
            dto.type = 'audio';
            dto.renditions = [{ audioBitrateKbps: 128 }];

            const result = controller.createSession(dto, makeRequest());
            expect(result.sessionId).toBeDefined();
        });
    });

    describe('getStatus', () => {
        it('should return session status for created session', () => {
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id);

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('created');
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
                'master.m3u8'
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
                NotFoundException
            );
        });
    });

    describe('uploadFile', () => {
        it('should reject when no file is provided', async () => {
            await expect(
                controller.uploadFile('sess-1', null, makeRequest())
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject when file buffer is empty', async () => {
            const uploaded = {
                buffer: Buffer.alloc(0),
                size: 0,
                originalname: 'test.mp4',
            };

            await expect(
                controller.uploadFile('sess-1', uploaded, makeRequest())
            ).rejects.toThrow(BadRequestException);
        });

        it('should enqueue session and return queued status', async () => {
            const session = sessionService.create(makeConfig());
            const uploaded = {
                buffer: Buffer.from('fake-video-data'),
                size: 15,
                originalname: 'test.mp4',
            };

            const result = await controller.uploadFile(
                session.id,
                uploaded,
                makeRequest()
            );

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('queued');
            expect(result.queuePosition).toBe(1);
            expect(queueService.enqueue).toHaveBeenCalledWith(session.id);
        });

        it('should set file path on the session', async () => {
            const session = sessionService.create(makeConfig());
            const uploaded = {
                buffer: Buffer.from('data'),
                size: 4,
                originalname: 'video.mp4',
            };

            await controller.uploadFile(session.id, uploaded, makeRequest());

            const updated = sessionService.get(session.id)!;
            expect(updated.filePath).toContain('video.mp4');
        });
    });
});
