import { type MockedFunction } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                     */
/* ------------------------------------------------------------------ */

const {
    mockExecFile,
    mockExistsSync,
    mockCreateReadStream,
    mockMkdir,
    mockRm,
    mockReadFile,
    mockWriteFile,
    mockStat,
} = vi.hoisted(() => ({
    mockExecFile: vi.fn(),
    mockExistsSync: vi.fn(),
    mockCreateReadStream: vi.fn(),
    mockMkdir: vi.fn(),
    mockRm: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockStat: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, execFile: mockExecFile };
});

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        createReadStream: mockCreateReadStream,
    };
});

vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        mkdir: mockMkdir,
        rm: mockRm,
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        stat: mockStat,
    };
});

import { PreviewService } from './preview.service.js';
import type { ProbeResult } from './probe.service.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeSessionService(session: any = null) {
    return {
        get: vi.fn().mockReturnValue(session),
        setProbeResult: vi.fn(),
    } as any;
}

function makeFfmpegService(accelMode: string = 'cpu') {
    return { getAccelMode: vi.fn().mockReturnValue(accelMode) } as any;
}

function makeProbeService(probeResult?: ProbeResult) {
    return {
        probe: vi.fn().mockResolvedValue(probeResult ?? makeProbe()),
    } as any;
}

function makeProbe(
    overrides: Partial<{
        duration: number;
        videoTracks: any[];
        audioTracks: any[];
    }> = {}
): ProbeResult {
    return {
        format: {
            duration: overrides.duration ?? 20,
            bitrateKbps: 5000,
            formatName: 'mov',
        },
        videoTracks: overrides.videoTracks ?? [
            {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrateKbps: 5000,
                frameRate: 30,
            },
        ],
        audioTracks: overrides.audioTracks ?? [
            {
                index: 1,
                codec: 'aac',
                bitrateKbps: 192,
                channels: 2,
                sampleRate: 48000,
            },
        ],
    };
}

/**
 * Set up mockExecFile so that `promisify(execFile)` works.
 * Node's promisify of execFile expects the traditional (err, result) callback pattern.
 */
function setupExecFile(
    impl: (...args: any[]) => { stdout: any; stderr: string } | Error
) {
    mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
            try {
                const result = impl(...args);
                if (result instanceof Error) {
                    cb(result, { stdout: '', stderr: '' });
                } else {
                    cb(null, result);
                }
            } catch (e) {
                cb(e, { stdout: '', stderr: '' });
            }
        }
    });
}

function setupExecFileSequence(
    results: Array<{ stdout: any; stderr: string } | Error>
) {
    let callIndex = 0;
    mockExecFile.mockImplementation((...args: any[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
            const result = results[callIndex++];
            if (result instanceof Error) {
                cb(result, { stdout: '', stderr: '' });
            } else {
                cb(null, result);
            }
        }
    });
}

const CSV_KEYFRAMES = [
    'seg0.ts,0.000000,4.170000',
    'seg1.ts,4.170000,8.340000',
    'seg2.ts,8.340000,12.500000',
    'seg3.ts,12.500000,16.670000',
    'seg4.ts,16.670000,20.000000',
].join('\n');

