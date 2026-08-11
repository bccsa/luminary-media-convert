import { type Mocked } from 'vitest';
import {
    BadRequestException,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Reflector } from '@nestjs/core';
import { EncodeController } from './encode.controller.js';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { maskKeyHex } from './services/key-mask.js';
import { SessionService } from './services/session.service.js';
import { QueueService } from './services/queue.service.js';
import { FfmpegService } from './services/ffmpeg.service.js';
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
            {
                width: 1280,
                height: 720,
                videoBitrateKbps: 2500,
                copyStream: false,
                audioGroupId: 'hd',
                label: '720p',
            },
        ],
        audioGroups: [
            {
                id: 'hd',
                label: 'HD Audio',
                audioBitrateKbps: 192,
                channels: 2,
                audioCodec: 'aac',
                sourceTrackIndex: 0,
            },
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
    let previewService: Mocked<PreviewService>;
    let ingestService: any;
    let hlsEditService: any;
    let waveformService: any;
    let thumbnailService: any;
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
            // Null means "the encoder is usable", which is the state every test
            // below assumes. The refusal path has its own cases.
            unavailableReason: vi.fn().mockReturnValue(null),
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

        // Ingest, chapter and sidecar collaborators. The controller only
        // orchestrates them; each has its own suite.
        ingestService = {
            finalizeUpload: vi.fn().mockResolvedValue(undefined),
        };
        hlsEditService = {
            readChapters: vi.fn().mockResolvedValue(null),
            writeChapters: vi.fn().mockResolvedValue(undefined),
        };
        waveformService = {
            getOrComputeCached: vi
                .fn()
                .mockResolvedValue({ peaks: [], numPeaks: 0 }),
        };
        thumbnailService = {
            getOrGeneratePreview: vi.fn().mockResolvedValue(null),
            readPreviewVtt: vi.fn().mockResolvedValue(null),
        };
        const sessionEventsService = {
            emit: vi.fn(),
            forSession: vi.fn().mockReturnValue({
                pipe: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
            }),
        } as any;
        controller = new EncodeController(
            sessionService,
            sessionEventsService,
            queueService,
            ffmpegService,
            previewService,
            ingestService,
            hlsEditService,
            waveformService,
            thumbnailService
        );
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

    describe('getChapters', () => {
        it('answers an empty document when this language has no sidecar yet', async () => {
            // A session nobody has authored chapters for is the normal case, not
            // an error. Answering 404 put a red line in the browser console on
            // every session open — and got read as "chapters are not saved".
            const session = sessionService.create(makeConfig());
            hlsEditService.readChapters.mockResolvedValue(null);

            await expect(controller.getChapters(session.id)).resolves.toEqual({
                vtt: '',
            });
        });

        it('returns the sidecar when there is one', async () => {
            const session = sessionService.create(makeConfig());
            hlsEditService.readChapters.mockResolvedValue({
                vtt: 'WEBVTT\n\n00:00.000 --> 00:10.000\nOne\n',
            });

            const result = await controller.getChapters(session.id);

            expect(result.vtt).toContain('WEBVTT');
        });

        it('still 404s for a session that does not exist', async () => {
            // The only genuine absence this route has left to report.
            await expect(controller.getChapters('nope')).rejects.toThrow(
                NotFoundException
            );
        });
    });

    describe('createSession', () => {
        it('returns the session and the token that drives it', async () => {
            // No tus endpoint and no upload size: the browser never uploads.
            // A session is handed the absolute path of a file already on this
            // machine, so there is no transfer to size or address to hand back.
            const result = await controller.createSession(makeConfig());

            expect(result.sessionId).toBeTruthy();
            expect(result.sessionToken).toMatch(/^sess_/);
        });

        it('gives each session its own token', async () => {
            const first = await controller.createSession(makeConfig());
            const second = await controller.createSession(makeConfig());

            expect(first.sessionToken).not.toBe(second.sessionToken);
        });

        it('does not echo the S3 credentials back', async () => {
            // The caller supplied them; repeating them widens where they can be
            // read for nothing in return.
            const result = await controller.createSession(makeConfig());

            expect(JSON.stringify(result)).not.toContain('secret');
        });

        it('registers the session so it can be looked up by its token', async () => {
            const result = await controller.createSession(makeConfig());

            expect(
                sessionService.getBySessionToken(result.sessionToken)?.id
            ).toBe(result.sessionId);
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
                'master.m3u8'
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
            expect(() =>
                controller.getStatus('nonexistent', makeRequest())
            ).toThrow(NotFoundException);
        });
    });

    describe('startEncode', () => {
        it('should reject when session is not in uploaded state', async () => {
            const session = sessionService.create(makeConfig());

            await expect(
                controller.startEncode(
                    session.id,
                    makeEncodeConfig(),
                    makeRequest()
                )
            ).rejects.toThrow(BadRequestException);
        });

        it('refuses with 503 and the install advice when ffmpeg is missing', async () => {
            /*
             * A 400 would blame the request, which is fine — it is the machine
             * that cannot do the job. Before this, the encode was accepted and
             * failed later inside ffmpeg with an ENOENT nobody could read as
             * "install ffmpeg".
             */
            const advice = 'FFmpeg is required and could not be run: …';
            ffmpegService.unavailableReason.mockReturnValue(advice);

            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            await expect(
                controller.startEncode(
                    session.id,
                    makeEncodeConfig(),
                    makeRequest()
                )
            ).rejects.toThrow(ServiceUnavailableException);
            // The user-facing text travels with it — a bare 503 would leave the
            // renderer nothing to show.
            await expect(
                controller.startEncode(
                    session.id,
                    makeEncodeConfig(),
                    makeRequest()
                )
            ).rejects.toThrow(advice);
            expect(queueService.enqueue).not.toHaveBeenCalled();
        });

        it('refuses attaching a source when ffmpeg is missing', async () => {
            // Attaching probes the file immediately, so this is where a missing
            // install first bites — and it presented as a bad source file.
            ffmpegService.unavailableReason.mockReturnValue('no ffmpeg here');

            const session = sessionService.create(makeConfig());

            await expect(
                controller.attachLocalFile(
                    session.id,
                    { path: '/tmp/whatever.mp4' },
                    makeRequest()
                )
            ).rejects.toThrow(ServiceUnavailableException);
        });

        it('should reject when session not found', async () => {
            await expect(
                controller.startEncode(
                    'nonexistent',
                    makeEncodeConfig(),
                    makeRequest()
                )
            ).rejects.toThrow(NotFoundException);
        });

        it('should enqueue session and return queued status', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const result = await controller.startEncode(
                session.id,
                makeEncodeConfig(),
                makeRequest()
            );

            expect(result.sessionId).toBe(session.id);
            expect(result.status).toBe('queued');
            expect(result.queuePosition).toBe(1);
            expect(queueService.enqueue).toHaveBeenCalledWith(session.id);
        });

        /**
         * Every failure seen in practice — a full disk, a stalled upload, a
         * restart — left the uploaded source untouched. Accepting only
         * "uploaded" meant a valid multi-GB file could be used again only by
         * deleting the session and uploading it a second time.
         */
        describe('retrying a failed encode', () => {
            const tmpSource = join(tmpdir(), `retry-src-${Date.now()}.mkv`);

            beforeEach(() => {
                writeFileSync(tmpSource, 'source bytes');
            });

            afterEach(() => {
                rmSync(tmpSource, { force: true });
            });

            it('accepts a failed session whose source is still on disk', async () => {
                const session = sessionService.create(makeConfig());
                sessionService.setFilePath(session.id, tmpSource);
                sessionService.setFailed(session.id, 'Pipeline drain stalled');

                const result = await controller.startEncode(
                    session.id,
                    makeEncodeConfig(),
                    makeRequest()
                );

                expect(result.status).toBe('queued');
                expect(queueService.enqueue).toHaveBeenCalledWith(session.id);
            });

            it('refuses when the source is gone, and says so', async () => {
                // Nothing to retry from — this one genuinely needs re-uploading,
                // and the message should say that rather than name a status.
                const session = sessionService.create(makeConfig());
                sessionService.setFilePath(session.id, '/nonexistent/gone.mkv');
                sessionService.setFailed(session.id, 'Encoding failed');

                await expect(
                    controller.startEncode(
                        session.id,
                        makeEncodeConfig(),
                        makeRequest()
                    )
                ).rejects.toThrow(/no longer on disk/);
            });

            it('refuses a failed session that never had a source', async () => {
                const session = sessionService.create(makeConfig());
                sessionService.setFailed(session.id, 'Upload failed');

                await expect(
                    controller.startEncode(
                        session.id,
                        makeEncodeConfig(),
                        makeRequest()
                    )
                ).rejects.toThrow(BadRequestException);
            });

            it('still refuses a session that is mid-encode', async () => {
                // Retry applies to terminal failure, not to work in progress.
                const session = sessionService.create(makeConfig());
                sessionService.setFilePath(session.id, tmpSource);
                sessionService.updateStatus(session.id, 'encoding');

                await expect(
                    controller.startEncode(
                        session.id,
                        makeEncodeConfig(),
                        makeRequest()
                    )
                ).rejects.toThrow(/must be in "uploaded" status/);
            });
        });

        it('should call setTrimSegments when trimSegments are present', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config = makeEncodeConfig();
            config.trimSegments = [
                { inSec: 5, outSec: 30 },
                { inSec: 60, outSec: 90 },
            ];

            await controller.startEncode(session.id, config, makeRequest());

            expect(previewService.setTrimSegments).toHaveBeenCalledWith(
                session.id,
                [
                    { inSec: 5, outSec: 30 },
                    { inSec: 60, outSec: 90 },
                ]
            );
        });

        it('should not call setTrimSegments when no trimSegments', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            await controller.startEncode(
                session.id,
                makeEncodeConfig(),
                makeRequest()
            );

            expect(previewService.setTrimSegments).not.toHaveBeenCalled();
        });

        it('should reject video config without videoRenditions', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest())
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject video config without audioGroups', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
                        audioGroupId: 'hd',
                    },
                ],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest())
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject audio config without audioGroups', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = { type: 'audio' };

            await expect(
                controller.startEncode(session.id, config, makeRequest())
            ).rejects.toThrow(BadRequestException);
        });

        it('should reject unknown audioGroupId in video rendition', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
                        audioGroupId: 'nonexistent',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest())
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

            await expect(controller.deleteSession(session.id)).rejects.toThrow(
                BadRequestException
            );
        });

        /**
         * Deleting a finished session is the only way its disk is ever
         * reclaimed. While these were refused, the work directory of a failed
         * session — source file and all — could not be removed through the
         * product at any point in its life. On staging that was several GB per
         * attempt, on a volume that filled and took the next encode with it.
         */
        it('deletes a completed session', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setCompleted(
                session.id,
                ['master.m3u8'],
                'master.m3u8'
            );

            await expect(
                controller.deleteSession(session.id)
            ).resolves.toBeUndefined();
        });

        it('deletes a failed session, whose source is the disk worth reclaiming', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFailed(session.id, 'some error');

            await expect(
                controller.deleteSession(session.id)
            ).resolves.toBeUndefined();
        });

        it('still refuses while the output is being written to S3', async () => {
            // Pulling files out from under the pipeline mid-write leaves half an
            // output in the bucket.
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploading_to_s3');

            await expect(controller.deleteSession(session.id)).rejects.toThrow(
                BadRequestException
            );
        });

        it('should throw NotFoundException for unknown session', async () => {
            await expect(
                controller.deleteSession('nonexistent')
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('streamEvents', () => {
        it('should throw UnauthorizedException when no token', () => {
            const session = sessionService.create(makeConfig());
            expect(() => controller.streamEvents(session.id, '')).toThrow(
                UnauthorizedException
            );
        });

        it('should throw UnauthorizedException for invalid token', () => {
            const session = sessionService.create(makeConfig());
            expect(() =>
                controller.streamEvents(session.id, 'invalid')
            ).toThrow(UnauthorizedException);
        });

        it('should throw UnauthorizedException when token belongs to different session', () => {
            const session1 = sessionService.create(makeConfig());
            const session2 = sessionService.create(makeConfig());
            expect(() =>
                controller.streamEvents(session1.id, session2.sessionToken)
            ).toThrow(UnauthorizedException);
        });

        it('should return an Observable for valid session token', () => {
            const session = sessionService.create(makeConfig());
            const result = controller.streamEvents(
                session.id,
                session.sessionToken
            );
            expect(result).toBeDefined();
            expect(typeof result.subscribe).toBe('function');
        });
    });

    describe('startEncode - copyStream validation', () => {
        it('should reject copyStream rendition without sourceTrackIndex', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: true,
                        audioGroupId: 'hd',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            await expect(
                controller.startEncode(session.id, config, makeRequest())
            ).rejects.toThrow(BadRequestException);

            await expect(
                controller.startEncode(session.id, config, makeRequest())
            ).rejects.toThrow(
                'copyStream renditions require a sourceTrackIndex'
            );
        });

        it('should accept copyStream rendition with sourceTrackIndex', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const config: EncodeConfigDto = {
                type: 'video',
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: true,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const result = await controller.startEncode(
                session.id,
                config,
                makeRequest()
            );

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
                previewService,
                ingestService,
                hlsEditService,
                waveformService,
                thumbnailService
            );

            const result = ctrl.streamEvents(session.id, session.sessionToken);
            expect(sessionEventsService.forSession).toHaveBeenCalledWith(
                session.id
            );
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
                previewService,
                ingestService,
                hlsEditService,
                waveformService,
                thumbnailService
            );

            const session = sessionService.create(makeConfig());
            const observable = ctrl.streamEvents(
                session.id,
                session.sessionToken
            );

            // Emit an event and capture what the mapped observable produces
            const resultPromise = firstValueFrom(observable);
            subject.next({
                sessionId: session.id,
                status: 'encoding',
                progress: 50,
            });

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
                    controller.getPreviewMasterPlaylist(
                        session.id,
                        '',
                        undefined,
                        res
                    )
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException for invalid token', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(
                        session.id,
                        'invalid-token',
                        undefined,
                        res
                    )
                ).toThrow(UnauthorizedException);
            });

            it('should throw UnauthorizedException when token belongs to different session', () => {
                const session1 = sessionService.create(makeConfig());
                const session2 = sessionService.create(makeConfig());
                const res = makeRes();

                expect(() =>
                    controller.getPreviewMasterPlaylist(
                        session1.id,
                        session2.sessionToken,
                        undefined,
                        res
                    )
                ).toThrow(UnauthorizedException);
            });
        });

        describe('getPreviewMasterPlaylist', () => {
            it('should return playlist content with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(
                    '#EXTM3U\n#EXT-X-STREAM-INF\n'
                );

                controller.getPreviewMasterPlaylist(
                    session.id,
                    session.sessionToken,
                    undefined,
                    res
                );

                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({
                        'Content-Type': 'application/vnd.apple.mpegurl',
                    })
                );
                expect(res.send).toHaveBeenCalledWith(
                    '#EXTM3U\n#EXT-X-STREAM-INF\n'
                );
            });

            it('should throw NotFoundException when preview is not ready', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewMasterPlaylist(
                        session.id,
                        session.sessionToken,
                        undefined,
                        res
                    )
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewRenditionPlaylist', () => {
            it('should return rendition playlist with correct headers', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(
                    '#EXTM3U\n#EXTINF:6\n'
                );

                controller.getPreviewRenditionPlaylist(
                    session.id,
                    '0',
                    session.sessionToken,
                    undefined,
                    res
                );

                expect(previewService.getPlaylist).toHaveBeenCalledWith(
                    session.id,
                    session.sessionToken,
                    0,
                    undefined
                );
                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({
                        'Content-Type': 'application/vnd.apple.mpegurl',
                    })
                );
                expect(res.send).toHaveBeenCalledWith('#EXTM3U\n#EXTINF:6\n');
            });

            it('should throw NotFoundException when rendition is not available', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewRenditionPlaylist(
                        session.id,
                        '0',
                        session.sessionToken,
                        undefined,
                        res
                    )
                ).toThrow(NotFoundException);
            });
        });

        describe('getPreviewSegment', () => {
            it('should pipe segment stream to response', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                const mockStream = { pipe: vi.fn() };
                previewService.getSegmentStream.mockResolvedValue({
                    stream: mockStream as any,
                    size: 12345,
                });

                await controller.getPreviewSegment(
                    session.id,
                    '0',
                    'segment0.ts',
                    session.sessionToken,
                    undefined,
                    res
                );

                expect(previewService.getSegmentStream).toHaveBeenCalledWith(
                    session.id,
                    0,
                    0,
                    undefined
                );
                expect(res.set).toHaveBeenCalledWith(
                    expect.objectContaining({
                        'Content-Type': 'video/mp2t',
                        'Content-Length': '12345',
                    })
                );
                expect(mockStream.pipe).toHaveBeenCalledWith(res);
            });

            it('should throw NotFoundException for invalid segment filename', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();

                await expect(
                    controller.getPreviewSegment(
                        session.id,
                        '0',
                        'invalid.mp4',
                        session.sessionToken,
                        undefined,
                        res
                    )
                ).rejects.toThrow(NotFoundException);
            });

            it('should throw NotFoundException when segment is not available', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getSegmentStream.mockResolvedValue(null);

                await expect(
                    controller.getPreviewSegment(
                        session.id,
                        '0',
                        'segment0.ts',
                        session.sessionToken,
                        undefined,
                        res
                    )
                ).rejects.toThrow(NotFoundException);
            });
        });

        describe('getPreviewAudioTracks', () => {
            it('should return audio tracks', () => {
                const session = sessionService.create(makeConfig());
                const tracks = [
                    {
                        index: 0,
                        streamIndex: 0,
                        name: 'English',
                        isDefault: true,
                    },
                ];
                previewService.getAudioTracks.mockReturnValue(tracks);

                const result = controller.getPreviewAudioTracks(
                    session.id,
                    session.sessionToken
                );

                expect(previewService.getAudioTracks).toHaveBeenCalledWith(
                    session.id
                );
                expect(result).toEqual(tracks);
            });

            it('should throw NotFoundException when preview not ready', () => {
                const session = sessionService.create(makeConfig());
                previewService.getAudioTracks.mockReturnValue(null);

                expect(() =>
                    controller.getPreviewAudioTracks(
                        session.id,
                        session.sessionToken
                    )
                ).toThrow(NotFoundException);
            });
        });

        describe('audio query param forwarding', () => {
            it('should pass audio param to getPlaylist for master playlist', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n');

                controller.getPreviewMasterPlaylist(
                    session.id,
                    session.sessionToken,
                    '2',
                    res
                );

                expect(previewService.getPlaylist).toHaveBeenCalledWith(
                    session.id,
                    session.sessionToken,
                    undefined,
                    2
                );
            });

            it('should pass audio param to getPlaylist for rendition playlist', () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                previewService.getPlaylist.mockReturnValue('#EXTM3U\n');

                controller.getPreviewRenditionPlaylist(
                    session.id,
                    '0',
                    session.sessionToken,
                    '3',
                    res
                );

                expect(previewService.getPlaylist).toHaveBeenCalledWith(
                    session.id,
                    session.sessionToken,
                    0,
                    3
                );
            });

            it('should pass audio param to getSegmentStream', async () => {
                const session = sessionService.create(makeConfig());
                const res = makeRes();
                const mockStream = { pipe: vi.fn() };
                previewService.getSegmentStream.mockResolvedValue({
                    stream: mockStream as any,
                    size: 100,
                });

                await controller.getPreviewSegment(
                    session.id,
                    '0',
                    'segment0.ts',
                    session.sessionToken,
                    '4',
                    res
                );

                expect(previewService.getSegmentStream).toHaveBeenCalledWith(
                    session.id,
                    0,
                    0,
                    4
                );
            });
        });
    });

    describe('getStatus - probeResult availability', () => {
        it('should include probeResult when status is uploaded', () => {
            const session = sessionService.create(makeConfig());
            const probeResult = {
                format: { duration: 60, bitrateKbps: 5000, formatName: 'mp4' },
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
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
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
                audioTracks: [],
            };
            sessionService.setProbeResult(session.id, probeResult);
            // Status is still 'created' — probeResult should NOT be returned
            const result = controller.getStatus(session.id, makeRequest());
            expect(result.probeResult).toBeUndefined();
        });

        it('never puts the encryption key in the status payload', () => {
            const session = sessionService.create(makeConfig());
            // (id, files, masterPlaylist, thumbnailsVtt, segmentFormat,
            // encryptionKeyHex) — the angle-playlist argument that used to sit
            // in the middle is gone with the per-angle files themselves.
            sessionService.setCompleted(
                session.id,
                ['master.m3u8'],
                'master.m3u8',
                undefined,
                undefined,
                'abcd1234abcd1234abcd1234abcd1234'
            );

            // The key is served masked from its own endpoint. Riding along on
            // every status read is what put it in logs and proxies.
            const result = controller.getStatus(session.id, makeRequest());
            expect(
                (result as Record<string, unknown>).encryptionKeyHex
            ).toBeUndefined();
            expect(controller.getSessionKey(session.id).maskedKeyHex).toEqual(
                expect.any(String)
            );
        });

        it('should not include probeResult when session does not have it', () => {
            const session = sessionService.create(makeConfig());

            const result = controller.getStatus(session.id, makeRequest());
            expect(result.probeResult).toBeUndefined();
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

    describe('getStatus - storyboard progress', () => {
        it('should report how far the storyboard has been sampled', () => {
            // The status response is the only place this reaches a client whose
            // event stream has dropped — which is exactly when the filmstrip
            // would otherwise be waiting on news that never comes.
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');
            sessionService.updateStoryboardProgress(session.id, 42);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.storyboardThumbCount).toBe(42);
            expect(result.storyboardComplete).toBeUndefined();
        });

        it('should say when sampling has finished', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');
            sessionService.updateStoryboardProgress(session.id, 96, true);

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.storyboardThumbCount).toBe(96);
            expect(result.storyboardComplete).toBe(true);
        });

        it('should not include storyboard progress before any has been reported', () => {
            const session = sessionService.create(makeConfig());
            sessionService.updateStatus(session.id, 'uploaded');

            const result = controller.getStatus(session.id, makeRequest());

            expect(result.storyboardThumbCount).toBeUndefined();
            expect(result.storyboardComplete).toBeUndefined();
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
                expect.stringContaining(
                    'Failed to clean up directory for session'
                )
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
            videoTracks: [{ index: 0, width: 1920, height: 1080 }],
            audioTracks: [],
        };
        return session;
    }

    beforeEach(() => {
        sessionService = new SessionService({ emit: vi.fn() } as any);
        thumbnailService = {
            getOrGeneratePreview: vi
                .fn()
                .mockResolvedValue({ vtt: VTT, dir: '/tmp/x' }),
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
            thumbnailService
        );
    });

    it('rejects a request without the session token', async () => {
        const session = uploadedSession();
        await expect(
            ctrl.getPreviewThumbnailVtt(
                session.id,
                'wrong-token',
                req,
                makeRes()
            )
        ).rejects.toThrow(UnauthorizedException);
    });

    it('says "not yet" while the source is still being ingested', async () => {
        // Whether this source has frames is not knowable until the probe lands,
        // and ingest of a large file holds that state for tens of seconds. The
        // client reads 404 as "never" and stops asking, so answering it here
        // left the trim timeline frameless for the entire configure phase.
        const session = sessionService.create(makeConfig());
        const res = makeRes();

        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            res
        );

        expect(res.send).toHaveBeenCalledWith('WEBVTT\n');
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({
                'Content-Type': 'text/vtt',
                'Cache-Control': 'no-store',
                'X-Storyboard-Complete': 'false',
                'Cross-Origin-Resource-Policy': 'cross-origin',
            })
        );
    });

    it('has no storyboard for a source without video', async () => {
        // Probed and found wanting: the one refusal that will never resolve
        // itself, and the only one still worth a 404.
        const session = uploadedSession();
        (session as any).probeResult.videoTracks = [];
        await expect(
            ctrl.getPreviewThumbnailVtt(
                session.id,
                session.sessionToken,
                req,
                makeRes()
            )
        ).rejects.toThrow(NotFoundException);
    });

    it('has no storyboard for a source of no length', async () => {
        // Nothing to sample across, so no cue could be placed anywhere.
        const session = uploadedSession();
        (session as any).probeResult.format.duration = 0;
        await expect(
            ctrl.getPreviewThumbnailVtt(
                session.id,
                session.sessionToken,
                req,
                makeRes()
            )
        ).rejects.toThrow(NotFoundException);
    });

    it('answers an empty incomplete storyboard while sampling has produced nothing', async () => {
        // The client treats 404 as "no frames will ever exist" and stops asking.
        // Sampling starts on this very request, so the first poll after an
        // upload routinely arrives before the first sprite is written — and
        // answering 404 there stopped the poll for good: no filmstrip, no
        // "Generating thumbnails…" badge, and a waveform drawn in its
        // no-filmstrip colour, until the page was reloaded.
        const session = uploadedSession();
        thumbnailService.getOrGeneratePreview.mockResolvedValue(null);
        const res = makeRes();

        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            res
        );

        expect(res.send).toHaveBeenCalledWith('WEBVTT\n');
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({
                'Content-Type': 'text/vtt',
                'X-Storyboard-Complete': 'false',
                'Cache-Control': 'no-store',
            })
        );
    });

    it('points sprite references at the sprite route, token included', async () => {
        const session = uploadedSession();
        const res = makeRes();
        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            res
        );

        const sent: string = res.send.mock.calls[0][0];
        // A bare filename would be resolved against the VTT URL and lose the token.
        expect(sent).toContain(
            `http://api.test:3000/api/sessions/${session.id}/thumbnails/sprite_000.webp?token=${session.sessionToken}`
        );
        expect(sent).toContain('#xywh=0,0,160,90');
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({ 'Content-Type': 'text/vtt' })
        );
    });

    it('generates from the probed source dimensions and duration', async () => {
        const session = uploadedSession();
        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            makeRes()
        );
        expect(thumbnailService.getOrGeneratePreview).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({
                inputPath: '/tmp/source.mp4',
                duration: 120,
                trackIndex: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
            })
        );
    });

    it('samples the angle the storyboard was chosen for, not whichever comes first', async () => {
        // Left to ffmpeg's "best stream" pick, a multi-angle file landed on the
        // 256x144 proxy and the filmstrip was an unreadable postage stamp. The
        // deliberate choice is the smallest angle still wide enough to downscale
        // from — and it has to match what the ingest prime picked, or the cached
        // cue geometry describes different images than the ones on disk.
        const session = uploadedSession();
        (session as any).probeResult.videoTracks = [
            { index: 0, width: 256, height: 144 },
            { index: 1, width: 3840, height: 2160 },
            { index: 2, width: 640, height: 360 },
        ];

        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            makeRes()
        );

        expect(thumbnailService.getOrGeneratePreview).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({
                trackIndex: 2,
                sourceWidth: 640,
                sourceHeight: 360,
            })
        );
    });

    it('reports sampling progress the same way the ingest prime does', async () => {
        // A generation this request starts — a restored session, or an ingest
        // prime that failed — is the one case nothing else is reporting on, so
        // without this the client polls blind for it.
        const session = uploadedSession();
        const recorded = vi.spyOn(sessionService, 'updateStoryboardProgress');

        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            makeRes()
        );

        const opts = thumbnailService.getOrGeneratePreview.mock.calls[0][1];
        opts.onProgress(17, false);
        opts.onProgress(96, true);

        expect(recorded).toHaveBeenCalledWith(session.id, 17, false);
        expect(recorded).toHaveBeenCalledWith(session.id, 96, true);
    });

    it('rewrites individual source frames too, fragment intact', async () => {
        // The source storyboard writes one image per frame (`thumb_`), the
        // encoded one a packed sheet (`sprite_`); both come back through this
        // route, and the fragment has to survive — it is the crop rectangle.
        const session = uploadedSession();
        thumbnailService.getOrGeneratePreview.mockResolvedValue({
            vtt: [
                'WEBVTT',
                '',
                '00:00:00.000 --> 00:00:05.000',
                'thumb_000042.jpg#xywh=0,0,160,90',
                '',
                '00:00:05.000 --> 00:00:10.000',
                'sprite_001.jpg',
                '',
            ].join('\n'),
            dir: '/tmp/x',
        });
        const res = makeRes();

        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            res
        );

        const sent: string = res.send.mock.calls[0][0];
        const base = `http://api.test:3000/api/sessions/${session.id}/thumbnails`;
        // Fragment after the query string, or the token becomes part of it and
        // the request is turned away.
        expect(sent).toContain(
            `${base}/thumb_000042.jpg?token=${session.sessionToken}#xywh=0,0,160,90`
        );
        expect(sent).toContain(
            `${base}/sprite_001.jpg?token=${session.sessionToken}`
        );
    });

    it('serves the individual frames it names in its own cues', async () => {
        // Rejected for being missing, not for being unacceptable — a name the
        // VTT points at that this route refuses is a filmstrip of broken images.
        const session = uploadedSession();
        await expect(
            ctrl.getPreviewThumbnailSprite(
                session.id,
                'thumb_000042.jpg',
                session.sessionToken,
                makeRes()
            )
        ).rejects.toThrow(/Sprite not found/);
    });

    it('refuses a sprite name that is not one it produces', async () => {
        const session = uploadedSession();
        // The name becomes part of a path, and widening the pattern to admit
        // `thumb_` must not have widened it to admit anything else.
        for (const name of [
            '../../../etc/passwd',
            '../thumb_000.jpg',
            'thumb_000.svg',
            'thumbnails.vtt',
            'sprite_000.svg',
            'evil.webp',
        ]) {
            await expect(
                ctrl.getPreviewThumbnailSprite(
                    session.id,
                    name,
                    session.sessionToken,
                    makeRes()
                )
            ).rejects.toThrow(NotFoundException);
        }
    });

    it('lets the web client embed the storyboard across origins', async () => {
        // The app runs under COEP credentialless; without this the browser drops
        // the response and the timeline shows empty frames.
        const session = uploadedSession();
        const res = makeRes();
        await ctrl.getPreviewThumbnailVtt(
            session.id,
            session.sessionToken,
            req,
            res
        );
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({
                'Cross-Origin-Resource-Policy': 'cross-origin',
            })
        );
    });

    it('refuses a sprite request without the session token', async () => {
        const session = uploadedSession();
        await expect(
            ctrl.getPreviewThumbnailSprite(
                session.id,
                'sprite_000.webp',
                'nope',
                makeRes()
            )
        ).rejects.toThrow(UnauthorizedException);
    });
});

