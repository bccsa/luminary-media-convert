import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
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

import {
    ThumbnailService,
    formatVttTime,
    selectStoryboardTrack,
} from './thumbnail.service.js';

/** ffmpeg's own `-encoders` listing, trimmed to the line the service looks for. */
const WEBP_ENCODERS = ' V..... libwebp          libwebp WebP image';
const MJPEG_ENCODERS = ' V..... mjpeg            MJPEG encoder';

/** Output patterns, which is how a call is identified — see `passArgs`. */
const THUMBS = 'thumb_%06d';
const SPRITES = 'sprite_%03d';

/**
 * The real clock, captured before any test fakes it, so a test driving fake
 * timers can still let genuine filesystem work land.
 */
const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 1));

/** Wait for something the service does off the awaited path. */
async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (condition()) return;
        await settle();
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** The individual thumbnails an ingest pass would have left on disk. */
function writeThumbs(dir: string, count: number, ext = 'webp'): void {
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= count; i++) {
        writeFileSync(
            join(dir, `thumb_${String(i).padStart(6, '0')}.${ext}`),
            'fake-thumb'
        );
    }
}

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

describe('selectStoryboardTrack', () => {
    it('takes the smallest angle that still has pixels to spare', () => {
        // Left to itself ffmpeg picks "best", which on a multi-angle file has
        // landed on a 256x144 proxy — the wrong camera, at postage-stamp size.
        const track = selectStoryboardTrack([
            { index: 0, width: 3840, height: 2160 },
            { index: 1, width: 640, height: 360 },
            { index: 2, width: 1920, height: 1080 },
        ]);

        expect(track).toEqual({ index: 1, width: 640, height: 360 });
    });

    it('counts exactly twice the thumbnail width as wide enough', () => {
        const track = selectStoryboardTrack([
            { index: 0, width: 320, height: 180 },
            { index: 1, width: 1920, height: 1080 },
        ]);

        expect(track?.index).toBe(0);
    });

    it('falls back to the largest when every angle is smaller than that', () => {
        const track = selectStoryboardTrack([
            { index: 0, width: 160, height: 90 },
            { index: 1, width: 256, height: 144 },
        ]);

        expect(track).toEqual({ index: 1, width: 256, height: 144 });
    });

    it('ignores tracks with no usable dimensions', () => {
        const track = selectStoryboardTrack([
            { index: 0, width: 0, height: 0 },
            { index: 1 },
            { index: 2, width: 640, height: 0 },
            { index: 3, width: 1280, height: 720 },
        ]);

        expect(track).toEqual({ index: 3, width: 1280, height: 720 });
    });

    it('reports the dense video index, not the position in the list', () => {
        // The index is handed straight to `-map 0:v:N`, so it has to be the
        // per-type index the probe assigned rather than where it happened to
        // sit in the array.
        const track = selectStoryboardTrack([
            { index: 2, width: 640, height: 360 },
            { index: 0, width: 1920, height: 1080 },
            { index: 1, width: 3840, height: 2160 },
        ]);

        expect(track?.index).toBe(2);
    });

    it('has nothing to offer for a source with no video', () => {
        expect(selectStoryboardTrack([])).toBeNull();
        expect(selectStoryboardTrack(undefined)).toBeNull();
        expect(selectStoryboardTrack([{ index: 0, width: 0, height: 0 }])).toBe(
            null
        );
    });
});