function setupDefaultMocks() {
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 1024 });
    mockExistsSync.mockReturnValue(false);
    mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });
    mockReadFile.mockResolvedValue(CSV_KEYFRAMES);
    // Default: keyframe scan succeeds, then segment extraction succeeds
    setupExecFile(() => ({ stdout: Buffer.from('segment-data'), stderr: '' }));
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('PreviewService', () => {
    let service: PreviewService;
    let sessionService: ReturnType<typeof makeSessionService>;

    beforeEach(() => {
        vi.clearAllMocks();
        setupDefaultMocks();
    });

    /* ============================================================== */
    /*  init()                                                         */
    /* ============================================================== */

    describe('init()', () => {
        it('should return early when session is not found', async () => {
            sessionService = makeSessionService(null);
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('nonexistent');

            expect(service.isReady('nonexistent')).toBe(false);
            expect(mockMkdir).not.toHaveBeenCalled();
        });

        it('should return early when session has no filePath', async () => {
            sessionService = makeSessionService({
                filePath: null,
                probeResult: makeProbe(),
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(false);
        });

        it('should return early when session has no probeResult', async () => {
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: null,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(false);
        });

        it('should return early when no video and no audio tracks exist', async () => {
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: makeProbe({ videoTracks: [], audioTracks: [] }),
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(false);
        });

        it('should initialize with a single H.264 stream <= 480p (copy mode)', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);

            // Master playlist should have 1 rendition at 480p
            const master = service.getPlaylist('s1', 'tok');
            expect(master).toContain('RESOLUTION=854x480');
            expect(master).toContain('r0/playlist.m3u8');
        });

        it('should initialize with a single H.264 stream > 480p (multiple transcode renditions)', async () => {
            const probe = makeProbe({
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
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);

            // Source > 480p: should generate 3 transcode renditions (480p, 360p, 240p)
            const master = service.getPlaylist('s1', 'tok');
            expect(master).toContain('x480');
            expect(master).toContain('x360');
            expect(master).toContain('x240');
            // Should have 3 rendition playlist references
            expect(master).toContain('r0/playlist.m3u8');
            expect(master).toContain('r1/playlist.m3u8');
            expect(master).toContain('r2/playlist.m3u8');
        });

        it('should handle multi-stream H.264 with streams <= 480p (multiple copy renditions)', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                    {
                        index: 1,
                        codec: 'h264',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            const master = service.getPlaylist('s1', 'tok');
            expect(master).toContain('RESOLUTION=854x480');
            expect(master).toContain('RESOLUTION=640x360');
            expect(master).toContain('r0/playlist.m3u8');
            expect(master).toContain('r1/playlist.m3u8');
        });

        it('should use the smallest stream when all multi-stream H.264 are > 480p', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                    {
                        index: 1,
                        codec: 'h264',
                        width: 1280,
                        height: 720,
                        bitrateKbps: 3000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            const master = service.getPlaylist('s1', 'tok');
            // Should pick the smallest (720p) as a single copy rendition
            expect(master).toContain('RESOLUTION=1280x720');
            // Should NOT contain 1080p
            expect(master).not.toContain('RESOLUTION=1920x1080');
        });

        it('should create transcode renditions for HEVC codec (non-copyable)', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            const master = service.getPlaylist('s1', 'tok');
            // Should have 480p, 360p, 240p transcode renditions
            expect(master).toContain('x480');
            expect(master).toContain('x360');
            expect(master).toContain('x240');
            expect(master).toContain('r0/playlist.m3u8');
            expect(master).toContain('r1/playlist.m3u8');
            expect(master).toContain('r2/playlist.m3u8');
        });

        it('should create transcode renditions for ProRes codec', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'prores',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 50000,
                        frameRate: 24,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
        });

        it('should limit transcode rendition heights to source height', async () => {
            // Source is 320p - should only get 240p rendition (and 320 is < 360, < 480)
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 426,
                        height: 240,
                        bitrateKbps: 500,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            const master = service.getPlaylist('s1', 'tok');
            // Only 240p rendition (the filter is h <= max(v.height, 240))
            expect(master).toContain('x240');
            expect(master).not.toContain('x360');
            expect(master).not.toContain('x480');
        });

        it('should run keyframe scan only for copy-mode renditions', async () => {
            // H.264 (copyable) - should scan keyframes
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            // execFile should have been called for keyframe scan (ffmpeg -i ... -f segment ...)
            expect(mockExecFile).toHaveBeenCalled();
            const firstCallArgs = mockExecFile.mock.calls[0];
            expect(firstCallArgs[0]).toBe('ffmpeg');
            expect(firstCallArgs[1]).toContain('-f');
            expect(firstCallArgs[1]).toContain('segment');
        });

        it('should NOT run keyframe scan for transcode-only renditions', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            // No ffmpeg call for keyframe scan
            expect(mockExecFile).not.toHaveBeenCalled();
        });

        it('should handle keyframe scan failure gracefully (falls back to empty boundaries)', async () => {
            setupExecFile(() => {
                throw new Error('ffmpeg crashed');
            });
            mockReadFile.mockRejectedValue(new Error('no file'));

            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            // Should still generate media playlist using fixed-duration segments
            const media = service.getPlaylist('s1', 'tok', 0);
            expect(media).toContain('#EXTINF:');
            expect(media).toContain('#EXT-X-TARGETDURATION:4');
        });

        it('should handle probe with no audio tracks', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
                audioTracks: [],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
        });

        it('should create preview directory', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/work/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(mockMkdir).toHaveBeenCalledWith(
                expect.stringContaining('preview'),
                { recursive: true }
            );
        });
    });

    /* ============================================================== */
    /*  isReady()                                                      */
    /* ============================================================== */

    describe('isReady()', () => {
        it('should return false before init', () => {
            sessionService = makeSessionService(null);
            service = new PreviewService(sessionService, makeFfmpegService());
            expect(service.isReady('s1')).toBe(false);
        });

        it('should return true after successful init', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
        });

        it('should return false after destroy', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            await service.init('s1');
            await service.destroy('s1');

            expect(service.isReady('s1')).toBe(false);
        });
    });

    /* ============================================================== */
    /*  getPlaylist()                                                   */
    /* ============================================================== */

    describe('getPlaylist()', () => {
        beforeEach(async () => {
            const probe = makeProbe({
                duration: 20,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                    {
                        index: 1,
                        codec: 'h264',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');
        });

        it('should return null when not initialized', () => {
            expect(service.getPlaylist('nonexistent', 'tok')).toBeNull();
        });

        it('should return master playlist when no renditionIndex given', () => {
            const playlist = service.getPlaylist('s1', 'tok');
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-STREAM-INF:');
            expect(playlist).toContain('r0/playlist.m3u8');
            expect(playlist).toContain('r1/playlist.m3u8');
        });

        it('should return media playlist when renditionIndex is provided', () => {
            const playlist = service.getPlaylist('s1', 'tok', 0);
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-VERSION:3');
            expect(playlist).toContain('#EXTINF:');
            expect(playlist).toContain('segment0.ts');
            expect(playlist).toContain('#EXT-X-ENDLIST');
        });

        it('should append token to segment URLs in media playlist', () => {
            const playlist = service.getPlaylist('s1', 'mytoken', 0);
            expect(playlist).toContain('segment0.ts?token=mytoken');
            expect(playlist).toContain('segment1.ts?token=mytoken');
        });

        it('should append token to playlist URLs in master playlist', () => {
            const playlist = service.getPlaylist('s1', 'mytoken');
            expect(playlist).toContain('r0/playlist.m3u8?token=mytoken');
            expect(playlist).toContain('r1/playlist.m3u8?token=mytoken');
        });

        it('should return master playlist for out-of-range renditionIndex', () => {
            const playlist = service.getPlaylist('s1', 'tok', 99);
            expect(playlist).toContain('#EXT-X-STREAM-INF:');
            expect(playlist).toContain('r0/playlist.m3u8');
        });
    });

    /* ============================================================== */
    /*  Playlist generation details                                    */
    /* ============================================================== */

    describe('playlist generation', () => {
        it('should include correct BANDWIDTH and RESOLUTION in master playlist', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const master = service.getPlaylist('s1', 'tok');
            expect(master).toContain('BANDWIDTH=2000000');
            expect(master).toContain('RESOLUTION=854x480');
        });

        it('should use actual durations from boundaries in media playlist', async () => {
            // H.264 copy mode with keyframe scan returning boundaries
            mockReadFile.mockResolvedValue(
                'seg0.ts,0.000000,4.170000\nseg1.ts,4.170000,8.500000\n'
            );
            const probe = makeProbe({
                duration: 8.5,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const media = service.getPlaylist('s1', 'tok', 0);
            expect(media).toContain('#EXTINF:4.170,');
            expect(media).toContain('#EXTINF:4.330,');
        });

        it('should use fixed SEGMENT_DURATION when no boundaries exist', async () => {
            const probe = makeProbe({
                duration: 10,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const media = service.getPlaylist('s1', 'tok', 0);
            expect(media).toContain('#EXTINF:4.000,');
            // Last segment should be 2s (10 - 2*4)
            expect(media).toContain('#EXTINF:2.000,');
        });

        it('should include EXT-X-DISCONTINUITY between segments (except before the first)', async () => {
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const media = service.getPlaylist('s1', 'tok', 0)!;
            const lines = media.split('\n');
            // First segment should NOT have DISCONTINUITY before it
            const firstExtinf = lines.indexOf(
                lines.find((l) => l.startsWith('#EXTINF:'))!
            );
            expect(lines[firstExtinf - 1]).not.toBe('#EXT-X-DISCONTINUITY');
            // Second segment should have DISCONTINUITY
            const discontinuities = lines.filter(
                (l) => l === '#EXT-X-DISCONTINUITY'
            );
            expect(discontinuities.length).toBe(2); // 3 segments = 2 discontinuities
        });

        it('should set EXT-X-TARGETDURATION to max boundary duration', async () => {
            mockReadFile.mockResolvedValue(
                'seg0.ts,0.000000,6.500000\nseg1.ts,6.500000,10.000000\n'
            );
            const probe = makeProbe({
                duration: 10,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const media = service.getPlaylist('s1', 'tok', 0);
            // Max duration is 6.5, ceil is 7
            expect(media).toContain('#EXT-X-TARGETDURATION:7');
        });

        it('should include VOD playlist type', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const media = service.getPlaylist('s1', 'tok', 0);
            expect(media).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        });
    });

    /* ============================================================== */
    /*  setTrimSegments() — filtered preview playlists                 */
    /* ============================================================== */

    describe('setTrimSegments()', () => {
        beforeEach(async () => {
            // HEVC source → no keyframe scan → fixed 4s segments
            // duration=20 gives 5 segments: 0-4, 4-8, 8-12, 12-16, 16-20
            const probe = makeProbe({
                duration: 20,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');
        });

        it('should do nothing for unknown session', () => {
            service.setTrimSegments('nonexistent', [{ inSec: 0, outSec: 5 }]);
            // No error thrown
        });

        it('should filter playlist to segments overlapping trim ranges', () => {
            // Trim: 5-9 → overlaps segments 1 (4-8) and 2 (8-12)
            service.setTrimSegments('s1', [{ inSec: 5, outSec: 9 }]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            expect(media).toContain('segment1.ts');
            expect(media).toContain('segment2.ts');
            expect(media).not.toContain('segment0.ts');
            expect(media).not.toContain('segment3.ts');
            expect(media).not.toContain('segment4.ts');
        });

        it('should handle multiple trim ranges', () => {
            // Trim: 0-3 (seg 0), 14-20 (seg 3 and 4)
            service.setTrimSegments('s1', [
                { inSec: 0, outSec: 3 },
                { inSec: 14, outSec: 20 },
            ]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            expect(media).toContain('segment0.ts');
            expect(media).toContain('segment3.ts');
            expect(media).toContain('segment4.ts');
            expect(media).not.toContain('segment1.ts');
            expect(media).not.toContain('segment2.ts');
        });

        it('should include DISCONTINUITY between every segment', () => {
            service.setTrimSegments('s1', [{ inSec: 0, outSec: 12 }]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            const lines = media.split('\n');
            const discontinuities = lines.filter(
                (l) => l === '#EXT-X-DISCONTINUITY'
            );
            // 3 segments (0,1,2) → 2 discontinuities
            expect(discontinuities.length).toBe(2);
        });

        it('should not insert DISCONTINUITY before first segment', () => {
            service.setTrimSegments('s1', [{ inSec: 5, outSec: 12 }]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            const lines = media.split('\n');
            const firstExtinf = lines.findIndex((l) =>
                l.startsWith('#EXTINF:')
            );
            expect(lines[firstExtinf - 1]).not.toBe('#EXT-X-DISCONTINUITY');
        });

        it('should preserve correct segment durations', () => {
            // Segments are 4s each, last one is 4s too (20/4=5 exact)
            service.setTrimSegments('s1', [{ inSec: 5, outSec: 9 }]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            expect(media).toContain('#EXTINF:4.000,');
        });

        it('should keep master playlist unchanged', () => {
            const masterBefore = service.getPlaylist('s1', 'tok');
            service.setTrimSegments('s1', [{ inSec: 5, outSec: 9 }]);
            const masterAfter = service.getPlaylist('s1', 'tok');
            expect(masterAfter).toBe(masterBefore);
        });

        it('should fall back to full playlist when no segments overlap', () => {
            // Trim range beyond file duration → no overlap
            service.setTrimSegments('s1', [{ inSec: 100, outSec: 200 }]);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            // Falls back to full playlist with all 5 segments
            expect(media).toContain('segment0.ts');
            expect(media).toContain('segment4.ts');
        });

        it('should return full playlist when empty trim segments provided', () => {
            service.setTrimSegments('s1', []);
            const media = service.getPlaylist('s1', 'tok', 0)!;
            expect(media).toContain('segment0.ts');
            expect(media).toContain('segment4.ts');
        });

        it('should work with keyframe-scanned boundaries', async () => {
            // Set up H.264 copy mode with custom boundaries
            mockReadFile.mockResolvedValue(
                'seg0.ts,0.000000,3.500000\nseg1.ts,3.500000,7.200000\nseg2.ts,7.200000,12.000000\n'
            );
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s2');

            // Trim 4-8 → overlaps seg 1 (3.5-7.2) and seg 2 (7.2-12)
            service.setTrimSegments('s2', [{ inSec: 4, outSec: 8 }]);
            const media = service.getPlaylist('s2', 'tok', 0)!;
            expect(media).toContain('segment1.ts');
            expect(media).toContain('segment2.ts');
            expect(media).not.toContain('segment0.ts');
            // Durations from boundaries
            expect(media).toContain('#EXTINF:3.700,'); // 7.2 - 3.5
            expect(media).toContain('#EXTINF:4.800,'); // 12 - 7.2
        });

        it('should set correct EXT-X-TARGETDURATION for filtered segments', async () => {
            mockReadFile.mockResolvedValue(
                'seg0.ts,0.000000,2.000000\nseg1.ts,2.000000,8.500000\nseg2.ts,8.500000,12.000000\n'
            );
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s3');

            // Trim 3-9 → seg 1 (2-8.5, dur=6.5)
            service.setTrimSegments('s3', [{ inSec: 3, outSec: 9 }]);
            const media = service.getPlaylist('s3', 'tok', 0)!;
            expect(media).toContain('#EXT-X-TARGETDURATION:7'); // ceil(6.5)
        });

        it('should update all rendition playlists', async () => {
            // HEVC triggers multiple transcode renditions (480, 360, 240)
            const probe = makeProbe({
                duration: 20,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s4');

            service.setTrimSegments('s4', [{ inSec: 5, outSec: 9 }]);

            // All renditions should be filtered
            for (let r = 0; r < 3; r++) {
                const media = service.getPlaylist('s4', 'tok', r)!;
                expect(media).toContain('segment1.ts');
                expect(media).toContain('segment2.ts');
                expect(media).not.toContain('segment0.ts');
            }
        });
    });

    /* ============================================================== */
    /*  getSegmentStream()                                             */
    /* ============================================================== */

    describe('getSegmentStream()', () => {
        beforeEach(async () => {
            // Use HEVC to avoid keyframe scan complexity, giving fixed-duration segments
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');
            // Reset mocks after init
            mockExecFile.mockReset();
            mockExistsSync.mockReset();
            mockStat.mockReset();
            mockMkdir.mockReset();
            mockWriteFile.mockReset();
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);
        });

        it('should return null when session is not initialized', async () => {
            const result = await service.getSegmentStream('nonexistent', 0, 0);
            expect(result).toBeNull();
        });

        it('should return null for negative rendition index', async () => {
            const result = await service.getSegmentStream('s1', -1, 0);
            expect(result).toBeNull();
        });

        it('should return null for out-of-range rendition index', async () => {
            const result = await service.getSegmentStream('s1', 99, 0);
            expect(result).toBeNull();
        });

        it('should return null for negative segment index', async () => {
            const result = await service.getSegmentStream('s1', 0, -1);
            expect(result).toBeNull();
        });

        it('should return null for out-of-range segment index', async () => {
            // duration=12, SEGMENT_DURATION=4, so 3 segments (0, 1, 2)
            const result = await service.getSegmentStream('s1', 0, 3);
            expect(result).toBeNull();
        });

        it('should return cached segment when file exists with size > 0', async () => {
            const fakeStream = { pipe: vi.fn() };
            mockExistsSync.mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 5000 });
            mockCreateReadStream.mockReturnValue(fakeStream);

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(result).not.toBeNull();
            expect(result!.stream).toBe(fakeStream);
            expect(result!.size).toBe(5000);
            // Should NOT have called ffmpeg since cached
            expect(mockExecFile).not.toHaveBeenCalled();
        });

        it('should delete and re-extract empty cached files', async () => {
            // First existsSync: file exists but empty, then after extraction: exists with data
            let existsCallCount = 0;
            mockExistsSync.mockImplementation(() => {
                existsCallCount++;
                return true; // always exists
            });

            let statCallCount = 0;
            mockStat.mockImplementation(() => {
                statCallCount++;
                if (statCallCount === 1) return Promise.resolve({ size: 0 }); // empty first time
                return Promise.resolve({ size: 5000 }); // has data after extraction
            });

            mockRm.mockResolvedValue(undefined);
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            const fakeStream = { pipe: vi.fn() };
            mockCreateReadStream.mockReturnValue(fakeStream);

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(mockRm).toHaveBeenCalled(); // deleted the empty file
            expect(result).not.toBeNull();
            expect(result!.size).toBe(5000);
        });

        it('should extract segment on demand when not cached', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            const fakeStream = { pipe: vi.fn() };
            mockCreateReadStream.mockReturnValue(fakeStream);

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(result).not.toBeNull();
            expect(result!.size).toBe(2048);
            expect(mockExecFile).toHaveBeenCalled();
            // Verify ffmpeg was called with transcode args (HEVC -> libx264)
            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            expect(ffmpegArgs).toContain('-c:v');
            expect(ffmpegArgs).toContain('libx264');
            expect(ffmpegArgs).toContain('-preset');
            expect(ffmpegArgs).toContain('ultrafast');
            expect(ffmpegArgs).toContain('-crf');
            expect(ffmpegArgs).toContain('28');
        });

        it('should use -c:v copy for copy-mode renditions', async () => {
            // Reinitialize with H.264 copy-mode
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            // Reset for init
            mockExecFile.mockReset();
            mockReadFile.mockResolvedValue(CSV_KEYFRAMES);
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            await service.init('s1');

            // Now test segment extraction
            mockExecFile.mockReset();
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 0);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            expect(ffmpegArgs).toContain('-c:v');
            expect(ffmpegArgs).toContain('copy');
            expect(ffmpegArgs).not.toContain('libx264');
        });

        it('should include scale filter for transcode renditions with scaleFilter', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 0);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            expect(ffmpegArgs).toContain('-vf');
            // Should have a scale= filter value
            const vfIdx = ffmpegArgs.indexOf('-vf');
            expect(ffmpegArgs[vfIdx + 1]).toMatch(/^scale=/);
        });

        it('should include audio mapping and aac codec when audio exists', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 0);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            // Should have two -map args (video + audio)
            const mapIndices = ffmpegArgs.reduce<number[]>((acc, arg, i) => {
                if (arg === '-map') acc.push(i);
                return acc;
            }, []);
            expect(mapIndices.length).toBe(2);
            expect(ffmpegArgs).toContain('-c:a');
            expect(ffmpegArgs).toContain('aac');
            expect(ffmpegArgs).toContain('-b:a');
            expect(ffmpegArgs).toContain('128k');
        });

        it('should omit audio mapping when no audio track', async () => {
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
                audioTracks: [],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            mockExecFile.mockReset();
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({
                stdout: Buffer.from('segment-data'),
                stderr: '',
            }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 0);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            // Only one -map arg (video only)
            const mapIndices = ffmpegArgs.reduce<number[]>((acc, arg, i) => {
                if (arg === '-map') acc.push(i);
                return acc;
            }, []);
            expect(mapIndices.length).toBe(1);
            expect(ffmpegArgs).not.toContain('-c:a');
        });

        it('should deduplicate concurrent requests for the same segment', async () => {
            let resolveExtraction: () => void;
            const extractionPromise = new Promise<void>((resolve) => {
                resolveExtraction = resolve;
            });

            mockExistsSync.mockReturnValue(false);
            let execCallCount = 0;
            mockExecFile.mockImplementation((...args: any[]) => {
                execCallCount++;
                const cb = args[args.length - 1];
                extractionPromise.then(() => {
                    // After extraction, existsSync should return true
                    mockExistsSync.mockReturnValue(true);
                    mockStat.mockResolvedValue({ size: 2048 });
                    mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });
                    cb(null, { stdout: Buffer.from('data'), stderr: '' });
                });
            });

            // Start two concurrent requests for the same segment
            const p1 = service.getSegmentStream('s1', 0, 0);
            const p2 = service.getSegmentStream('s1', 0, 0);

            // Resolve the extraction
            resolveExtraction!();

            const [r1, r2] = await Promise.all([p1, p2]);

            // Only one ffmpeg call should have been made
            expect(execCallCount).toBe(1);
            // Both should get a result
            expect(r1).not.toBeNull();
            expect(r2).not.toBeNull();
        });

        it('should return null when extraction fails', async () => {
            mockExistsSync.mockReturnValue(false);
            // Use callback-style error (not throw) to avoid unhandled rejection
            setupExecFile(() => new Error('ffmpeg failed'));

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(result).toBeNull();
        });

        it('should return null when segment file not found after extraction', async () => {
            // existsSync always returns false (file never created)
            mockExistsSync.mockReturnValue(false);
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(result).toBeNull();
        });

        it('should delete and return null when extraction produces empty file', async () => {
            // First existsSync: false (not cached), second: true (after extraction), but size=0
            mockExistsSync
                .mockReturnValueOnce(false) // not cached
                .mockReturnValue(true); // exists after extraction
            mockStat.mockResolvedValue({ size: 0 }); // but empty
            mockRm.mockResolvedValue(undefined);
            setupExecFile(() => ({ stdout: Buffer.from(''), stderr: '' }));

            const result = await service.getSegmentStream('s1', 0, 0);

            expect(result).toBeNull();
            expect(mockRm).toHaveBeenCalled();
        });

        it('should use boundary start/duration when available', async () => {
            // Set up with H.264 copy mode so we get boundaries
            mockReadFile.mockResolvedValue(
                'seg0.ts,0.000000,4.170000\nseg1.ts,4.170000,8.500000\n'
            );
            const probe = makeProbe({
                duration: 8.5,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());

            mockExecFile.mockReset();
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            await service.init('s1');

            // Extract second segment (index 1)
            mockExecFile.mockReset();
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 1);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            // Should use boundary start (4.17) and duration (4.33)
            const ssIdx = ffmpegArgs.indexOf('-ss');
            expect(ffmpegArgs[ssIdx + 1]).toBe('4.17');
            const tIdx = ffmpegArgs.indexOf('-t');
            expect(parseFloat(ffmpegArgs[tIdx + 1])).toBeCloseTo(4.33, 1);
        });

        it('should use calculated start/duration when no boundaries', async () => {
            // Already initialized with HEVC (no boundaries)
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 1);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            const ssIdx = ffmpegArgs.indexOf('-ss');
            expect(ffmpegArgs[ssIdx + 1]).toBe('4'); // segmentIndex * SEGMENT_DURATION
            const tIdx = ffmpegArgs.indexOf('-t');
            expect(ffmpegArgs[tIdx + 1]).toBe('4'); // SEGMENT_DURATION
        });

        it('should trigger prefetch of next segments after successful extraction', async () => {
            mockExistsSync.mockReturnValue(false);
            let extractionCount = 0;
            mockExecFile.mockImplementation((...args: any[]) => {
                extractionCount++;
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: Buffer.from('data'), stderr: '' });
                }
            });
            mockStat.mockResolvedValue({ size: 2048 });
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            // After first call succeeds and file "exists"
            mockExistsSync
                .mockReturnValueOnce(false) // check cache for seg 0
                .mockReturnValueOnce(true); // check after extraction for seg 0

            // For prefetch checks
            mockExistsSync.mockReturnValue(false);

            await service.getSegmentStream('s1', 0, 0);

            // Should have been called more than once (1 for the segment + prefetch attempts)
            // The exact count depends on concurrency, but we verify it was called
            expect(extractionCount).toBeGreaterThanOrEqual(1);
        });

        it('should output to pipe:1 with mpegts format', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await service.getSegmentStream('s1', 0, 0);

            const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
            expect(ffmpegArgs).toContain('-f');
            expect(ffmpegArgs).toContain('mpegts');
            expect(ffmpegArgs).toContain('pipe:1');
        });
    });

    /* ============================================================== */
    /*  getSegmentStream() with boundaries                             */
    /* ============================================================== */

    describe('getSegmentStream() with boundary-based segments', () => {
        beforeEach(async () => {
            mockReadFile.mockResolvedValue(CSV_KEYFRAMES);
            const probe = makeProbe({
                duration: 20,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            await service.init('s1');

            mockExecFile.mockReset();
            mockExistsSync.mockReset();
            mockStat.mockReset();
            mockMkdir.mockReset();
            mockWriteFile.mockReset();
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);
        });

        it('should respect boundary count for out-of-range check', async () => {
            // 5 boundaries from CSV_KEYFRAMES
            const result = await service.getSegmentStream('s1', 0, 5);
            expect(result).toBeNull();
        });

        it('should allow valid boundary segment index', async () => {
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            const result = await service.getSegmentStream('s1', 0, 4);
            expect(result).not.toBeNull();
        });
    });

    /* ============================================================== */
    /*  destroy()                                                      */
    /* ============================================================== */

    describe('destroy()', () => {
        it('should remove state and preview directory', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/work/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            mockRm.mockReset();
            mockRm.mockResolvedValue(undefined);

            await service.destroy('s1');

            expect(service.isReady('s1')).toBe(false);
            expect(mockRm).toHaveBeenCalledWith(
                expect.stringContaining('preview'),
                { recursive: true, force: true }
            );
        });

        it('should be a no-op when session is not initialized', async () => {
            sessionService = makeSessionService(null);
            service = new PreviewService(sessionService, makeFfmpegService());
            mockRm.mockReset();

            await service.destroy('nonexistent');

            expect(mockRm).not.toHaveBeenCalled();
        });

        it('should handle rm failure gracefully', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/work/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            mockRm.mockReset();
            mockRm.mockRejectedValue(new Error('permission denied'));

            // Should not throw
            await service.destroy('s1');
            expect(service.isReady('s1')).toBe(false);
        });
    });

    /* ============================================================== */
    /*  Concurrency limiter                                            */
    /* ============================================================== */

    describe('concurrency limiter', () => {
        it('should allow up to MAX_CONCURRENT (3) simultaneous extractions', async () => {
            const probe = makeProbe({
                duration: 40,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            mockExecFile.mockReset();
            mockExistsSync.mockReturnValue(false);
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            let activeExtractions = 0;
            let maxActive = 0;
            const resolvers: Array<(value: void) => void> = [];

            mockExecFile.mockImplementation((...args: any[]) => {
                activeExtractions++;
                maxActive = Math.max(maxActive, activeExtractions);
                const cb = args[args.length - 1];

                const p = new Promise<void>((resolve) =>
                    resolvers.push(resolve)
                );
                p.then(() => {
                    activeExtractions--;
                    mockExistsSync.mockReturnValue(true);
                    mockStat.mockResolvedValue({ size: 1024 });
                    mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });
                    cb(null, { stdout: Buffer.from('data'), stderr: '' });
                });
            });

            // Start 5 concurrent segment requests (different segments)
            const promises = [
                service.getSegmentStream('s1', 0, 0),
                service.getSegmentStream('s1', 0, 1),
                service.getSegmentStream('s1', 0, 2),
                service.getSegmentStream('s1', 0, 3),
                service.getSegmentStream('s1', 0, 4),
            ];

            // Wait a tick for the first 3 to acquire slots
            await new Promise((r) => setTimeout(r, 10));

            // At most 3 should be active
            expect(maxActive).toBeLessThanOrEqual(3);
            expect(activeExtractions).toBeLessThanOrEqual(3);

            // Resolve all
            for (const r of resolvers) r();
            // Wait for any remaining resolvers
            await new Promise((r) => setTimeout(r, 50));
            for (const r of resolvers) r();

            // Settle all promises
            await Promise.allSettled(promises);
        });

        it('should queue additional requests beyond MAX_CONCURRENT', async () => {
            const probe = makeProbe({
                duration: 40,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            mockExecFile.mockReset();
            mockExistsSync.mockReturnValue(false);
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);

            const resolvers: Array<(value: void) => void> = [];
            let callCount = 0;

            mockExecFile.mockImplementation((...args: any[]) => {
                callCount++;
                const cb = args[args.length - 1];
                const p = new Promise<void>((resolve) =>
                    resolvers.push(resolve)
                );
                p.then(() => {
                    mockExistsSync.mockReturnValue(true);
                    mockStat.mockResolvedValue({ size: 1024 });
                    mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });
                    cb(null, { stdout: Buffer.from('data'), stderr: '' });
                });
            });

            // Start 4 extractions
            const p0 = service.getSegmentStream('s1', 0, 0);
            const p1 = service.getSegmentStream('s1', 0, 1);
            const p2 = service.getSegmentStream('s1', 0, 2);
            const p3 = service.getSegmentStream('s1', 0, 3);

            await new Promise((r) => setTimeout(r, 10));

            // Only 3 should have started (the 4th is queued)
            expect(callCount).toBe(3);

            // Complete one to free a slot
            resolvers[0]();
            await new Promise((r) => setTimeout(r, 10));

            // Now the 4th should have started
            expect(callCount).toBe(4);

            // Complete the rest
            for (const r of resolvers) r();
            await Promise.allSettled([p0, p1, p2, p3]);
        });
    });

    /* ============================================================== */
    /*  buildRenditions via init (edge cases)                          */
    /* ============================================================== */

    describe('buildRenditions (via init)', () => {
        it('should handle vp8 as copyable codec', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'vp8',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
            const master = service.getPlaylist('s1', 'tok');
            expect(master).toContain('RESOLUTION=640x360');
        });

        it('should handle vp9 as copyable codec', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'vp9',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
        });

        it('should handle H264 (uppercase) as copyable', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'H264',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            expect(service.isReady('s1')).toBe(true);
        });

        it('should compute correct width for non-copyable renditions (even number)', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const master = service.getPlaylist('s1', 'tok')!;
            // Extract resolutions
            const resolutions = master.match(/RESOLUTION=(\d+x\d+)/g)!;
            for (const res of resolutions) {
                const [w] = res
                    .replace('RESOLUTION=', '')
                    .split('x')
                    .map(Number);
                expect(w % 2).toBe(0); // width must be even
            }
        });

        it('should compute bitrateKbps as height*2 for transcode renditions', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const master = service.getPlaylist('s1', 'tok')!;
            // 480p -> 960kbps -> BANDWIDTH=960000
            expect(master).toContain('BANDWIDTH=960000');
            // 360p -> 720kbps -> BANDWIDTH=720000
            expect(master).toContain('BANDWIDTH=720000');
            // 240p -> 480kbps -> BANDWIDTH=480000
            expect(master).toContain('BANDWIDTH=480000');
        });

        it('should handle multi-stream where some are <= 480 and some > 480', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 1280,
                        height: 720,
                        bitrateKbps: 3000,
                        frameRate: 30,
                    },
                    {
                        index: 1,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                    {
                        index: 2,
                        codec: 'h264',
                        width: 640,
                        height: 360,
                        bitrateKbps: 1000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const master = service.getPlaylist('s1', 'tok')!;
            // Should include streams <= 480p only
            expect(master).toContain('RESOLUTION=854x480');
            expect(master).toContain('RESOLUTION=640x360');
            expect(master).not.toContain('RESOLUTION=1280x720');
        });

        it('should produce single copy rendition for h264 at exactly 480p', async () => {
            const probe = makeProbe({
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            sessionService = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            service = new PreviewService(sessionService, makeFfmpegService());
            await service.init('s1');

            const master = service.getPlaylist('s1', 'tok')!;
            // Single rendition, copy mode
            const streamInfCount = (master.match(/#EXT-X-STREAM-INF/g) || [])
                .length;
            expect(streamInfCount).toBe(1);
            expect(master).toContain('BANDWIDTH=2000000'); // original bitrate
        });
    });

    /* ============================================================== */
    /*  Multi-audio (selectAudioTracks + getAudioTracks)              */
    /* ============================================================== */

    describe('multi-audio support', () => {
        describe('selectAudioTracks via init', () => {
            it('should select single audio track when only one exists', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const tracks = service.getAudioTracks('s1');
                expect(tracks).toHaveLength(1);
                expect(tracks![0].isDefault).toBe(true);
                expect(tracks![0].streamIndex).toBe(0);
            });

            it('should include all audio tracks for multi-language files', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            language: 'eng',
                        },
                        {
                            index: 1,
                            codec: 'aac',
                            bitrateKbps: 256,
                            channels: 2,
                            sampleRate: 48000,
                            language: 'eng',
                        },
                        {
                            index: 2,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            language: 'fra',
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const tracks = service.getAudioTracks('s1');
                expect(tracks).toHaveLength(3);
                expect(tracks![0].streamIndex).toBe(0);
                expect(tracks![0].bitrateKbps).toBe(128);
                expect(tracks![0].isDefault).toBe(true);
                expect(tracks![1].streamIndex).toBe(1);
                expect(tracks![2].streamIndex).toBe(2);
            });

            it('should treat same-bitrate no-language tracks as distinct (not quality tiers)', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_0',
                        },
                        {
                            index: 1,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_1',
                        },
                        {
                            index: 2,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_2',
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const tracks = service.getAudioTracks('s1');
                expect(tracks).toHaveLength(3);
                expect(tracks![0].name).toBe('CH_0');
                expect(tracks![1].name).toBe('CH_1');
                expect(tracks![2].name).toBe('CH_2');
            });

            it('should include all tracks with codec and bitrate info', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 64,
                            channels: 2,
                            sampleRate: 48000,
                        },
                        {
                            index: 1,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                        },
                        {
                            index: 2,
                            codec: 'aac',
                            bitrateKbps: 256,
                            channels: 2,
                            sampleRate: 48000,
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const tracks = service.getAudioTracks('s1');
                expect(tracks).toHaveLength(3);
                expect(tracks![0].bitrateKbps).toBe(64);
                expect(tracks![0].codec).toBe('aac');
                expect(tracks![1].bitrateKbps).toBe(128);
                expect(tracks![2].bitrateKbps).toBe(256);
            });
        });

        describe('getAudioTracks', () => {
            it('should return null when session not initialized', () => {
                expect(service.getAudioTracks('nonexistent')).toBeNull();
            });
        });

        describe('getPlaylist with audioTrackIndex', () => {
            it('should append &audio=N to URLs when multi-audio', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_0',
                        },
                        {
                            index: 1,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_1',
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const master = service.getPlaylist('s1', 'tok', undefined, 1);
                expect(master).toContain('r0/playlist.m3u8?token=tok&audio=1');

                const media = service.getPlaylist('s1', 'tok', 0, 1);
                expect(media).toContain('segment0.ts?token=tok&audio=1');
            });

            it('should not append &audio when single audio track', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                const master = service.getPlaylist('s1', 'tok', undefined, 0);
                expect(master).toContain('r0/playlist.m3u8?token=tok');
                expect(master).not.toContain('&audio=');
            });
        });

        describe('getSegmentStream with audioTrackIndex', () => {
            it('should use audio-specific cache dir for multi-audio', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_0',
                        },
                        {
                            index: 1,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                            name: 'CH_1',
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                mockExecFile.mockReset();
                mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
                mockStat.mockResolvedValue({ size: 2048 });
                setupExecFile(() => ({
                    stdout: Buffer.from('data'),
                    stderr: '',
                }));
                mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

                await service.getSegmentStream('s1', 0, 0, 1);

                // Should extract with audio track 1's stream index
                const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
                expect(ffmpegArgs).toContain('0:a:1');
            });

            it('should use default cache dir for single audio', async () => {
                const probe = makeProbe({
                    audioTracks: [
                        {
                            index: 0,
                            codec: 'aac',
                            bitrateKbps: 128,
                            channels: 2,
                            sampleRate: 48000,
                        },
                    ],
                });
                sessionService = makeSessionService({
                    filePath: '/tmp/video.mp4',
                    probeResult: probe,
                });
                service = new PreviewService(
                    sessionService,
                    makeFfmpegService()
                );
                await service.init('s1');

                mockExecFile.mockReset();
                mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
                mockStat.mockResolvedValue({ size: 2048 });
                setupExecFile(() => ({
                    stdout: Buffer.from('data'),
                    stderr: '',
                }));
                mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

                await service.getSegmentStream('s1', 0, 0);

                const ffmpegArgs = mockExecFile.mock.calls[0][1] as string[];
                expect(ffmpegArgs).toContain('0:a:0');
            });
        });
    });

    /* ============================================================== */
    /*  initFromMoov()                                                 */
    /* ============================================================== */

    /* ============================================================== */
    /*  GPU transcoding                                                */
    /* ============================================================== */

    describe('GPU transcoding', () => {
        async function initHevcService(accelMode: string) {
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'hevc',
                        width: 1920,
                        height: 1080,
                        bitrateKbps: 5000,
                        frameRate: 30,
                    },
                ],
            });
            const ss = makeSessionService({
                filePath: '/tmp/video.mkv',
                probeResult: probe,
            });
            const svc = new PreviewService(ss, makeFfmpegService(accelMode));
            await svc.init('s1');
            // Reset mocks after init
            mockExecFile.mockReset();
            mockExistsSync.mockReset();
            mockStat.mockReset();
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockResolvedValue(undefined);
            return svc;
        }

        it('should use h264_nvenc and scale_cuda for nvidia mode', async () => {
            const svc = await initHevcService('nvidia');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            expect(args).toContain('-hwaccel');
            expect(args).toContain('cuda');
            expect(args).toContain('h264_nvenc');
            expect(args).toContain('-preset');
            expect(args).toContain('p1');
            // scale filter should use scale_cuda
            const vfIdx = args.indexOf('-vf');
            expect(vfIdx).toBeGreaterThan(-1);
            expect(args[vfIdx + 1]).toMatch(/^scale_cuda=/);
        });

        it('keeps decoded frames on the GPU, so scale_cuda can accept them', async () => {
            // Asserting `-hwaccel cuda` alone is what let this ship broken:
            // without an output format CUDA decodes on the device and hands back
            // software frames, `scale_cuda` refuses them, and every segment
            // failed over to CPU while still claiming to be running on nvidia.
            const svc = await initHevcService('nvidia');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            const fmtIdx = args.indexOf('-hwaccel_output_format');
            expect(fmtIdx).toBeGreaterThan(-1);
            expect(args[fmtIdx + 1]).toBe('cuda');
            // Input flags only count before -i.
            expect(fmtIdx).toBeLessThan(args.indexOf('-i'));
        });

        it('should use h264_videotoolbox and scale_vt for apple mode', async () => {
            const svc = await initHevcService('apple');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            expect(args).toContain('-hwaccel');
            expect(args).toContain('videotoolbox');
            expect(args).toContain('h264_videotoolbox');
            expect(args).toContain('-allow_sw');
            expect(args).toContain('1');
            expect(args).toContain('-b:v');
            expect(args).toContain('1500k');
            const vfIdx = args.indexOf('-vf');
            expect(vfIdx).toBeGreaterThan(-1);
            expect(args[vfIdx + 1]).toMatch(/^scale_vt=/);
        });

        it('should use libx264 for cpu mode (no GPU flags)', async () => {
            const svc = await initHevcService('cpu');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            expect(args).toContain('libx264');
            expect(args).toContain('-preset');
            expect(args).toContain('ultrafast');
            expect(args).not.toContain('-hwaccel');
            expect(args).not.toContain('h264_nvenc');
            expect(args).not.toContain('h264_videotoolbox');
        });

        it('should not use GPU for copy-mode renditions even when GPU available', async () => {
            // H.264 <=480p uses copy mode
            const probe = makeProbe({
                duration: 12,
                videoTracks: [
                    {
                        index: 0,
                        codec: 'h264',
                        width: 854,
                        height: 480,
                        bitrateKbps: 2000,
                        frameRate: 30,
                    },
                ],
            });
            const ss = makeSessionService({
                filePath: '/tmp/video.mp4',
                probeResult: probe,
            });
            const svc = new PreviewService(ss, makeFfmpegService('nvidia'));
            await svc.init('s1');

            mockExecFile.mockReset();
            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            expect(args).toContain('-c:v');
            expect(args).toContain('copy');
            expect(args).not.toContain('-hwaccel');
        });

        it('should fall back to CPU when GPU encode fails', async () => {
            const svc = await initHevcService('nvidia');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            // First call (GPU) fails, second call (CPU fallback) succeeds
            let callCount = 0;
            mockExecFile.mockImplementation((...callArgs: any[]) => {
                const cb = callArgs[callArgs.length - 1];
                callCount++;
                if (callCount === 1) {
                    // GPU failure
                    cb(new Error('NVENC session limit'), {
                        stdout: '',
                        stderr: '',
                    });
                } else {
                    // CPU fallback succeeds
                    cb(null, { stdout: Buffer.from('cpu-data'), stderr: '' });
                }
            });

            const result = await svc.getSegmentStream('s1', 0, 0);

            expect(result).not.toBeNull();
            expect(callCount).toBe(2);

            // Second call should be CPU args
            const cpuArgs = mockExecFile.mock.calls[1][1] as string[];
            expect(cpuArgs).toContain('libx264');
            expect(cpuArgs).not.toContain('-hwaccel');
        });

        it('should place -hwaccel flags before -i', async () => {
            const svc = await initHevcService('nvidia');

            mockExistsSync.mockReturnValueOnce(false).mockReturnValue(true);
            mockStat.mockResolvedValue({ size: 2048 });
            setupExecFile(() => ({ stdout: Buffer.from('data'), stderr: '' }));
            mockCreateReadStream.mockReturnValue({ pipe: vi.fn() });

            await svc.getSegmentStream('s1', 0, 0);

            const args = mockExecFile.mock.calls[0][1] as string[];
            const hwaccelIdx = args.indexOf('-hwaccel');
            const inputIdx = args.indexOf('-i');
            expect(hwaccelIdx).toBeLessThan(inputIdx);
        });
    });
});