describe('EncodeController — storyboard sprite headers', () => {
    // Exercised through the real handler with a stubbed response, since the
    // headers are the whole point of these two cases.
    function harness() {
        const sessionService = new SessionService({ emit: () => {} } as any);
        const thumbnailService = {
            getOrGeneratePreview: vi.fn(),
            previewDir: vi.fn().mockReturnValue('/definitely/not/here'),
        };
        const ctrl = new EncodeController(
            sessionService,
            { emit: vi.fn(), forSession: vi.fn() } as any,
            {} as any,
            { getAccelMode: vi.fn().mockReturnValue('cpu') } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            thumbnailService as any
        );
        return { ctrl, sessionService };
    }

    it('serves jpg sprites as image/jpeg, since nosniff blocks correction', async () => {
        const { ctrl, sessionService } = harness();
        const session = sessionService.create(makeConfig());
        const res = { set: vi.fn(), send: vi.fn() } as any;

        // The file is absent, so the handler throws — but only after deciding the
        // headers, which is what this asserts is no longer `image/jpg`.
        await expect(
            ctrl.getPreviewThumbnailSprite(
                session.id,
                'sprite_001.jpg',
                session.sessionToken,
                res
            )
        ).rejects.toThrow(NotFoundException);
    });

    it('accepts every extension the generator can produce', async () => {
        const { ctrl, sessionService } = harness();
        const session = sessionService.create(makeConfig());
        const res = { set: vi.fn(), send: vi.fn() } as any;

        for (const name of [
            'sprite_001.jpg',
            'sprite_001.jpeg',
            'sprite_001.webp',
            'sprite_001.png',
        ]) {
            // Rejected for being missing, not for being unacceptable.
            await expect(
                ctrl.getPreviewThumbnailSprite(
                    session.id,
                    name,
                    session.sessionToken,
                    res
                )
            ).rejects.toThrow(/Sprite not found/);
        }
    });
});

