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
import {
    SegmentPipelineService,
    type PipelineProgress,
    type SegmentPipeline,
} from './segment-pipeline.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

function makeMockPipeline(
    keys: string[] = ['master.m3u8', 'v0/playlist.m3u8', 'v0/segment_000.ts']
): SegmentPipeline {
    return {
        start: vi.fn(),
        drain: vi.fn().mockResolvedValue(keys),
        abort: vi.fn(),
        uploadRemainingFiles: vi.fn().mockResolvedValue([]),
        get error() {
            return null;
        },
        get keys() {
            return keys;
        },
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
            packForDelivery: vi.fn().mockResolvedValue({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            }),
            removePreview: vi.fn().mockResolvedValue(undefined),
        } as any;

        waveformService = {
            generateWaveform: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
            cachePath: vi.fn((id: string) =>
                join(testWorkDir, id, 'waveform.json')
            ),
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
            segmentPipelineService
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
        writeFileSync(
            join(outputDir, 'stale_segment.m4s'),
            'from the failed run'
        );

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
            })
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
            })
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
            })
        );
    });

    it('should mark session as failed when FFmpeg errors', async () => {
        ffmpegService.encode.mockRejectedValue(
            new Error('FFmpeg exited with code 1')
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
            new Error('S3 connection refused')
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
        const origUpdateStatus =
            sessionService.updateStatus.bind(sessionService);
        vi.spyOn(sessionService, 'updateStatus').mockImplementation(
            (id, status) => {
                statuses.push(status);
                origUpdateStatus(id, status);
            }
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
            })
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

        expect(
            encryptionService.injectKeyTagsIntoPlaylists
        ).toHaveBeenCalledWith(
            expect.any(String),
            'https://myapp.example.com/keys/abc',
            expect.any(Buffer)
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
            })
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
            })
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
            })
        );

        // Pipeline should receive encryption key/IV
        expect(segmentPipelineService.createPipeline).toHaveBeenCalledWith(
            expect.objectContaining({
                encryptionKey: expect.any(Buffer),
                encryptionIV: expect.any(Buffer),
            })
        );
    });

    it('hands the packer the source timeline and the tracks to lay out', async () => {
        // Nothing is decoded here: the frames were sampled once at ingest, so
        // what the packer needs is which of them the output timeline keeps —
        // the source duration, the trim ranges and the video tracks. The
        // trimmed-duration arithmetic and the concat file moved into the
        // service with it.
        const trimSegments = [{ inSec: 10, outSec: 40 }];
        const videoTracks = [
            {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrateKbps: 5000,
                frameRate: 24,
            },
        ];
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, {
            ...makeEncodeConfig(),
            trimSegments,
        });
        sessionService.setProbeResult(session.id, {
            format: {
                duration: 120,
                bitrateKbps: 5000,
                formatName: 'matroska',
            },
            videoTracks,
            audioTracks: [],
        });

        await service.processSession(session.id);

        expect(thumbnailService.packForDelivery).toHaveBeenCalledWith({
            sessionId: session.id,
            inputPath: '/tmp/input.mp4',
            outputDir: expect.stringContaining('output'),
            sourceDuration: 120,
            trimSegments,
            videoTracks,
        });
    });

    it('does not pack a storyboard when the session asked for no thumbnails', async () => {
        // The flag now gates only the pack and its S3 delivery — the individual
        // thumbs are sampled at ingest either way, because the trim filmstrip
        // needs them. "No thumbnails in the output" is unchanged.
        const config = makeConfig();
        (config as any).thumbnails = false;
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        expect(thumbnailService.packForDelivery).not.toHaveBeenCalled();
    });

    it('should not call thumbnailService for audio-only encodes', async () => {
        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, {
            type: 'audio',
            audioGroups: [
                {
                    id: 'main',
                    label: 'Audio',
                    audioBitrateKbps: 192,
                    channels: 2,
                    audioCodec: 'aac',
                    sourceTrackIndex: 0,
                },
            ],
        });

        await service.processSession(session.id);

        expect(thumbnailService.packForDelivery).not.toHaveBeenCalled();
    });

    it('should complete session even when thumbnail generation fails', async () => {
        // A storyboard is a nicety; the output is already in the bucket. Failing
        // the session over it would report a good encode as a broken one.
        thumbnailService.packForDelivery.mockRejectedValue(
            new Error('FFmpeg thumbnail error')
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
        mockPipeline = makeMockPipeline([
            'master.m3u8',
            'v0/playlist.m3u8',
            'thumbnails/thumbnails.vtt',
            'thumbnails/sprite_001.webp',
        ]);
        (
            segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>
        ).mockReturnValue(mockPipeline);

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
            service.processSession(session.id)
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
            segmentPipelineService
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

    /**
     * The bar reaches 100% when the pipeline drains, but the status stays
     * `encoding` through several more steps — and on a long source the sprite
     * pass alone takes minutes. Unreported, that looks stalled rather than busy.
     */
    describe('post-drain phase reporting', () => {
        async function phasesFor(probeResult?: Record<string, unknown>) {
            const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());
            if (probeResult) {
                (sessionService.get(session.id) as any).probeResult = probeResult;
            }

            await service.processSession(session.id);

            return updateSpy.mock.calls
                .map(([, progress]) => (progress as { phase?: string }).phase)
                .filter((phase, i, all) => phase && phase !== all[i - 1]);
        }

        it('names the drain and the sprite pass, which reported nothing before', async () => {
            // `draining` matters as much as the rest: it runs first, after the
            // bar already reads 100%, and it is where byte-range playlists are
            // rewritten — so leaving it out left the earliest part of the wait
            // unaccounted for.
            expect(await phasesFor()).toEqual([
                'draining',
                'thumbnails',
                'uploading-playlists',
            ]);
        });

        it('names the waveform too, when the source has audio to draw', async () => {
            // The step is gated on the source carrying audio, so a silent
            // sequence here would mean the gate, not the reporting.
            const phases = await phasesFor({
                format: { duration: 10 },
                videoTracks: [{ width: 1920, height: 1080 }],
                audioTracks: [{ index: 0, language: 'eng' }],
            });

            expect(phases).toEqual([
                'draining',
                'thumbnails',
                'waveform',
                'uploading-playlists',
            ]);
        });

        it('never lets a finished step caption the upload after it', async () => {
            // The upload has a caption of its own, and it has to be in place
            // before the status changes: one event carrying the previous step's
            // phase would attribute the upload to whatever ran before it, which
            // is the thing this caption exists to prevent.
            const updateSpy = vi.spyOn(sessionService, 'updatePipelineProgress');
            const statusSpy = vi.spyOn(sessionService, 'updateStatus');
            const session = sessionService.create(makeConfig());
            sessionService.setFilePath(session.id, '/tmp/input.mp4');
            sessionService.setEncodeConfig(session.id, makeEncodeConfig());

            await service.processSession(session.id);

            const flipOrder = statusSpy.mock.invocationCallOrder[
                statusSpy.mock.calls.findIndex(
                    ([, status]) => status === 'uploading_to_s3'
                )
            ];
            // The last caption emitted before the status flipped.
            const captionAtFlip = updateSpy.mock.calls
                .filter((_, i) => updateSpy.mock.invocationCallOrder[i] < flipOrder)
                .map(([, progress]) => (progress as { phase?: string }).phase)
                .at(-1);

            expect(captionAtFlip).toBe('uploading-playlists');

            const last = updateSpy.mock.calls.at(-1)?.[1] as { phase?: string };
            expect(last.phase).toBe('uploading-playlists');
        });
    });

    it('should invoke pipeline onProgress and update session pipeline progress', async () => {
        let capturedOnProgress: ((update: any) => void) | undefined;
        (
            segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>
        ).mockImplementation((opts: any) => {
            capturedOnProgress = opts.onProgress;
            return mockPipeline;
        });

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
            })
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
            expect.objectContaining({ encoding: 10 })
        );

        updateSpy.mockClear();
        capturedOnProgress!(3);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 3 })
        );

        updateSpy.mockClear();
        capturedOnProgress!(99);
        expect(updateSpy).toHaveBeenCalledWith(
            session.id,
            expect.objectContaining({ encoding: 99 })
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
            segmentPipelineService
        );

        const loggerWarnSpy = vi.spyOn((service as any).logger, 'warn');

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('completed');
        expect(loggerWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to clean up session')
        );
    });

    it('should throw when pipeline.error is set after FFmpeg completes', async () => {
        const errorPipeline = {
            start: vi.fn(),
            drain: vi.fn().mockResolvedValue([]),
            abort: vi.fn(),
            uploadRemainingFiles: vi.fn().mockResolvedValue([]),
            get error() {
                return new Error('Pipeline segment upload failed');
            },
            get keys() {
                return [];
            },
        } as any;
        (
            segmentPipelineService.createPipeline as ReturnType<typeof vi.fn>
        ).mockReturnValue(errorPipeline);

        const session = sessionService.create(makeConfig());
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());

        await service.processSession(session.id);

        const updated = sessionService.get(session.id)!;
        expect(updated.status).toBe('failed');
        expect(updated.error).toBe('Pipeline segment upload failed');
    });
});

