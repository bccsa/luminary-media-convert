import { type Mocked } from 'vitest';

const { mockFreeBytes } = vi.hoisted(() => ({
    mockFreeBytes: vi.fn().mockResolvedValue(null),
}));

vi.mock('./disk-space.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./disk-space.js')>()),
    freeBytes: (...args: any[]) => mockFreeBytes(...args),
}));

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncodeService } from './encode.service.js';
import { SessionService } from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { EncryptionService } from './encryption.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { WaveformService } from './waveform.service.js';
import { S3Service } from './s3.service.js';
import { SegmentPipelineService, type SegmentPipeline } from './segment-pipeline.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

function makeMockPipeline(keys: string[] = ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts']): SegmentPipeline {
    return {
        start: vi.fn(),
        drain: vi.fn().mockResolvedValue(keys),
        abort: vi.fn(),
        uploadRemainingFiles: vi.fn().mockResolvedValue([]),
        get error() { return null; },
        get keys() { return keys; },
    } as any;
}

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

describe('EncodeService', () => {
    let service: EncodeService;
    let sessionService: SessionService;
    let ffmpegService: Mocked<FfmpegService>;
    let encryptionService: Mocked<EncryptionService>;
    let thumbnailService: Mocked<ThumbnailService>;
    let waveformService: Mocked<WaveformService>;
    let s3Service: Mocked<S3Service>;
    let segmentPipelineService: Mocked<SegmentPipelineService>;
    let mockPipeline: SegmentPipeline;
    let testWorkDir: string;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-test-'));
        process.env.WORK_DIR = testWorkDir;

        sessionService = new SessionService({ emit: () => {} } as any);

        ffmpegService = {
            encode: vi.fn().mockResolvedValue({
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                segmentFormat: 'fmp4',
            }),
        } as any;

        encryptionService = {
            generateKey: vi.fn().mockReturnValue(Buffer.alloc(16, 0xcd)),
            generateIV: vi.fn().mockReturnValue(Buffer.alloc(16, 0xab)),
            encryptSegment: vi.fn().mockResolvedValue(undefined),
            injectKeyTagsIntoPlaylists: vi.fn().mockResolvedValue(undefined),
        } as any;

        thumbnailService = {
            generateThumbnails: vi.fn().mockResolvedValue({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            }),
            removePreview: vi.fn().mockResolvedValue(undefined),
        } as any;

        waveformService = {
            generateWaveform: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        } as any;

        // Uploads run through SegmentPipelineService, mocked below; this stands
        // in only for the prefix helper the encode path reads off the class.
        s3Service = {} as any;

        mockPipeline = makeMockPipeline();

        segmentPipelineService = {
            createPipeline: vi.fn().mockReturnValue(mockPipeline),
        } as any;

        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            waveformService,
            s3Service,
            segmentPipelineService,
        );
    });

    afterEach(() => {
        try {
            rmSync(testWorkDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
        delete process.env.WORK_DIR;
    });

    it('should skip processing for unknown session', async () => {
        await service.processSession('nonexistent');

        expect(ffmpegService.encode).not.toHaveBeenCalled();
        expect(segmentPipelineService.createPipeline).not.toHaveBeenCalled();
    });

    it('should fail when session has no encode config', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('No encoding configuration provided');
    });

    it('drops the source storyboard once the encode has produced its own', async () => {
        // Built at upload for the trim timeline. After completion the client reads
        // the storyboard from S3, and nothing prunes the session directory until
        // the session is deleted.
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(thumbnailService.removePreview).toHaveBeenCalledWith(session.id);
    });

    it('still completes when the source storyboard cannot be removed', async () => {
        thumbnailService.removePreview.mockRejectedValue(new Error('EBUSY'));
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(sessionService.get(session.id)?.status).toBe('completed');
    });

    /**
     * Every uploaded key — segments, playlists and sidecars — is built from the
     * prefix handed to the pipeline, so this is the only place normalizing it
     * has any effect. An earlier fix normalized a different upload method that
     * turned out to have no callers, and a prefix typed with a leading slash
     * still reached storage; that method has since been removed.
     */
    describe('s3 path prefix given to the pipeline', () => {
        const prefixPassedToPipeline = () =>
            (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>)
                .mock.calls[0][0].s3PathPrefix;

        async function runWithPrefix(pathPrefix: string) {
            const config = makeConfig();
            config.s3.pathPrefix = pathPrefix;
            const session = sessionService.create(config);
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            await service.processSession(session.id);
        }

        it('drops a leading slash so keys do not begin with one', async () => {
            await runWithPrefix('/videos');

            expect(prefixPassedToPipeline()).toBe('videos');
        });

        it('collapses doubled separators', async () => {
            await runWithPrefix('//videos//project-1//');

            expect(prefixPassedToPipeline()).toBe('videos/project-1');
        });

        it('treats a prefix of only slashes as none', async () => {
            await runWithPrefix('/');

            expect(prefixPassedToPipeline()).toBe('');
        });

        it('leaves an already-canonical prefix alone', async () => {
            await runWithPrefix('videos/project-1');

            expect(prefixPassedToPipeline()).toBe('videos/project-1');
        });
    });

    /**
     * Running out of space used to surface as a raw ENOSPC from whatever line
     * touched the disk first — after the source had been uploaded, the job
     * queued, and in one case forty minutes of encoding spent.
     */
    describe('refusing an encode that cannot fit', () => {
        function withFreeBytes(bytes: number | null) {
            mockFreeBytes.mockResolvedValue(bytes);
        }

        afterEach(() => {
            vi.restoreAllMocks();
            // Unread by default, so the guard stays silent for every test that
            // is not about it.
            mockFreeBytes.mockResolvedValue(null);
        });

        it('fails before encoding when the output cannot fit', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            (sessionService.get(session.id) as any).probeResult = {
                format: { duration: 3600 },
            };
            withFreeBytes(10 * 1024 ** 2); // 10 MB

            await service.processSession(session.id);

            expect(sessionService.get(session.id)?.status).toBe('failed');
            expect(ffmpegService.encode).not.toHaveBeenCalled();
        });

        it('says how much is needed and how much is free', async () => {
            // The old message was an errno and a path; this one has to be
            // actionable by whoever reads it.
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            (sessionService.get(session.id) as any).probeResult = {
                format: { duration: 3600 },
            };
            withFreeBytes(10 * 1024 ** 2);

            await service.processSession(session.id);

            const error = sessionService.get(session.id)?.error ?? '';
            expect(error).toMatch(/needs about .* and only .* is free/);
            expect(error).toMatch(/source is kept/);
        });

        it('proceeds when there is room', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            (sessionService.get(session.id) as any).probeResult = {
                format: { duration: 3600 },
            };
            withFreeBytes(500 * 1024 ** 3); // 500 GB

            await service.processSession(session.id);

            expect(ffmpegService.encode).toHaveBeenCalled();
        });

        it('proceeds when free space cannot be read', async () => {
            // A missing figure is a reason to carry on as before, not to refuse.
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            (sessionService.get(session.id) as any).probeResult = {
                format: { duration: 3600 },
            };
            withFreeBytes(null);

            await service.processSession(session.id);

            expect(ffmpegService.encode).toHaveBeenCalled();
        });

        it('proceeds when the duration is unknown', async () => {
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            withFreeBytes(1024); // 1 KB — would refuse if it could estimate

            await service.processSession(session.id);

            expect(ffmpegService.encode).toHaveBeenCalled();
        });
    });

    it('keeps the source but drops the output when an encode fails', async () => {
        // The source is what makes a retry possible without re-uploading; the
        // output is regenerable, and an abandoned 4.9 GB of it was sitting on a
        // volume that had run out of space.
        const session = sessionService.create(makeConfig());
        const sourcePath = join(testWorkDir, session.id, 'input.mkv');
        mkdirSync(join(testWorkDir, session.id), { recursive: true });
        writeFileSync(sourcePath, 'source bytes');
        sessionService.setFilePath(session.id, sourcePath);
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        const outputDir = join(testWorkDir, session.id, 'output');
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, 'partial.m4s'), 'half an encode');

        ffmpegService.encode.mockRejectedValueOnce(new Error('boom'));
        await service.processSession(session.id);

        expect(sessionService.get(session.id)?.status).toBe('failed');
        expect(existsSync(sourcePath)).toBe(true);
        expect(existsSync(outputDir)).toBe(false);
    });

    it('clears output left by a previous attempt before re-encoding', async () => {
        // A retry inherits whatever the failed run left behind. Segments from
        // the abandoned attempt would be picked up by the pipeline and packed
        // into playlists alongside the new ones — and the stale output was
        // holding 4.9 GB on a volume that had run out of space.
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        const outputDir = join(testWorkDir, session.id, 'output');
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, 'stale_segment.m4s'), 'from the failed run');

        await service.processSession(session.id);

        expect(existsSync(join(outputDir, 'stale_segment.m4s'))).toBe(false);
    });

    it('should run full pipeline: encode -> s3 -> completed', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledTimes(1);
        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: session.id,
                inputPath: '/tmp/input.mp4',
                encodeConfig: expect.objectContaining({ type: 'video' }),
            }),
        );

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledTimes(1);
        expect(mockPipeline.start).toHaveBeenCalledTimes(1);
        expect(mockPipeline.drain).toHaveBeenCalledTimes(1);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(updated.files).toEqual([
            'master.m3u8',
            'v0/playlist.m3u8',
            'v0/segment_000.ts',
        ]);
        expect(updated.masterPlaylist).toBe('master.m3u8');
    });



    it('should always pass byteRange: false to ffmpeg (pipeline handles byte-range)', async () => {
        const config = makeConfig();
        config.byteRange = true;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
            }),
        );
    });

    it('should pass session byteRange config to the pipeline', async () => {
        const config = makeConfig();
        config.byteRange = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
            }),
        );
    });

    it('should mark session as failed when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg exited with code 1'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('FFmpeg exited with code 1');
    });


    it('should mark session as failed when pipeline drain errors', async () => {
        (mockPipeline.drain as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error('S3 connection refused'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('S3 connection refused');
    });

    it('should update status through encoding phases', async () => {
        const statuses: string[] = [];
        const origUpdateStatus = sessionService.updateStatus.bind(sessionService);
        vi.spyOn(sessionService, 'updateStatus').mockImplementation(
            (id, status) => {
                statuses.push(status);
                origUpdateStatus(id, status);
            },
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(statuses).toContain('encoding');
        expect(statuses).toContain('uploading_to_s3');
    });


    it('should pre-compute encryption materials and pass to pipeline when encryption is enabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        // Random per encode rather than derived from a shared secret, so a
        // leaked key compromises exactly one session's output.
        expect(encryptionService.generateKey).toHaveBeenCalled();
        expect(encryptionService.generateIV).toHaveBeenCalled();

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: expect.any(Buffer),
                encryptionIV: expect.any(Buffer),
            }),
        );
    });

    it('should inject key tags into playlists after drain when encryption is enabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(encryptionService.injectKeyTagsIntoPlaylists).toHaveBeenCalledWith(
            expect.any(String),
            'https://myapp.example.com/keys/abc',
            expect.any(Buffer),
        );
    });

    it('should not set encryption materials on pipeline when encryption is disabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: false,
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: undefined,
                encryptionIV: undefined,
            }),
        );
    });

    it('should not set encryption materials when no encryption config provided', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: undefined,
                encryptionIV: undefined,
            }),
        );
    });


    it('should pass encryption config to pipeline when encryption is enabled', async () => {
        const config: CreateSessionDto = {
            ...makeConfig(),
            encryption: {
                enabled: true,
                keyUrl: 'https://myapp.example.com/keys/abc',
            },
        };
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        // FFmpeg always gets byteRange: false, no preByteRangeHook (pipeline handles both)
        expect(ffmpegService.encode).toHaveBeenCalledWith(
            expect.objectContaining({
                byteRange: false,
                preByteRangeHook: undefined,
            }),
        );

        // Pipeline should receive encryption key/IV
        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: expect.any(Buffer),
                encryptionIV: expect.any(Buffer),
            }),
        );
    });

    it('should call thumbnailService for video encodes by default', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());
        sessionService.setProbeResult(session.id, {
            format: { duration: 120, bitrateKbps: 5000, formatName: 'matroska' },
            videoTracks: [{ index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 5000, frameRate: 24 }],
            audioTracks: [],
        });

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).toHaveBeenCalledWith(
            expect.objectContaining({
                inputPath: '/tmp/input.mp4',
                duration: 120,
                sourceWidth: 1920,
                sourceHeight: 1080,
            }),
        );
    });

    it('should not call thumbnailService when thumbnails is false', async () => {
        const config = makeConfig();
        (config as any).thumbnails = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).not.toHaveBeenCalled();
    });

    it('should not call thumbnailService for audio-only encodes', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, {
            type: 'audio',
            audioGroups: [
                { id: 'main', label: 'Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
            ],
        });

        await service.processSession(session.id);

        expect(thumbnailService.generateThumbnails).not.toHaveBeenCalled();
    });

    it('should complete session even when thumbnail generation fails', async () => {
        thumbnailService.generateThumbnails.mockRejectedValue(
            new Error('FFmpeg thumbnail error'),
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(updated.thumbnailsVtt).toBeUndefined();
    });

    it('records the thumbnail VTT on the completed session', async () => {
        mockPipeline = makeMockPipeline(['master.m3u8', 'v0/playlist.m3u8', 'thumbnails/thumbnails.vtt', 'thumbnails/sprite_001.webp']);
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockReturnValue(mockPipeline);

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.thumbnailsVtt).toBe('thumbnails/thumbnails.vtt');
    });

    it('should not throw even when everything fails', async () => {
        ffmpegService.encode.mockRejectedValue(new Error('fail'));

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await expect(
            service.processSession(session.id),
        ).resolves.toBeUndefined();
    });

    it('should complete session even when work directory does not exist for cleanup', async () => {
        // Point WORK_DIR to a non-existent path; rm with force:true won't throw
        process.env.WORK_DIR = '/tmp/nonexistent-luminary-test-cleanup';
        // Re-create service so it picks up the new WORK_DIR
        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            waveformService,
            s3Service,
            segmentPipelineService,
        );

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
    });

    describe('work directory cleanup', () => {
        /** Put a source upload and a preview cache where a real session would have them. */
        function seedSessionFiles(sessionId: string): {
            sourcePath: string;
            previewDir: string;
            statePath: string;
        } {
            const sessionDir = join(testWorkDir, sessionId);
            const previewDir = join(sessionDir, 'preview');
            mkdirSync(previewDir, { recursive: true });
            const sourcePath = join(sessionDir, 'input.mp4');
            writeFileSync(sourcePath, 'source bytes');
            writeFileSync(join(previewDir, 'r0.ts'), 'preview bytes');
            return {
                sourcePath,
                previewDir,
                statePath: join(sessionDir, 'session.json'),
            };
        }

        it('drops the source upload and preview cache once the encode completes', async () => {
            const session = sessionService.create(makeConfig());
            const { sourcePath, previewDir } = seedSessionFiles(session.id);
            sessionService.setFilePath(session.id, sourcePath);
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());

            await service.processSession(session.id);

            expect(sessionService.get(session.id)!.status).toBe('completed');
            expect(existsSync(sourcePath)).toBe(false);
            expect(existsSync(previewDir)).toBe(false);
        });

        it('keeps the session record, so a completed session survives a restart', async () => {
            const session = sessionService.create(makeConfig());
            const { statePath } = seedSessionFiles(session.id);
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());

            await service.processSession(session.id);

            // Clearing the whole directory used to take this with it, which left
            // the client being told its just-completed session had expired.
            expect(existsSync(statePath)).toBe(true);
        });

        it('keeps the source when the encode fails, so the input can be inspected', async () => {
            ffmpegService.encode.mockRejectedValue(new Error('boom'));

            const session = sessionService.create(makeConfig());
            const { sourcePath } = seedSessionFiles(session.id);
            sessionService.setFilePath(session.id, sourcePath);
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());

            await service.processSession(session.id);

            expect(sessionService.get(session.id)!.status).toBe('failed');
            // Reclaimed by the scheduled sweep once it ages out, not here.
            expect(existsSync(sourcePath)).toBe(true);
        });
    });

    it('should invoke pipeline onProgress and update session pipeline progress', async () => {
        let capturedOnProgress: ((update: any) => void) | undefined;
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockImplementation(
            (opts: any) => {
                capturedOnProgress = opts.onProgress;
                return mockPipeline;
            },
        );

        const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(capturedOnProgress).toBeDefined();
        // Invoke the pipeline onProgress callback with encrypting/uploading values
        capturedOnProgress!({ encrypting: 30, uploading: 20 });

        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({
                encrypting: 30,
                uploading: 20,
            }),
        );
    });

    it('reports encoding progress through the session pipeline progress', async () => {
        let capturedOnProgress: ((percent: number) => void) | undefined;
        ffmpegService.encode.mockImplementation(async (opts: any) => {
            capturedOnProgress = opts.onProgress;
            return {
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                segmentFormat: 'fmp4',
            };
        });

        const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(capturedOnProgress).toBeDefined();

        updateSpy.mockClear();

        // Every tick is reported now. The old 5% throttle existed to rate-limit
        // webhook deliveries over the network; SSE carries progress to a client
        // on the same machine, so there is nothing left to spare.
        capturedOnProgress!(10);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 10 }),
        );

        updateSpy.mockClear();
        capturedOnProgress!(3);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 3 }),
        );

        updateSpy.mockClear();
        capturedOnProgress!(99);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 99 }),
        );
    });

    it('should warn but not throw when cleanup fails', async () => {
        // Point WORK_DIR to /dev/null — rm recursive on a device file triggers ENOTDIR
        process.env.WORK_DIR = '/dev/null';
        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            waveformService,
            s3Service,
            segmentPipelineService,
        );

        const loggerWarnSpy = vi.spyOn((service as any).logger, 'warn');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(loggerWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to clean up session'),
        );
    });

    it('should throw when pipeline.error is set after FFmpeg completes', async () => {
        const errorPipeline = {
            start: vi.fn(),
            drain: vi.fn().mockResolvedValue([]),
            abort: vi.fn(),
            uploadRemainingFiles: vi.fn().mockResolvedValue([]),
            get error() { return new Error('Pipeline segment upload failed'); },
            get keys() { return []; },
        } as any;
        (segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>).mockReturnValue(errorPipeline);

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('Pipeline segment upload failed');
    });
});