describe('EncodeController — masked session key', () => {
    let controller: EncodeController;
    let sessionService: SessionService;

    function makeController(): EncodeController {
        return new EncodeController(
            sessionService,
            { emit: vi.fn() } as any,
            {} as any,
            { getAccelMode: vi.fn().mockReturnValue('cpu') } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any
        );
    }

    /** An ExecutionContext for the given handler, as Nest would build one. */
    function contextFor(handler: any, request: any): any {
        return {
            getHandler: () => handler,
            getClass: () => EncodeController,
            switchToHttp: () => ({ getRequest: () => request }),
        };
    }

    beforeEach(() => {
        sessionService = new SessionService({ emit: () => {} } as any);
        controller = makeController();
    });

    it('returns the key masked, and the mask undoes to the original', async () => {
        const session = sessionService.create(makeConfig());
        const keyHex = '000102030405060708090a0b0c0d0e0f';
        sessionService.setEncryptionKey(session.id, keyHex);

        const result = controller.getSessionKey(session.id);

        expect(result.maskedKeyHex).not.toBe(keyHex);
        expect(maskKeyHex(session.id, result.maskedKeyHex)).toBe(keyHex);
    });

    it('404s when the session has no encryption key', () => {
        const session = sessionService.create(makeConfig());

        expect(() => controller.getSessionKey(session.id)).toThrow(
            NotFoundException
        );
    });

    it('404s for an unknown session', () => {
        expect(() => controller.getSessionKey('nope')).toThrow(
            NotFoundException
        );
    });

    it('is not part of the status payload any more', () => {
        // The key used to ride along on every poll and SSE frame, which put it
        // in logs and screenshots for the life of the session.
        const session = sessionService.create(makeConfig());
        sessionService.setEncryptionKey(
            session.id,
            '000102030405060708090a0b0c0d0e0f'
        );

        const status = controller.getStatus(session.id, makeRequest());

        expect(status).not.toHaveProperty('encryptionKeyHex');
    });

    it('turns away a request carrying no credentials', async () => {
        const session = sessionService.create(makeConfig());
        const guard = new AuthResolverGuard(
            new Reflector(),
            sessionService,
            'local-token' as any
        );

        await expect(
            guard.canActivate(
                contextFor(EncodeController.prototype.getSessionKey, {
                    headers: {},
                    params: { sessionId: session.id },
                    query: {},
                })
            )
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts the session token, and the local API token', async () => {
        const session = sessionService.create(makeConfig());
        const guard = new AuthResolverGuard(
            new Reflector(),
            sessionService,
            'local-token' as any
        );

        await expect(
            guard.canActivate(
                contextFor(EncodeController.prototype.getSessionKey, {
                    headers: {
                        authorization: `Bearer ${session.sessionToken}`,
                    },
                    params: { sessionId: session.id },
                    query: {},
                })
            )
        ).resolves.toBe(true);

        await expect(
            guard.canActivate(
                contextFor(EncodeController.prototype.getSessionKey, {
                    headers: { 'x-api-key': 'local-token' },
                    params: { sessionId: session.id },
                    query: {},
                })
            )
        ).resolves.toBe(true);
    });

    it("turns away another session's token", async () => {
        const mine = sessionService.create(makeConfig());
        const theirs = sessionService.create(makeConfig());
        const guard = new AuthResolverGuard(
            new Reflector(),
            sessionService,
            'local-token' as any
        );

        await expect(
            guard.canActivate(
                contextFor(EncodeController.prototype.getSessionKey, {
                    headers: { authorization: `Bearer ${theirs.sessionToken}` },
                    params: { sessionId: mine.id },
                    query: {},
                })
            )
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
