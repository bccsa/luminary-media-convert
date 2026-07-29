import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockExecFile } = vi.hoisted(() => ({
    mockExecFile: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        execFile: mockExecFile,
    };
});

import { ThumbnailService, formatVttTime } from './thumbnail.service.js';

describe('formatVttTime', () => {
    it('should format zero', () => {
        expect(formatVttTime(0)).toBe('00:00:00.000');
    });

    it('should format fractional seconds', () => {
        expect(formatVttTime(1.5)).toBe('00:00:01.500');
    });

    it('should format minutes and seconds', () => {
        expect(formatVttTime(65)).toBe('00:01:05.000');
    });

    it('should format hours', () => {
        expect(formatVttTime(3661.25)).toBe('01:01:01.250');
    });

    it('should handle large values', () => {
        expect(formatVttTime(36000)).toBe('10:00:00.000');
    });
});

describe('ThumbnailService', () => {
    let service: ThumbnailService;

    /**
     * The sprite-generation invocation, found by what it writes rather than by
     * position: capability probes run before it, and counting them made every
     * assertion here break the moment one was added.
     */
    function spriteCall(): string[] {
        const call = mockExecFile.mock.calls.find((c: any[]) =>
            (c[1] as string[])?.some(
                (a) => typeof a === 'string' && a.includes('sprite_%03d')
            )
        );
        if (!call) throw new Error('ffmpeg was never asked to write sprites');
        return call[1] as string[];
    }

    beforeEach(() => {
        service = new ThumbnailService();
        mockExecFile.mockReset();
        // Default mock: detectSpriteFormat resolves with libwebp
        mockExecFile.mockImplementation((...args: any[]) => {
            const cb = args[args.length - 1];
            cb(null, {
                stdout: ' V..... libwebp          libwebp WebP',
                stderr: '',
            });
        });
    });

    describe('buildVtt', () => {
        it('should generate correct VTT for a short video', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(15, spriteFiles, 160, 90);

            expect(vtt).toContain('WEBVTT');
            expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
            expect(vtt).toContain('sprite_001.webp#xywh=0,0,160,90');
            expect(vtt).toContain('00:00:05.000 --> 00:00:10.000');
            expect(vtt).toContain('sprite_001.webp#xywh=160,0,160,90');
            expect(vtt).toContain('00:00:10.000 --> 00:00:15.000');
            expect(vtt).toContain('sprite_001.webp#xywh=320,0,160,90');
        });

        it('should wrap to next row after COLUMNS thumbnails', () => {
            const spriteFiles = ['sprite_001.webp'];
            // 30s = 6 thumbnails at 5s interval
            const vtt = service.buildVtt(30, spriteFiles, 160, 90);

            // 6th thumbnail (index 5) should be at row 1
            expect(vtt).toContain('00:00:25.000 --> 00:00:30.000');
            expect(vtt).toContain('sprite_001.webp#xywh=0,90,160,90');
        });

        it('should use second sprite sheet after 25 thumbnails', () => {
            const spriteFiles = ['sprite_001.webp', 'sprite_002.webp'];
            // 130s = 26 thumbnails, so #26 goes to sprite_002
            const vtt = service.buildVtt(130, spriteFiles, 160, 90);

            expect(vtt).toContain('00:02:05.000 --> 00:02:10.000');
            expect(vtt).toContain('sprite_002.webp#xywh=0,0,160,90');
        });

        it('should clamp last cue end time to duration', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(7, spriteFiles, 160, 90);

            expect(vtt).toContain('00:00:05.000 --> 00:00:07.000');
        });

        it('should handle exact multiples of interval', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(10, spriteFiles, 160, 90);

            const lines = vtt.split('\n');
            const timeLines = lines.filter((l) => l.includes(' --> '));
            expect(timeLines).toHaveLength(2);
        });

        it('should calculate correct sprite sheet count for long videos', () => {
            // 600s = 120 thumbnails = 5 sprite sheets (25 per sheet)
            const spriteFiles = [
                'sprite_001.webp',
                'sprite_002.webp',
                'sprite_003.webp',
                'sprite_004.webp',
                'sprite_005.webp',
            ];
            const vtt = service.buildVtt(600, spriteFiles, 160, 90);

            // Last thumbnail should reference sprite_005
            expect(vtt).toContain('sprite_005.webp');
        });

        it('should stop when sprite files run out', () => {
            // 130s = 26 thumbnails but only 1 sprite (25 thumbs)
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(130, spriteFiles, 160, 90);

            const timeLines = vtt
                .split('\n')
                .filter((l) => l.includes(' --> '));
            expect(timeLines).toHaveLength(25);
        });
    });

    describe('decode acceleration and timeout', () => {
        /** Drive a generation run, controlling what `ffmpeg -hwaccels` reports. */
        async function run(opts: {
            hwaccels: string;
            duration?: number;
            failAccelerated?: boolean;
        }) {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-accel-'));
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                const ffargs = args[1] as string[];
                if (ffargs[0] === '-encoders') {
                    cb(null, {
                        stdout: ' V..... libwebp libwebp WebP',
                        stderr: '',
                    });
                    return;
                }
                if (ffargs[0] === '-hwaccels') {
                    cb(null, { stdout: opts.hwaccels, stderr: '' });
                    return;
                }
                if (opts.failAccelerated && ffargs.includes('-hwaccel')) {
                    cb(new Error('Function not implemented'), null);
                    return;
                }
                writeFileSync(
                    join(tmpDir, 'thumbnails', 'sprite_001.webp'),
                    'fake-sprite'
                );
                cb(null, { stdout: '', stderr: '' });
            });

            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mkv',
                outputDir: tmpDir,
                duration: opts.duration ?? 60,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            rmSync(tmpDir, { recursive: true, force: true });
            return result;
        }

        it('decodes on the GPU when CUDA is available', async () => {
            await run({
                hwaccels: 'Hardware acceleration methods:\ncuda\nvaapi\n',
            });

            const args = spriteCall();
            expect(args.slice(0, 2)).toEqual(['-hwaccel', 'cuda']);
        });

        it('never asks CUDA to keep the frames on the device', async () => {
            // scale and tile are software filters, so the frames have to come
            // back to system memory. Requesting a CUDA output format here would
            // break the filter graph — the mirror image of the preview encoder,
            // where omitting it is what breaks scale_cuda.
            await run({ hwaccels: 'cuda\n' });

            expect(spriteCall()).not.toContain('-hwaccel_output_format');
        });

        it('decodes in software when no acceleration is offered', async () => {
            await run({ hwaccels: 'Hardware acceleration methods:\n' });

            expect(spriteCall()).not.toContain('-hwaccel');
        });

        it('retries in software when the GPU cannot decode the source', async () => {
            // A GPU that does not handle this codec should cost the storyboard
            // nothing — it should fall back, not give up.
            const result = await run({
                hwaccels: 'cuda\n',
                failAccelerated: true,
            });

            expect(result).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
            const attempts = mockExecFile.mock.calls.filter((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) => typeof a === 'string' && a.includes('sprite_%03d')
                )
            );
            expect(attempts).toHaveLength(2);
            expect(attempts[0][1]).toContain('-hwaccel');
            expect(attempts[1][1]).not.toContain('-hwaccel');
        });

        it('gives a long source proportionally longer to finish', async () => {
            // The pass walks the whole file, so a fixed cap cut an hour-long
            // video off after a third of it and left the timeline half-drawn.
            await run({ hwaccels: '', duration: 3600 });

            const call = mockExecFile.mock.calls.find((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) => typeof a === 'string' && a.includes('sprite_%03d')
                )
            );
            expect(call[2].timeout).toBe(900_000);
        });

        it('gives execFile an integer, whatever the duration', async () => {
            // Durations are fractional. This exact source scaled to 899340.25ms,
            // which execFile rejects outright — killing the accelerated attempt
            // and its software retry before ffmpeg ran at all.
            await run({ hwaccels: 'cuda\n', duration: 3597.361 });

            const call = mockExecFile.mock.calls.find((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) => typeof a === 'string' && a.includes('sprite_%03d')
                )
            );
            expect(Number.isInteger(call[2].timeout)).toBe(true);
            expect(call[2].timeout).toBe(899_340);
        });

        it('keeps the old five minutes as the floor for short clips', async () => {
            await run({ hwaccels: '', duration: 30 });

            const call = mockExecFile.mock.calls.find((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) => typeof a === 'string' && a.includes('sprite_%03d')
                )
            );
            expect(call[2].timeout).toBe(300_000);
        });

        it('caps the budget so a pathological source cannot hang forever', async () => {
            await run({ hwaccels: '', duration: 36_000 });

            const call = mockExecFile.mock.calls.find((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) => typeof a === 'string' && a.includes('sprite_%03d')
                )
            );
            expect(call[2].timeout).toBe(1_800_000);
        });
    });

    describe('detectSpriteFormat (via generateThumbnails)', () => {
        it('should select libwebp when ffmpeg supports it', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                // First call: detectSpriteFormat runs ffmpeg -encoders
                // Second call: ffmpeg thumbnail generation
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        // detectSpriteFormat: ffmpeg -encoders
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP image',
                            stderr: '',
                        });
                    } else {
                        // ffmpeg sprite generation — create a sprite file to simulate output
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                const result = await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                expect(result).toEqual({
                    vttRelativePath: 'thumbnails/thumbnails.vtt',
                });

                // Verify the first call was ffmpeg -encoders
                expect(mockExecFile.mock.calls[0][0]).toBe('ffmpeg');
                expect(mockExecFile.mock.calls[0][1]).toEqual(['-encoders']);

                // Verify the second call used libwebp encoder
                const spriteArgs = spriteCall();
                expect(spriteArgs).toContain('libwebp');

                // Verify sprite pattern uses .webp extension
                const patternArg = spriteArgs[spriteArgs.length - 1];
                expect(patternArg).toMatch(/sprite_%03d\.webp$/);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should fall back to mjpeg when libwebp is unavailable', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... mjpeg            MJPEG encoder',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.jpg'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                const result = await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                expect(result).toEqual({
                    vttRelativePath: 'thumbnails/thumbnails.vtt',
                });

                // Verify mjpeg encoder was used
                const spriteArgs = spriteCall();
                expect(spriteArgs).toContain('mjpeg');

                // Verify sprite pattern uses .jpg extension
                const patternArg = spriteArgs[spriteArgs.length - 1];
                expect(patternArg).toMatch(/sprite_%03d\.jpg$/);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should return null when no suitable encoder is available', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                cb(null, {
                    stdout: ' V..... libx264          H.264 encoder',
                    stderr: '',
                });
            });

            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 10,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });

            expect(result).toBeNull();
            // Only the encoder detection call should have been made
            expect(mockExecFile).toHaveBeenCalledTimes(1);
        });

        it('should return null when ffmpeg is not found (execFile throws)', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                cb(new Error('spawn ffmpeg ENOENT'), null, null);
            });

            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 10,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });

            expect(result).toBeNull();
        });

        it('should cache the detected format and not re-run ffmpeg -encoders', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        // First call: detectSpriteFormat
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        // All subsequent calls: sprite generation — create sprite files
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                // First call triggers detection + generation
                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                // encoder probe + hwaccel probe + generate
                expect(mockExecFile).toHaveBeenCalledTimes(3);

                // Reset call count tracking but keep the mock
                const prevCallCount = mockExecFile.mock.calls.length;

                // Second call on same service instance should skip detection
                // Need a fresh tmpDir for the second call since thumbnails dir already exists
                const tmpDir2 = mkdtempSync(join(tmpdir(), 'thumb-test2-'));
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    const thumbnailDir = join(tmpDir2, 'thumbnails');
                    writeFileSync(
                        join(thumbnailDir, 'sprite_001.webp'),
                        'fake-sprite'
                    );
                    cb(null, { stdout: '', stderr: '' });
                });

                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir2,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                // Should only have 1 additional call (generation only, no detection)
                expect(mockExecFile).toHaveBeenCalledTimes(prevCallCount + 1);

                // That call should NOT be ffmpeg -encoders
                const lastCall =
                    mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1];
                expect(lastCall[1]).not.toEqual(['-encoders']);

                rmSync(tmpDir2, { recursive: true, force: true });
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should cache null result and not retry detection', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                cb(new Error('spawn ffmpeg ENOENT'), null, null);
            });

            // First call — detection fails
            await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 10,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });

            expect(mockExecFile).toHaveBeenCalledTimes(1);

            // Second call — should use cached null, not call ffmpeg again
            await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 10,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });

            expect(mockExecFile).toHaveBeenCalledTimes(1);
        });
    });

    describe('generateThumbnails', () => {
        it('should return null when duration is 0', async () => {
            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            expect(result).toBeNull();
        });

        it('should return null when duration is negative', async () => {
            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: -1,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            expect(result).toBeNull();
        });

        it('should return null when ffmpeg sprite generation fails', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        cb(new Error('ffmpeg exited with code 1'), null, null);
                    }
                });

                const result = await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                expect(result).toBeNull();
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should return null when no sprite files are generated', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        // ffmpeg succeeds but produces no sprite files
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                const result = await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                expect(result).toBeNull();
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should calculate even thumbnail height from source dimensions', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                // 1920x1080 -> width=160, height = ceil((160/1920)*1080 / 2)*2 = ceil(45)*2 = 90
                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                const spriteArgs = spriteCall() as string[];
                const vfArg = spriteArgs[spriteArgs.indexOf('-vf') + 1];
                expect(vfArg).toContain('scale=160:90');
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should round height to nearest even number for odd aspect ratios', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                // 1280x720: width=160, height = ceil((160/1280)*720 / 2)*2 = ceil(45)*2 = 90
                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1280,
                    sourceHeight: 720,
                });

                const spriteArgs = spriteCall() as string[];
                const vfArg = spriteArgs[spriteArgs.indexOf('-vf') + 1];
                expect(vfArg).toContain('scale=160:90');
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should produce even height for non-standard aspect ratio', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                // 300x200: width=160, rawHeight = (160/300)*200 = 106.666...
                // height = ceil(106.666.../2)*2 = ceil(53.333)*2 = 54*2 = 108
                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 300,
                    sourceHeight: 200,
                });

                const spriteArgs = spriteCall() as string[];
                const vfArg = spriteArgs[spriteArgs.indexOf('-vf') + 1];
                expect(vfArg).toContain('scale=160:108');

                // Height must always be even
                const heightMatch = vfArg.match(/scale=160:(\d+)/);
                expect(Number(heightMatch![1]) % 2).toBe(0);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should create thumbnails dir and write VTT file on success', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                const result = await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                expect(result).toEqual({
                    vttRelativePath: 'thumbnails/thumbnails.vtt',
                });

                // Verify thumbnails directory was created
                const thumbnailDir = join(tmpDir, 'thumbnails');
                const files = readdirSync(thumbnailDir);
                expect(files).toContain('thumbnails.vtt');

                // Verify VTT content
                const { readFileSync } = await import('fs');
                const vttContent = readFileSync(
                    join(thumbnailDir, 'thumbnails.vtt'),
                    'utf-8'
                );
                expect(vttContent).toContain('WEBVTT');
                expect(vttContent).toContain('sprite_001.webp');
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should pass correct ffmpeg arguments for sprite generation', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... libwebp          libwebp WebP',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.webp'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                // Verify sprite generation call args
                const spriteIdx = mockExecFile.mock.calls.findIndex(
                    (c: any[]) =>
                        (c[1] as string[])?.some(
                            (a) =>
                                typeof a === 'string' &&
                                a.includes('sprite_%03d')
                        )
                );
                const [cmd, args, opts] = mockExecFile.mock.calls[spriteIdx];
                expect(cmd).toBe('ffmpeg');
                expect(args).toContain('-i');
                expect(args).toContain('/tmp/test.mp4');
                expect(args).toContain('-c:v');
                expect(args).toContain('libwebp');
                expect(args).toContain('-an');
                expect(args).toContain('-quality');
                expect(args).toContain('30');
                expect(args).toContain('-compression_level');
                expect(args).toContain('6');

                // Verify -vf filter string
                const vfArg = args[args.indexOf('-vf') + 1];
                expect(vfArg).toBe('fps=1/5,scale=160:90,tile=5x5');

                // Verify timeout
                expect(opts).toEqual({ timeout: 300_000 });
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should pass mjpeg-specific args when mjpeg is detected', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                let callCount = 0;
                mockExecFile.mockImplementation((...args: any[]) => {
                    const cb = args[args.length - 1];
                    callCount++;
                    const ffargs = args[1] as string[];
                    if (ffargs[0] === '-hwaccels') {
                        cb(null, { stdout: '', stderr: '' });
                        return;
                    }
                    if (ffargs[0] === '-encoders') {
                        cb(null, {
                            stdout: ' V..... mjpeg            MJPEG encoder',
                            stderr: '',
                        });
                    } else {
                        const thumbnailDir = join(tmpDir, 'thumbnails');
                        writeFileSync(
                            join(thumbnailDir, 'sprite_001.jpg'),
                            'fake-sprite'
                        );
                        cb(null, { stdout: '', stderr: '' });
                    }
                });

                await service.generateThumbnails({
                    inputPath: '/tmp/test.mp4',
                    outputDir: tmpDir,
                    duration: 10,
                    sourceWidth: 1920,
                    sourceHeight: 1080,
                });

                const spriteArgs = spriteCall() as string[];
                expect(spriteArgs).toContain('mjpeg');
                expect(spriteArgs).toContain('-q:v');
                expect(spriteArgs).toContain('8');
                // Should NOT contain libwebp args
                expect(spriteArgs).not.toContain('-quality');
                expect(spriteArgs).not.toContain('-compression_level');
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