describe('EncodeService — encrypting the text assets last', () => {
    let service: EncodeService;
    let sessionService: SessionService;
    let encryptionService: Mocked<EncryptionService>;
    let thumbnailService: Mocked<ThumbnailService>;
    let mockPipeline: SegmentPipeline;
    let calls: string[];
    let testWorkDir: string;

    function makeEncryptedConfig(encryptPlaylists: boolean): CreateSessionDto {
        return {
            ...makeConfig(),
            encryption: { enabled: true, encryptPlaylists },
        };
    }

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-order-'));
        process.env.WORK_DIR = testWorkDir;
        calls = [];

        sessionService = new SessionService({ emit: () => {} } as any);

        const ffmpegService = {
            encode: vi.fn().mockResolvedValue({
                outputDir: '/tmp/output',
                masterPlaylist: 'master.m3u8',
                segmentFormat: 'fmp4',
            }),
        } as any;

        encryptionService = {
            generateKey: vi.fn().mockReturnValue(Buffer.alloc(16, 0xcd)),
            generateIV: vi.fn().mockReturnValue(Buffer.alloc(16, 0xab)),
            injectKeyTagsIntoPlaylists: vi.fn(async () => {
                calls.push('injectKeyTags');
            }),
            encryptTextAssets: vi.fn(async () => {
                calls.push('encryptTextAssets');
                return ['master.m3u8'];
            }),
        } as any;

        thumbnailService = {
            packForDelivery: vi.fn(async () => {
                calls.push('thumbnails');
                return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
            }),
            removePreview: vi.fn().mockResolvedValue(undefined),
        } as any;

        const waveformService = {
            generateWaveform: vi.fn().mockResolvedValue([0.1]),
            cachePath: vi.fn().mockReturnValue(join(testWorkDir, 'nope.json')),
        } as any;

        mockPipeline = {
            start: vi.fn(),
            drain: vi.fn(async () => {
                calls.push('drain');
                return [];
            }),
            abort: vi.fn(),
            uploadRemainingFiles: vi.fn(async () => {
                calls.push('uploadRemainingFiles');
                return [];
            }),
            get error() {
                return null;
            },
            get keys() {
                return ['out/master.m3u8'];
            },
        } as any;

        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            waveformService,
            {} as any,
            { createPipeline: vi.fn().mockReturnValue(mockPipeline) } as any,
        );
    });

    afterEach(() => {
        rmSync(testWorkDir, { recursive: true, force: true });
        delete process.env.WORK_DIR;
    });

    async function run(config: CreateSessionDto): Promise<void> {
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, makeEncodeConfig());
        await service.processSession(session.id);
    }

    it('encrypts after the drain, the key tags and the thumbnail VTT, and before the upload', async () => {
        // Order is the whole contract: every step above reads or rewrites a
        // playlist, and every one of them would be parsing ciphertext if the
        // encryption moved up. The upload has to come after, or plaintext
        // reaches the bucket.
        await run(makeEncryptedConfig(true));

        expect(calls).toEqual([
            'drain',
            'injectKeyTags',
            'thumbnails',
            'encryptTextAssets',
            'uploadRemainingFiles',
        ]);
    });

    it('hands the encryptor the output directory and the session key', async () => {
        await run(makeEncryptedConfig(true));

        expect(encryptionService.encryptTextAssets).toHaveBeenCalledWith(
            expect.stringContaining('output'),
            Buffer.alloc(16, 0xcd),
        );
    });

    it('leaves the text assets alone when the session opted out', async () => {
        await run(makeEncryptedConfig(false));

        expect(encryptionService.injectKeyTagsIntoPlaylists).toHaveBeenCalled();
        expect(encryptionService.encryptTextAssets).not.toHaveBeenCalled();
    });

    it('leaves the text assets alone when the session is not encrypted at all', async () => {
        await run(makeConfig());

        expect(encryptionService.encryptTextAssets).not.toHaveBeenCalled();
    });
});