describe('ThumbnailService', () => {
    let service: ThumbnailService;

    /**
     * ffmpeg invocations are found by what they write rather than by position:
     * capability probes run before them, and counting calls made every
     * assertion here break the moment one was added.
     */
    function passCalls(pattern: string): any[][] {
        return mockExecFile.mock.calls.filter((c: any[]) =>
            (c[1] as string[])?.some(
                (a) => typeof a === 'string' && a.includes(pattern)
            )
        );
    }

    function passCall(pattern: string): any[] {
        const call = passCalls(pattern)[0];
        if (!call)
            throw new Error(`ffmpeg was never asked to write ${pattern}`);
        return call;
    }

    function passArgs(pattern: string): string[] {
        return passCall(pattern)[1] as string[];
    }

    /**
     * ffmpeg as far as this service can tell: the encoder probe answers, and
     * any other invocation writes the files the real thing would have produced
     * into the directory its own output pattern names.
     */
    function mockFfmpeg(
        opts: {
            encoders?: string;
            thumbs?: number;
            sprites?: number;
            failPass?: boolean;
            onPass?: (args: string[]) => void;
        } = {}
    ) {
        mockExecFile.mockImplementation((...call: any[]) => {
            const cb = call[call.length - 1];
            const args = call[1] as string[];
            if (args[0] === '-encoders') {
                cb(null, {
                    stdout: opts.encoders ?? WEBP_ENCODERS,
                    stderr: '',
                });
                return;
            }
            opts.onPass?.(args);
            if (opts.failPass) {
                cb(new Error('ffmpeg exited with code 1'), null, null);
                return;
            }
            const pattern = args[args.length - 1]!;
            const dir = dirname(pattern);
            const ext = pattern.slice(pattern.lastIndexOf('.') + 1);
            const packing = pattern.includes(SPRITES);
            mkdirSync(dir, { recursive: true });
            const count = packing ? (opts.sprites ?? 1) : (opts.thumbs ?? 1);
            for (let i = 1; i <= count; i++) {
                const name = packing
                    ? `sprite_${String(i).padStart(3, '0')}.${ext}`
                    : `thumb_${String(i).padStart(6, '0')}.${ext}`;
                writeFileSync(join(dir, name), 'fake-image');
            }
            cb(null, { stdout: '', stderr: '' });
        });
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

    describe('buildIndividualVtt', () => {
        const thumbs = (n: number) =>
            Array.from(
                { length: n },
                (_, i) => `thumb_${String(i + 1).padStart(6, '0')}.webp`
            );

        it('gives every cue the whole image', () => {
            // Individual thumbs have no grid to crop out of, but clients read
            // `#xywh` either way, so the rectangle is simply the full frame.
            const vtt = service.buildIndividualVtt(15, thumbs(3), 160, 90);

            expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
            expect(vtt).toContain('thumb_000001.webp#xywh=0,0,160,90');
            expect(vtt).toContain('00:00:05.000 --> 00:00:10.000');
            expect(vtt).toContain('thumb_000002.webp#xywh=0,0,160,90');
            expect(vtt).toContain('00:00:10.000 --> 00:00:15.000');
            expect(vtt).toContain('thumb_000003.webp#xywh=0,0,160,90');

            const rects = vtt
                .split('\n')
                .filter((l) => l.includes('#xywh='))
                .map((l) => l.split('#xywh=')[1]);
            expect(rects).toEqual(['0,0,160,90', '0,0,160,90', '0,0,160,90']);
        });

        it('clamps the last cue to the end of the source', () => {
            const vtt = service.buildIndividualVtt(7, thumbs(2), 160, 90);

            expect(vtt).toContain('00:00:05.000 --> 00:00:07.000');
        });

        it('covers only as much as the thumbnails on hand describe', () => {
            // A partial storyboard: sampling is still running, so the cues stop
            // where the files do rather than pretending to cover the source.
            const vtt = service.buildIndividualVtt(600, thumbs(3), 160, 90);

            const cues = vtt.split('\n').filter((l) => l.includes(' --> '));
            expect(cues).toHaveLength(3);
            expect(vtt).toContain('00:00:10.000 --> 00:00:15.000');
        });

        it('stops at the end of the source when thumbnails overrun it', () => {
            const vtt = service.buildIndividualVtt(12, thumbs(10), 160, 90);

            const cues = vtt.split('\n').filter((l) => l.includes(' --> '));
            expect(cues).toHaveLength(3);
            expect(vtt).toContain('00:00:10.000 --> 00:00:12.000');
        });
    });

    describe('getOrGeneratePreview', () => {
        let workDir: string;
        let svc: ThumbnailService;
        const SID = 'sess-1';

        /** Where generateIndividualThumbs actually writes. */
        function producedDir(): string {
            return join(workDir, SID, 'preview-thumbnails', 'thumbnails');
        }

        /** Answers the capability probes; leaves the sampling pass hanging. */
        function mockGenerationInFlight() {
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
                // Sampling: never completes during the test.
            });
        }

        const opts = () => ({
            inputPath: '/tmp/source.mkv',
            duration: 600,
            trackIndex: 0,
            sourceWidth: 1920,
            sourceHeight: 1080,
        });

        beforeEach(() => {
            workDir = mkdtempSync(join(tmpdir(), 'thumb-preview-'));
            process.env.WORK_DIR = workDir;
            svc = new ThumbnailService();
            mockExecFile.mockReset();
        });

        afterEach(() => {
            rmSync(workDir, { recursive: true, force: true });
            delete process.env.WORK_DIR;
        });

        it('reads the finished storyboard from where it was written', async () => {
            // Looked for where it was written: one directory out and the cache
            // never hits, so every request kicks off another full ffmpeg pass.
            mkdirSync(producedDir(), { recursive: true });
            writeFileSync(
                join(producedDir(), 'thumbnails.vtt'),
                'WEBVTT\n\ncached'
            );
            mockGenerationInFlight();

            const result = await svc.getOrGeneratePreview(SID, opts());

            expect(result?.vtt).toContain('cached');
            expect(result?.complete).toBe(true);
            // Nothing was regenerated: no ffmpeg call at all.
            expect(mockExecFile).not.toHaveBeenCalled();
        });

        it('serves the thumbnails written so far instead of waiting for the rest', async () => {
            writeThumbs(producedDir(), 3);
            mockGenerationInFlight();

            const result = await svc.getOrGeneratePreview(SID, opts());

            expect(result).not.toBeNull();
            expect(result!.complete).toBe(false);
            expect(result!.vtt).toContain('WEBVTT');
            expect(result!.vtt).toContain('thumb_000001.webp');
            expect(result!.vtt).toContain('thumb_000003.webp');
        });

        it('covers only the sampled span, not the whole duration', async () => {
            // Three thumbnails at 5s each — 15s of a 600s source.
            writeThumbs(producedDir(), 3);
            mockGenerationInFlight();

            const result = await svc.getOrGeneratePreview(SID, opts());

            const cues = result!.vtt
                .split('\n')
                .filter((l) => l.includes(' --> '));
            expect(cues).toHaveLength(3);
        });

        it('has nothing to offer before the first thumbnail lands', async () => {
            mockGenerationInFlight();

            expect(await svc.getOrGeneratePreview(SID, opts())).toBeNull();
        });

        it('does not start a second pass while one is running', async () => {
            mockGenerationInFlight();

            await svc.getOrGeneratePreview(SID, opts());
            await svc.getOrGeneratePreview(SID, opts());
            // The pass is started but not awaited, so give its own setup — probe,
            // mkdir — time to reach ffmpeg before counting.
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Scoped to this test's own work directory: other tests leave a
            // deliberately hanging pass behind, and its ffmpeg call can land here
            // after the mock is reset.
            const passes = mockExecFile.mock.calls.filter((c: any[]) =>
                (c[1] as string[])?.some(
                    (a) =>
                        typeof a === 'string' &&
                        a.includes(THUMBS) &&
                        a.includes(workDir)
                )
            );
            expect(passes).toHaveLength(1);
        });

        it('samples the track it was told to, not whichever ffmpeg calls best', async () => {
            mockGenerationInFlight();

            await svc.getOrGeneratePreview(SID, { ...opts(), trackIndex: 2 });
            await until(
                () => passCalls(THUMBS).length > 0,
                'the sampling pass to start'
            );

            const args = passArgs(THUMBS);
            expect(args[args.indexOf('-map') + 1]).toBe('0:v:2');
        });
    });

    describe('software decoding and timeout', () => {
        /** Drive a sampling pass and hand back the tmp dir it wrote into. */
        async function run(opts: { duration?: number; fail?: boolean } = {}) {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-accel-'));
            mockFfmpeg({ thumbs: 2, failPass: opts.fail });

            const result = await service.generateIndividualThumbs({
                inputPath: '/tmp/test.mkv',
                outputDir: tmpDir,
                duration: opts.duration ?? 60,
                trackIndex: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            rmSync(tmpDir, { recursive: true, force: true });
            return result;
        }

        /** Run the pass as if this were an Apple Silicon machine. */
        async function runAs(platform: string, arch: string) {
            const platformDesc = Object.getOwnPropertyDescriptor(
                process,
                'platform'
            )!;
            const archDesc = Object.getOwnPropertyDescriptor(process, 'arch')!;
            Object.defineProperty(process, 'platform', {
                value: platform,
                configurable: true,
            });
            Object.defineProperty(process, 'arch', {
                value: arch,
                configurable: true,
            });
            try {
                return await run();
            } finally {
                Object.defineProperty(process, 'platform', platformDesc);
                Object.defineProperty(process, 'arch', archDesc);
            }
        }

        it('never asks the GPU to decode', async () => {
            // Measured on a 55-minute source: `-hwaccel videotoolbox` took 337s
            // against 13.9s in software for byte-identical images. The filter
            // chain scales in software, so every frame is read back off the GPU
            // and the readback costs far more than the decode saves.
            await run();

            expect(passArgs(THUMBS)).not.toContain('-hwaccel');
            expect(passArgs(THUMBS)).not.toContain('-hwaccel_output_format');
        });

        it('never asks the GPU to decode on an Apple Silicon machine either', async () => {
            await runAs('darwin', 'arm64');

            expect(passArgs(THUMBS)).not.toContain('-hwaccel');
        });

        it('does not even ask ffmpeg what acceleration it has', async () => {
            // Nothing about the answer could change the arguments, and the probe
            // is another ffmpeg spawn on every session.
            await run();

            const probes = mockExecFile.mock.calls.filter((c: any[]) =>
                (c[1] as string[])?.includes('-hwaccels')
            );
            expect(probes).toHaveLength(0);
        });

        it('gives up on a failed pass rather than trying again', async () => {
            // A software-retry guard cannot work here: VideoToolbox logs a
            // per-frame decode failure and still exits 0, so the retry would
            // never fire on the failure it exists for.
            const result = await run({ fail: true });

            expect(result).toBeNull();
            expect(passCalls(THUMBS)).toHaveLength(1);
        });

        it('gives a long source proportionally longer to finish', async () => {
            // The pass walks the whole file, so a fixed cap cut an hour-long
            // video off after a third of it and left the timeline half-drawn.
            await run({ duration: 3600 });

            expect(passCall(THUMBS)[2].timeout).toBe(900_000);
        });

        it('gives execFile an integer, whatever the duration', async () => {
            // Durations are fractional. This exact source scaled to 899340.25ms,
            // which execFile rejects outright — killing the pass before ffmpeg
            // was ever started.
            await run({ duration: 3597.361 });

            expect(Number.isInteger(passCall(THUMBS)[2].timeout)).toBe(true);
            expect(passCall(THUMBS)[2].timeout).toBe(899_340);
        });

        it('keeps the old five minutes as the floor for short clips', async () => {
            await run({ duration: 30 });

            expect(passCall(THUMBS)[2].timeout).toBe(300_000);
        });

        it('caps the budget so a pathological source cannot hang forever', async () => {
            await run({ duration: 36_000 });

            expect(passCall(THUMBS)[2].timeout).toBe(1_800_000);
        });
    });

    describe('detectSpriteFormat (via generateIndividualThumbs)', () => {
        const sample = (outputDir: string, dims = [1920, 1080]) =>
            service.generateIndividualThumbs({
                inputPath: '/tmp/test.mp4',
                outputDir,
                duration: 10,
                trackIndex: 0,
                sourceWidth: dims[0]!,
                sourceHeight: dims[1]!,
            });

        it('should select libwebp when ffmpeg supports it', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                mockFfmpeg({ encoders: WEBP_ENCODERS, thumbs: 2 });

                const result = await sample(tmpDir);

                expect(result).toEqual({
                    vttRelativePath: 'thumbnails/thumbnails.vtt',
                });

                // Verify the first call was ffmpeg -encoders
                expect(mockExecFile.mock.calls[0][0]).toBe('ffmpeg');
                expect(mockExecFile.mock.calls[0][1]).toEqual(['-encoders']);

                const args = passArgs(THUMBS);
                expect(args).toContain('libwebp');
                expect(args[args.length - 1]).toMatch(/thumb_%06d\.webp$/);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should fall back to mjpeg when libwebp is unavailable', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            try {
                mockFfmpeg({ encoders: MJPEG_ENCODERS, thumbs: 2 });

                const result = await sample(tmpDir);

                expect(result).toEqual({
                    vttRelativePath: 'thumbnails/thumbnails.vtt',
                });

                const args = passArgs(THUMBS);
                expect(args).toContain('mjpeg');
                expect(args[args.length - 1]).toMatch(/thumb_%06d\.jpg$/);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('should return null when no suitable encoder is available', async () => {
            mockFfmpeg({ encoders: ' V..... libx264          H.264 encoder' });

            const result = await sample('/tmp/output');

            expect(result).toBeNull();
            // Only the encoder detection call should have been made
            expect(mockExecFile).toHaveBeenCalledTimes(1);
        });

        it('should return null when ffmpeg is not found (execFile throws)', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                cb(new Error('spawn ffmpeg ENOENT'), null, null);
            });

            expect(await sample('/tmp/output')).toBeNull();
        });

        it('should cache the detected format and not re-run ffmpeg -encoders', async () => {
            const tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
            const tmpDir2 = mkdtempSync(join(tmpdir(), 'thumb-test2-'));
            try {
                mockFfmpeg({ thumbs: 1 });

                await sample(tmpDir);

                // encoder probe + the sampling pass, nothing else
                expect(mockExecFile).toHaveBeenCalledTimes(2);
                const prevCallCount = mockExecFile.mock.calls.length;

                await sample(tmpDir2);

                // Should only have 1 additional call (sampling only, no detection)
                expect(mockExecFile).toHaveBeenCalledTimes(prevCallCount + 1);
                const lastCall =
                    mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1];
                expect(lastCall[1]).not.toEqual(['-encoders']);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
                rmSync(tmpDir2, { recursive: true, force: true });
            }
        });

        it('should cache null result and not retry detection', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                cb(new Error('spawn ffmpeg ENOENT'), null, null);
            });

            await sample('/tmp/output');
            expect(mockExecFile).toHaveBeenCalledTimes(1);

            // Second call — should use cached null, not call ffmpeg again
            await sample('/tmp/output');
            expect(mockExecFile).toHaveBeenCalledTimes(1);
        });
    });

    describe('generateIndividualThumbs', () => {
        let tmpDir: string;

        const sample = (
            overrides: Partial<{
                duration: number;
                trackIndex: number;
                sourceWidth: number;
                sourceHeight: number;
                outputDir: string;
            }> = {}
        ) =>
            service.generateIndividualThumbs({
                inputPath: '/tmp/test.mp4',
                outputDir: overrides.outputDir ?? tmpDir,
                duration: overrides.duration ?? 10,
                trackIndex: overrides.trackIndex ?? 0,
                sourceWidth: overrides.sourceWidth ?? 1920,
                sourceHeight: overrides.sourceHeight ?? 1080,
            });

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'thumb-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should return null when duration is 0', async () => {
            expect(await sample({ duration: 0 })).toBeNull();
        });

        it('should return null when duration is negative', async () => {
            expect(await sample({ duration: -1 })).toBeNull();
        });

        it('should return null when ffmpeg sampling fails', async () => {
            mockFfmpeg({ failPass: true });

            expect(await sample()).toBeNull();
        });

        it('should return null when no thumbnails are generated', async () => {
            mockFfmpeg({ thumbs: 0 });

            expect(await sample()).toBeNull();
        });

        it('should calculate even thumbnail height from source dimensions', async () => {
            mockFfmpeg({ thumbs: 1 });

            // 1920x1080 -> width=160, height = ceil((160/1920)*1080 / 2)*2 = 90
            await sample();

            const args = passArgs(THUMBS);
            expect(args[args.indexOf('-vf') + 1]).toContain('scale=160:90');
        });

        it('should round height to nearest even number for odd aspect ratios', async () => {
            mockFfmpeg({ thumbs: 1 });

            // 1280x720: width=160, height = ceil((160/1280)*720 / 2)*2 = 90
            await sample({ sourceWidth: 1280, sourceHeight: 720 });

            const args = passArgs(THUMBS);
            expect(args[args.indexOf('-vf') + 1]).toContain('scale=160:90');
        });

        it('should produce even height for non-standard aspect ratio', async () => {
            mockFfmpeg({ thumbs: 1 });

            // 300x200: rawHeight = (160/300)*200 = 106.66..; ceil(53.33)*2 = 108
            await sample({ sourceWidth: 300, sourceHeight: 200 });

            const args = passArgs(THUMBS);
            const vfArg = args[args.indexOf('-vf') + 1]!;
            expect(vfArg).toContain('scale=160:108');
            expect(Number(vfArg.match(/scale=160:(\d+)/)![1]) % 2).toBe(0);
        });

        it('should create thumbnails dir and write VTT file on success', async () => {
            mockFfmpeg({ thumbs: 2 });

            const result = await sample();

            expect(result).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });

            const thumbnailDir = join(tmpDir, 'thumbnails');
            expect(readdirSync(thumbnailDir)).toContain('thumbnails.vtt');

            const vttContent = readFileSync(
                join(thumbnailDir, 'thumbnails.vtt'),
                'utf-8'
            );
            expect(vttContent).toContain('WEBVTT');
            expect(vttContent).toContain('thumb_000001.webp#xywh=0,0,160,90');
            expect(vttContent).toContain('thumb_000002.webp#xywh=0,0,160,90');
        });

        it('should pass correct ffmpeg arguments for sampling', async () => {
            mockFfmpeg({ thumbs: 1 });

            await sample();

            const [cmd, args, opts] = passCall(THUMBS);
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

            // One image per sampled instant — the tiling happens at encode time
            // now, from the frames this pass leaves behind.
            expect(args[args.indexOf('-vf') + 1]).toBe('fps=1/5,scale=160:90');
            expect(args[args.indexOf('-vf') + 1]).not.toContain('tile=');

            expect(opts).toEqual({ timeout: 300_000 });
        });

        it('maps the chosen video track before the filter runs', async () => {
            mockFfmpeg({ thumbs: 1 });

            await sample({ trackIndex: 3 });

            const args = passArgs(THUMBS);
            expect(args[args.indexOf('-map') + 1]).toBe('0:v:3');
            // The map is an output option for the filter to draw from; after
            // -vf it would select a stream the filter graph never sees.
            expect(args.indexOf('-map')).toBeLessThan(args.indexOf('-vf'));
        });

        it('numbers thumbnails wide enough for an hour of source', async () => {
            // An hour is 720 thumbs at one per five seconds, and a three-digit
            // counter wraps long before that.
            mockFfmpeg({ thumbs: 1 });

            await sample();

            const args = passArgs(THUMBS);
            expect(args[args.length - 1]).toBe(
                join(tmpDir, 'thumbnails', 'thumb_%06d.webp')
            );
        });

        it('should pass mjpeg-specific args when mjpeg is detected', async () => {
            mockFfmpeg({ encoders: MJPEG_ENCODERS, thumbs: 1 });

            await sample();

            const args = passArgs(THUMBS);
            expect(args).toContain('mjpeg');
            expect(args).toContain('-q:v');
            expect(args).toContain('8');
            // Should NOT contain libwebp args
            expect(args).not.toContain('-quality');
            expect(args).not.toContain('-compression_level');
        });
    });

    describe('generateIndividualThumbs progress reporting', () => {
        let tmpDir: string;
        let thumbnailDir: string;
        let finish: (() => void) | null;

        /** Answers the probe, then hands the pass's completion to the test. */
        function mockDeferredPass() {
            finish = null;
            mockExecFile.mockImplementation((...call: any[]) => {
                const cb = call[call.length - 1];
                const args = call[1] as string[];
                if (args[0] === '-encoders') {
                    cb(null, { stdout: WEBP_ENCODERS, stderr: '' });
                    return;
                }
                finish = () => cb(null, { stdout: '', stderr: '' });
            });
        }

        const sample = (onProgress?: (n: number, complete?: boolean) => void) =>
            service.generateIndividualThumbs({
                inputPath: '/tmp/test.mp4',
                outputDir: tmpDir,
                duration: 600,
                trackIndex: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
                onProgress,
            });

        beforeEach(() => {
            vi.useFakeTimers();
            tmpDir = mkdtempSync(join(tmpdir(), 'thumb-progress-'));
            thumbnailDir = join(tmpDir, 'thumbnails');
        });

        afterEach(() => {
            vi.useRealTimers();
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('reports the count as thumbnails land, and only when it changes', async () => {
            mockDeferredPass();
            const onProgress = vi.fn();

            const pass = sample(onProgress);
            await until(() => finish !== null, 'the sampling pass to start');
            expect(vi.getTimerCount()).toBe(1);

            // Zero is the state before anything was written: waking a client to
            // fetch an empty storyboard is worse than saying nothing.
            await vi.advanceTimersByTimeAsync(1000);
            await settle();
            expect(onProgress).not.toHaveBeenCalled();

            writeThumbs(thumbnailDir, 2);
            await vi.advanceTimersByTimeAsync(1000);
            await until(
                () => onProgress.mock.calls.length === 1,
                'the first progress report'
            );
            expect(onProgress).toHaveBeenCalledWith(2);

            // Same count a tick later says nothing new.
            await vi.advanceTimersByTimeAsync(1000);
            await settle();
            expect(onProgress).toHaveBeenCalledTimes(1);

            writeThumbs(thumbnailDir, 3);
            await vi.advanceTimersByTimeAsync(1000);
            await until(
                () => onProgress.mock.calls.length === 2,
                'the second progress report'
            );
            expect(onProgress).toHaveBeenLastCalledWith(3);

            finish!();
            expect(await pass).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
        });

        it('says so once the finished storyboard is on disk', async () => {
            mockDeferredPass();
            const onProgress = vi.fn();
            const seenAtCompletion: string[] = [];
            onProgress.mockImplementation((_n: number, complete?: boolean) => {
                if (complete)
                    seenAtCompletion.push(...readdirSync(thumbnailDir));
            });

            const pass = sample(onProgress);
            await until(() => finish !== null, 'the sampling pass to start');
            writeThumbs(thumbnailDir, 4);

            finish!();
            await pass;

            expect(onProgress).toHaveBeenLastCalledWith(4, true);
            // The completion report is the client's cue to fetch the whole
            // storyboard, so the VTT has to be there before it is made.
            expect(seenAtCompletion).toContain('thumbnails.vtt');
        });

        it('survives a caller whose callback throws', async () => {
            mockDeferredPass();
            const onProgress = vi.fn(() => {
                throw new Error('the client went away');
            });

            const pass = sample(onProgress);
            await until(() => finish !== null, 'the sampling pass to start');
            writeThumbs(thumbnailDir, 2);

            // Once from the watcher, once from the completion report.
            await vi.advanceTimersByTimeAsync(1000);
            await until(
                () => onProgress.mock.calls.length === 1,
                'the watcher report'
            );

            finish!();
            expect(await pass).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
            expect(onProgress).toHaveBeenCalledTimes(2);
        });

        it('arms no watcher when nobody is listening', async () => {
            mockDeferredPass();

            const pass = sample();
            await until(() => finish !== null, 'the sampling pass to start');

            expect(vi.getTimerCount()).toBe(0);

            writeThumbs(thumbnailDir, 1);
            finish!();
            expect(await pass).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
        });
    });

    describe('packForDelivery', () => {
        let workDir: string;
        let outputDir: string;
        let svc: ThumbnailService;
        let packList: string[];
        const SID = 'sess-pack';

        /** Where the ingest pass left its individual thumbnails. */
        const sourceDir = () =>
            join(workDir, SID, 'preview-thumbnails', 'thumbnails');
        const outThumbDir = () => join(outputDir, 'thumbnails');
        const listPath = () => join(outThumbDir(), 'pack-list.txt');

        /**
         * The concat list ffmpeg was handed, captured while it still exists —
         * the service deletes it in a `finally`, pass or fail.
         */
        function capturePackList(args: string[]) {
            if (!args.includes('concat')) return;
            packList = readFileSync(args[args.indexOf('-i') + 1]!, 'utf-8')
                .trim()
                .split('\n');
        }

        /** The thumbnails named in the pack list, by bare filename. */
        const packed = () =>
            packList.map((line) =>
                basename(line.replace(/^file '(.*)'$/, '$1'))
            );

        const pack = (
            overrides: Partial<{
                sourceDuration: number;
                trimSegments: { inSec: number; outSec: number }[];
                videoTracks: Array<{
                    index: number;
                    width: number;
                    height: number;
                }>;
            }> = {}
        ) =>
            svc.packForDelivery({
                sessionId: SID,
                inputPath: '/tmp/source.mkv',
                outputDir,
                sourceDuration: overrides.sourceDuration ?? 60,
                trimSegments: overrides.trimSegments,
                videoTracks: overrides.videoTracks ?? [
                    { index: 0, width: 1920, height: 1080 },
                ],
            });

        beforeEach(() => {
            workDir = mkdtempSync(join(tmpdir(), 'thumb-pack-'));
            outputDir = mkdtempSync(join(tmpdir(), 'thumb-out-'));
            process.env.WORK_DIR = workDir;
            svc = new ThumbnailService();
            packList = [];
            mockExecFile.mockReset();
            mockFfmpeg({ thumbs: 12, sprites: 1, onPass: capturePackList });
        });

        afterEach(() => {
            rmSync(workDir, { recursive: true, force: true });
            rmSync(outputDir, { recursive: true, force: true });
            delete process.env.WORK_DIR;
        });

        it('lays out one source frame per output cue', async () => {
            writeThumbs(sourceDir(), 20);

            const result = await pack({ sourceDuration: 60 });

            expect(result).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
            // 60s of output is 12 cues at five seconds each.
            expect(packed()).toEqual([
                'thumb_000001.webp',
                'thumb_000002.webp',
                'thumb_000003.webp',
                'thumb_000004.webp',
                'thumb_000005.webp',
                'thumb_000006.webp',
                'thumb_000007.webp',
                'thumb_000008.webp',
                'thumb_000009.webp',
                'thumb_000010.webp',
                'thumb_000011.webp',
                'thumb_000012.webp',
            ]);
        });

        it('decodes nothing from the source', async () => {
            // The whole point of sampling at ingest: a trimmed encode costs no
            // second pass over the original file.
            writeThumbs(sourceDir(), 20);

            await pack();

            expect(passArgs(SPRITES)).not.toContain('/tmp/source.mkv');
        });

        it('walks the kept ranges to find each output cue its frame', async () => {
            writeThumbs(sourceDir(), 20);

            await pack({
                sourceDuration: 100,
                trimSegments: [
                    { inSec: 0, outSec: 20 },
                    { inSec: 40, outSec: 60 },
                ],
            });

            expect(packed()).toEqual([
                'thumb_000001.webp',
                'thumb_000002.webp',
                'thumb_000003.webp',
                'thumb_000004.webp',
                'thumb_000009.webp',
                'thumb_000010.webp',
                'thumb_000011.webp',
                'thumb_000012.webp',
            ]);

            // The VTT describes the output timeline — 40s of kept material, not
            // the 100s the source ran for.
            const vtt = readFileSync(
                join(outThumbDir(), 'thumbnails.vtt'),
                'utf-8'
            );
            expect(vtt).toContain('00:00:35.000 --> 00:00:40.000');
            expect(vtt).not.toContain('00:00:40.000 -->');
        });

        it('never shows a frame from material the user cut out', async () => {
            // Cue 0 of a cut starting at 12s maps to source t=14.5, and
            // floor(14.5/5) names the thumb sampled at t=10 — two seconds of
            // deleted footage. The clamp lifts it to ceil(12/5)=3, the first
            // sample at or after the cut-in, which is thumb_000004 (ffmpeg
            // numbers its output from one).
            writeThumbs(sourceDir(), 20);

            await pack({
                sourceDuration: 100,
                trimSegments: [{ inSec: 12, outSec: 40 }],
            });

            expect(packed()[0]).toBe('thumb_000004.webp');
            expect(packed()[0]).not.toBe('thumb_000003.webp');
        });

        it('gives a range too short to contain a sample the frame after its cut-in', async () => {
            // 7s to 9s contains no sampled instant at all: the bounds cross, and
            // the cut-in side wins. A frame from just past the range is a small
            // inaccuracy; thumb_000002, sampled at t=5, is deleted material.
            writeThumbs(sourceDir(), 20);

            await pack({
                sourceDuration: 100,
                trimSegments: [{ inSec: 7, outSec: 9 }],
            });

            expect(packed()).toEqual(['thumb_000003.webp']);
        });

        it('reuses a frame rather than leaving an output cue without one', async () => {
            // Two short ranges either side of the same sample instant. The
            // concat demuxer is what makes this expressible — a numbered image
            // sequence could not name the same file twice.
            writeThumbs(sourceDir(), 20);

            await pack({
                sourceDuration: 100,
                trimSegments: [
                    { inSec: 1, outSec: 4 },
                    { inSec: 4.5, outSec: 7.5 },
                ],
            });

            expect(packed()).toEqual([
                'thumb_000002.webp',
                'thumb_000002.webp',
            ]);
        });

        it('never names a frame that was never sampled', async () => {
            // A pass cut short by its timeout leaves fewer thumbs than the
            // output has cues; the tail repeats the last one it has.
            writeThumbs(sourceDir(), 3);

            await pack({ sourceDuration: 30 });

            expect(packed()).toHaveLength(6);
            expect(new Set(packed())).toEqual(
                new Set([
                    'thumb_000001.webp',
                    'thumb_000002.webp',
                    'thumb_000003.webp',
                ])
            );
        });

        it('escapes a quote in the path instead of handing ffmpeg half a filename', async () => {
            const quoted = new ThumbnailService();
            const sid = "sess'quote";
            const dir = join(workDir, sid, 'preview-thumbnails', 'thumbnails');
            writeThumbs(dir, 4);

            await quoted.packForDelivery({
                sessionId: sid,
                inputPath: '/tmp/source.mkv',
                outputDir,
                sourceDuration: 10,
                videoTracks: [{ index: 0, width: 1920, height: 1080 }],
            });

            expect(packList[0]).toContain("sess'\\''quote");
            expect(packList[0]).toMatch(/^file '.*thumb_000001\.webp'$/);
        });

        it('passes ffmpeg the concat list and asks for a 5x5 grid', async () => {
            writeThumbs(sourceDir(), 20);

            await pack({ sourceDuration: 10 });

            const [cmd, args, opts] = passCall(SPRITES);
            expect(cmd).toBe('ffmpeg');
            expect((args as string[]).slice(0, 6)).toEqual([
                '-f',
                'concat',
                '-safe',
                '0',
                '-i',
                listPath(),
            ]);
            expect(args[args.indexOf('-vf') + 1]).toBe('tile=5x5');
            expect(args).toContain('-c:v');
            expect(args).toContain('libwebp');
            expect(args).toContain('-quality');
            expect(args).toContain('-an');
            expect(args[args.length - 1]).toBe(
                join(outThumbDir(), 'sprite_%03d.webp')
            );
            // No source decode in sight, so a fixed budget is enough.
            expect(opts).toEqual({ timeout: 60_000 });
        });

        it('leaves no pack list behind', async () => {
            writeThumbs(sourceDir(), 20);

            await pack();

            expect(packList.length).toBeGreaterThan(0);
            expect(existsSync(listPath())).toBe(false);
            expect(readdirSync(outThumbDir())).not.toContain('pack-list.txt');
        });

        it('leaves no pack list behind when the pack fails either', async () => {
            writeThumbs(sourceDir(), 20);
            mockFfmpeg({ failPass: true, onPass: capturePackList });

            expect(await pack()).toBeNull();
            expect(existsSync(listPath())).toBe(false);
        });

        it('ships the output without a storyboard when packing fails', async () => {
            writeThumbs(sourceDir(), 20);
            mockFfmpeg({ failPass: true, onPass: capturePackList });

            expect(await pack()).toBeNull();
            expect(readdirSync(outThumbDir())).not.toContain('thumbnails.vtt');
        });

        it('says nothing was delivered when ffmpeg writes no sheets', async () => {
            writeThumbs(sourceDir(), 20);
            mockFfmpeg({ sprites: 0, onPass: capturePackList });

            expect(await pack()).toBeNull();
            expect(readdirSync(outThumbDir())).not.toContain('thumbnails.vtt');
        });

        it('resamples a cache left by an older version of the encoder', async () => {
            // Individual thumbs are new: a session restored from before them has
            // sprite sheets cached, which cannot be re-laid-out onto a trimmed
            // timeline. A filename check settles it — no VTT parsing.
            mkdirSync(sourceDir(), { recursive: true });
            writeFileSync(join(sourceDir(), 'sprite_001.webp'), 'old-sheet');

            const result = await pack({ sourceDuration: 60 });

            expect(result).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
            expect(passCalls(THUMBS)).toHaveLength(1);
            expect(readdirSync(sourceDir())).not.toContain('sprite_001.webp');
            expect(packed()[0]).toBe('thumb_000001.webp');
        });

        it('samples the deliberately chosen angle when it has to resample', async () => {
            await pack({
                videoTracks: [
                    { index: 0, width: 3840, height: 2160 },
                    { index: 1, width: 640, height: 360 },
                ],
            });

            const args = passArgs(THUMBS);
            expect(args[args.indexOf('-map') + 1]).toBe('0:v:1');
            expect(args[args.indexOf('-vf') + 1]).toBe('fps=1/5,scale=160:90');
        });

        it('has nothing to pack and nothing to sample from', async () => {
            const result = await pack({ videoTracks: [] });

            expect(result).toBeNull();
            // The encoder probe, and not one frame of ffmpeg work.
            expect(passCalls(THUMBS)).toHaveLength(0);
            expect(passCalls(SPRITES)).toHaveLength(0);
        });

        it('has nothing to describe when the output is empty', async () => {
            writeThumbs(sourceDir(), 20);

            expect(await pack({ sourceDuration: 0 })).toBeNull();
            expect(passCalls(SPRITES)).toHaveLength(0);
        });

        it('waits for the ingest pass instead of packing half of it', async () => {
            let finishSampling: (() => void) | null = null;
            mockExecFile.mockImplementation((...call: any[]) => {
                const cb = call[call.length - 1];
                const args = call[1] as string[];
                if (args[0] === '-encoders') {
                    cb(null, { stdout: WEBP_ENCODERS, stderr: '' });
                    return;
                }
                if ((args[args.length - 1] as string).includes(THUMBS)) {
                    finishSampling = () => cb(null, { stdout: '', stderr: '' });
                    return;
                }
                capturePackList(args);
                mkdirSync(outThumbDir(), { recursive: true });
                writeFileSync(
                    join(outThumbDir(), 'sprite_001.webp'),
                    'fake-sheet'
                );
                cb(null, { stdout: '', stderr: '' });
            });

            // The ingest prime is running: it returns immediately with whatever
            // has been written so far, leaving the pass in flight.
            await svc.getOrGeneratePreview(SID, {
                inputPath: '/tmp/source.mkv',
                duration: 60,
                trackIndex: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            await until(
                () => finishSampling !== null,
                'the ingest pass to start'
            );

            const packing = pack({ sourceDuration: 60 });
            await settle();
            await settle();
            expect(passCalls(SPRITES)).toHaveLength(0);

            writeThumbs(sourceDir(), 12);
            finishSampling!();

            expect(await packing).toEqual({
                vttRelativePath: 'thumbnails/thumbnails.vtt',
            });
            // It joined the pass already running rather than starting another.
            expect(passCalls(THUMBS)).toHaveLength(1);
            expect(packed()).toHaveLength(12);
        });

        it('names the thumbs by absolute path, whatever WORK_DIR is', async () => {
            /*
             * The concat demuxer resolves relative entries against the *list
             * file's own directory*, not the process's working directory. WORK_DIR
             * defaults to `./work` when the API runs standalone, so a browser-dev
             * session wrote entries like `work/<id>/preview-thumbnails/…` into a
             * list living at `work/<id>/output/thumbnails/` — ffmpeg looked for
             * the two concatenated and could not open them. It failed as a warning
             * and a session with no sprites, and was invisible under Electron,
             * which passes an absolute workDir.
             *
             * Every other test here sets an absolute WORK_DIR, which is why this
             * survived: the fix is only observable from a relative one.
             */
            const cwd = process.cwd();
            const relRoot = mkdtempSync(join(tmpdir(), 'thumb-relcwd-'));
            process.chdir(relRoot);
            try {
                process.env.WORK_DIR = 'relwork';
                svc = new ThumbnailService();
                packList = [];
                mockExecFile.mockReset();
                mockFfmpeg({ thumbs: 12, sprites: 1, onPass: capturePackList });
                mkdirSync(
                    join(
                        relRoot,
                        'relwork',
                        SID,
                        'preview-thumbnails',
                        'thumbnails'
                    ),
                    {
                        recursive: true,
                    }
                );
                for (let i = 1; i <= 12; i++) {
                    writeFileSync(
                        join(
                            relRoot,
                            'relwork',
                            SID,
                            'preview-thumbnails',
                            'thumbnails',
                            `thumb_${String(i).padStart(6, '0')}.jpg`
                        ),
                        'x'
                    );
                }

                await pack();

                expect(packList.length).toBeGreaterThan(0);
                const paths = packList.map((line) =>
                    line.replace(/^file '(.*)'$/, '$1')
                );
                expect(paths.every((path) => isAbsolute(path))).toBe(true);
            } finally {
                process.chdir(cwd);
                rmSync(relRoot, { recursive: true, force: true });
            }
        });
    });
});