/**
 * Everything between the last segment and the completion event — packing the
 * storyboard, writing the waveform, encrypting the playlists, uploading them —
 * used to happen in silence. On a long encode that is several minutes with
 * every bar frozen at 100% and no way to tell a working session from a hung
 * one. Each step now names itself, and the bars keep their values while it does.
 */
describe('EncodeService — naming the finalize phases', () => {
    let service: EncodeService;
    let sessionService: SessionService;
    let thumbnailService: Mocked<ThumbnailService>;
    let waveformService: Mocked<WaveformService>;
    let mockPipeline: SegmentPipeline;
    let emissions: PipelineProgress[];
    /** Whatever `uploadRemainingFiles` was handed to report per-file progress. */
    let onFileProgress:
        | ((done: number, total: number) => void)
        | undefined;
    let testWorkDir: string;

    /** An encode with every finalize step in play: video, audio, encryption. */
    function makeFullConfig(): CreateSessionDto {
        return { ...makeConfig(), encryption: { enabled: true } };
    }

    const probeWithAudio = {
        format: { duration: 120, bitrateKbps: 5000, formatName: 'matroska' },
        videoTracks: [
            {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrateKbps: 5000,
                frameRate: 24,
            },
        ],
        audioTracks: [
            { index: 1, codec: 'aac', channels: 2, bitrateKbps: 192 },
        ],
    } as any;

    beforeEach(() => {
        testWorkDir = mkdtempSync(join(tmpdir(), 'luminary-phase-'));
        process.env.WORK_DIR = testWorkDir;
        emissions = [];
        onFileProgress = undefined;

        sessionService = new SessionService({ emit: () => {} } as any);
        vi.spyOn(sessionService, 'updatePipelineProgress').mockImplementation(
            (_id, progress) => {
                emissions.push(progress);
            }
        );

        const ffmpegService = {
            // Real FFmpeg creates the output directory it writes into, and the
            // waveform sidecar is written there — without it that step fails
            // for a reason no user would ever hit.
            encode: vi.fn(async (opts: any) => {
                mkdirSync(opts.outputDir, { recursive: true });
                return {
                    outputDir: opts.outputDir,
                    masterPlaylist: 'master.m3u8',
                    segmentFormat: 'fmp4',
                };
            }),
        } as any;

        const encryptionService = {
            generateKey: vi.fn().mockReturnValue(Buffer.alloc(16, 0xcd)),
            generateIV: vi.fn().mockReturnValue(Buffer.alloc(16, 0xab)),
            injectKeyTagsIntoPlaylists: vi.fn().mockResolvedValue(undefined),
            encryptTextAssets: vi.fn().mockResolvedValue([]),
        } as any;

        thumbnailService = {
            packForDelivery: vi.fn().mockResolvedValue({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            }),
            removePreview: vi.fn().mockResolvedValue(undefined),
        } as any;

        waveformService = {
            generateWaveform: vi.fn().mockResolvedValue([0.1, 0.2]),
            cachePath: vi.fn((id: string) =>
                join(testWorkDir, id, 'waveform-cache.json')
            ),
        } as any;

        mockPipeline = {
            start: vi.fn(),
            drain: vi.fn().mockResolvedValue([]),
            abort: vi.fn(),
            uploadRemainingFiles: vi.fn(async (_dir: string, opts?: any) => {
                onFileProgress = opts?.onFileProgress;
                return [];
            }),
            get error() {
                return null;
            },
            get keys() {
                return ['master.m3u8'];
            },
        } as any;

        service = new EncodeService(
            sessionService,
            ffmpegService,
            encryptionService,
            thumbnailService,
            waveformService,
            {} as any,
            { createPipeline: vi.fn().mockReturnValue(mockPipeline) } as any
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(testWorkDir, { recursive: true, force: true });
        delete process.env.WORK_DIR;
    });

    async function run(
        config: CreateSessionDto,
        encodeConfig: EncodeConfigDto = makeEncodeConfig(),
        probeResult: any = probeWithAudio
    ): Promise<string> {
        const session = sessionService.create(config);
        sessionService.setFilePath(session.id, '/tmp/input.mp4');
        sessionService.setEncodeConfig(session.id, encodeConfig);
        if (probeResult) sessionService.setProbeResult(session.id, probeResult);
        await service.processSession(session.id);
        return session.id;
    }

    /** The labels in the order they first appeared, ignoring repeats. */
    const phaseSequence = (): (string | undefined)[] =>
        emissions
            .map((p) => p.phase)
            .filter((phase, i, all) => phase && phase !== all[i - 1]);

    it('names every finalize step, in the order they run', async () => {
        await run(makeFullConfig());

        expect(phaseSequence()).toEqual([
            'draining',
            'finalising-playlists',
            'thumbnails',
            'waveform',
            'encrypting-playlists',
            'uploading-playlists',
        ]);
    });

    it('keeps the bars alongside the label rather than replacing them', async () => {
        // The label rides on the same progress object the bars do, so a
        // phase-bearing emission that dropped `encoding` would blank the bar it
        // is meant to explain. FFmpeg's own reporting stops a hair short, so
        // encoding is pinned to 100 once the drain is provably over.
        await run(makeFullConfig());

        const labelled = emissions.filter((p) => p.phase);
        expect(labelled.length).toBeGreaterThan(0);
        for (const progress of labelled) {
            expect(progress.encoding).toBe(100);
            expect(progress.uploading).toBeDefined();
        }
    });

    it('does not zero the overall progress before the final upload', async () => {
        // That reset dropped the session's own percentage back to 0 just as the
        // last phase started, so the UI showed a finished encode restarting.
        const updateProgress = vi.spyOn(sessionService, 'updateProgress');

        await run(makeFullConfig());

        expect(updateProgress).not.toHaveBeenCalled();
    });

    it('says nothing about thumbnails for an audio-only encode', async () => {
        await run(makeFullConfig(), {
            type: 'audio',
            audioGroups: makeEncodeConfig().audioGroups,
        });

        expect(phaseSequence()).not.toContain('Generating thumbnails');
    });

    it('says nothing about thumbnails when the session asked for none', async () => {
        await run({ ...makeFullConfig(), thumbnails: false } as any);

        expect(phaseSequence()).not.toContain('Generating thumbnails');
        expect(thumbnailService.packForDelivery).not.toHaveBeenCalled();
    });

    it('says nothing about encryption for an unencrypted session', async () => {
        await run(makeConfig());

        expect(phaseSequence()).not.toContain('encrypting-playlists');
    });

    it('says nothing about a waveform when the source has no audio', async () => {
        await run(makeFullConfig(), makeEncodeConfig(), {
            ...probeWithAudio,
            audioTracks: [],
        });

        expect(phaseSequence()).not.toContain('waveform');
        expect(waveformService.generateWaveform).not.toHaveBeenCalled();
    });

    describe('the remaining-files upload bar', () => {
        it('is driven by the file count the pipeline reports', async () => {
            await run(makeFullConfig());

            expect(mockPipeline.uploadRemainingFiles).toHaveBeenCalledWith(
                expect.stringContaining('output'),
                expect.objectContaining({
                    onFileProgress: expect.any(Function),
                })
            );
            expect(onFileProgress).toBeDefined();

            emissions.length = 0;
            onFileProgress!(1, 4);
            onFileProgress!(3, 4);
            onFileProgress!(4, 4);

            expect(emissions.map((p) => p.uploading)).toEqual([25, 75, 100]);
            expect(
                emissions.every(
                    (p) => p.phase === 'uploading-playlists'
                )
            ).toBe(true);
        });

        it('reads 100 rather than NaN when there is nothing left to upload', async () => {
            await run(makeFullConfig());

            emissions.length = 0;
            onFileProgress!(0, 0);

            expect(emissions.at(-1)?.uploading).toBe(100);
        });

        it('starts the bar from zero, because it is counting different files', async () => {
            // Until now it counted segments; these are playlists and sprites.
            // The phase text is what explains the reset to the user.
            await run(makeFullConfig());

            const uploadPhase = emissions.filter(
                (p) => p.phase === 'uploading-playlists'
            );
            expect(uploadPhase[0].uploading).toBe(0);
        });
    });
});
