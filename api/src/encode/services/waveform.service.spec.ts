const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    spawn: (...args: any[]) => mockSpawn(...args),
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    readCachedWaveform,
    resampleEnvelope,
    WaveformService,
    WAVEFORM_SIDECAR_VERSION,
} from './waveform.service.js';

/**
 * A spawn result that hands back some decodable PCM and exits. The bytes are
 * arbitrary non-silence; the command-construction tests only read the argv.
 */
function fakeFfmpeg() {
    const listeners = new Map<string, (...args: any[]) => void>();
    const channel = (key: string) => ({
        on: (event: string, cb: (...args: any[]) => void) => {
            listeners.set(`${key}:${event}`, cb);
        },
    });
    const proc = {
        stdout: channel('stdout'),
        stderr: channel('stderr'),
        on: (event: string, cb: (...args: any[]) => void) => {
            listeners.set(`proc:${event}`, cb);
        },
    };
    setImmediate(() => {
        listeners.get('stdout:data')?.(Buffer.alloc(1600, 0x40));
        listeners.get('proc:close')?.(0);
    });
    return proc;
}

describe('resampleEnvelope', () => {
    it('keeps the loudest value in each span', () => {
        // Averaging here would flatten the transients the outline exists to show.
        const envelope = [0.1, 0.9, 0.2, 0.1, 0.8, 0.1];

        expect(resampleEnvelope(envelope, 3)).toEqual([0.9, 0.2, 0.8]);
    });

    it('returns exactly the number of peaks asked for', () => {
        const envelope = Array.from(
            { length: 36_000 },
            (_, i) => (i % 100) / 100
        );

        expect(resampleEnvelope(envelope, 1000)).toHaveLength(1000);
    });

    it('leaves a short envelope alone rather than inventing detail', () => {
        // Stretching 3 samples across 1000 peaks would draw structure that was
        // never in the audio.
        expect(resampleEnvelope([0.2, 0.4, 0.6], 1000)).toEqual([
            0.2, 0.4, 0.6,
        ]);
    });

    it('covers the whole envelope, including the tail', () => {
        // A span calculation that rounds the last bucket short drops the end of
        // the waveform, which reads as silence that is not there.
        const envelope = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

        expect(resampleEnvelope(envelope, 5).at(-1)).toBe(1);
    });

    it('never returns an empty span', () => {
        // More peaks than entries: every peak still has to come from somewhere.
        const peaks = resampleEnvelope([0.5, 0.7], 2);

        expect(peaks).toEqual([0.5, 0.7]);
    });

    it('has nothing to draw for silence-free edge cases', () => {
        expect(resampleEnvelope([], 1000)).toEqual([]);
        expect(resampleEnvelope([0.5], 0)).toEqual([]);
    });
});

describe('generateWaveform — command construction', () => {
    let dir: string;
    let source: string;
    let concat: string;
    let service: WaveformService;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'luminary-waveform-'));
        source = join(dir, 'input.mp4');
        concat = join(dir, 'concat.txt');
        writeFileSync(source, 'not-really-media');
        writeFileSync(concat, 'ffconcat version 1.0\n');
        mockSpawn.mockReset();
        mockSpawn.mockImplementation(() => fakeFfmpeg());
        service = new WaveformService();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const argv = (): string[] => mockSpawn.mock.calls[0][1] as string[];
    const audioFilter = (): string => {
        const args = argv();
        return args[args.indexOf('-af') + 1];
    };

    it('decodes a direct input in the container clock: no -copyts, no seek', async () => {
        await service.generateWaveform({ inputPath: source });

        expect(argv()).toContain('-i');
        expect(argv()).not.toContain('-copyts');
        expect(argv()).not.toContain('-ss');
        // first_pts=0 is what puts timeline zero at peak 0 — silence-fill the
        // head up to the first real sample instead of drawing it at the origin.
        expect(audioFilter()).toBe(
            'aresample=8000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=mono'
        );
    });

    it('pads the tail to the timeline when a duration is given', async () => {
        await service.generateWaveform({
            inputPath: source,
            durationSec: 120,
        });

        expect(audioFilter().endsWith(',apad=whole_dur=120')).toBe(true);
    });

    it('omits apad for a zero or missing duration', async () => {
        await service.generateWaveform({ inputPath: source, durationSec: 0 });

        expect(audioFilter()).not.toContain('apad');
    });

    it('seeks past the alignment head on a direct input', async () => {
        await service.generateWaveform({
            inputPath: source,
            startOffsetSec: 1.06,
        });

        const args = argv();
        const ss = args.indexOf('-ss');
        expect(ss).toBeGreaterThan(-1);
        expect(args[ss + 1]).toBe('1.06');
        expect(ss).toBeLessThan(args.indexOf('-i'));
    });

    it('does not emit a seek for a zero offset', async () => {
        await service.generateWaveform({
            inputPath: source,
            startOffsetSec: 0,
        });

        expect(argv()).not.toContain('-ss');
    });

    it('gives a concat input the trim trio and refuses the offset', async () => {
        await service.generateWaveform({
            inputPath: source,
            concatFilePath: concat,
            startOffsetSec: 5,
            durationSec: 30,
        });

        const args = argv();
        const i = args.indexOf('-f');
        // -copyts stays on the concat branch (the stitched clock the window
        // metadata refers to); the offset is already inside the in-points, so
        // seeking again would cut a second head off the first kept range.
        expect(args.slice(i, i + 9)).toEqual([
            '-f',
            'concat',
            '-safe',
            '0',
            '-segment_time_metadata',
            '1',
            '-i',
            concat,
            '-copyts',
        ]);
        expect(args).not.toContain('-ss');
        expect(
            audioFilter().startsWith('aselect=concatdec_select,aresample=')
        ).toBe(true);
    });

    it('turns the decoded samples into peaks', async () => {
        const peaks = await service.generateWaveform({ inputPath: source });

        expect(peaks.length).toBeGreaterThan(0);
        expect(Math.max(...peaks)).toBeGreaterThan(0);
    });
});

describe('getOrComputeCached — sidecar versioning', () => {
    let workDir: string;
    let sourceDir: string;
    let source: string;
    let service: WaveformService;

    const sidecarFor = (service: WaveformService, id: string) =>
        service.cachePath(id);

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'luminary-waveform-work-'));
        sourceDir = mkdtempSync(join(tmpdir(), 'luminary-waveform-src-'));
        source = join(sourceDir, 'input.mp4');
        writeFileSync(source, 'not-really-media');
        process.env.WORK_DIR = workDir;
        mockSpawn.mockReset();
        mockSpawn.mockImplementation(() => fakeFfmpeg());
        // The service captures WORK_DIR at construction.
        service = new WaveformService();
    });

    afterEach(() => {
        delete process.env.WORK_DIR;
        rmSync(workDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
    });

    it('returns a current-version cache without decoding again', async () => {
        const cached = {
            version: WAVEFORM_SIDECAR_VERSION,
            sampleRate: 8000,
            numPeaks: 2,
            peaks: [0.5, 0.25],
        };
        mkdirSync(join(workDir, 's1'), { recursive: true });
        writeFileSync(sidecarFor(service, 's1'), JSON.stringify(cached));

        const result = await service.getOrComputeCached('s1', {
            inputPath: source,
        });

        expect(result).toEqual(cached);
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('recomputes over a version-1 cache and writes the current version', async () => {
        mkdirSync(join(workDir, 's2'), { recursive: true });
        writeFileSync(
            sidecarFor(service, 's2'),
            JSON.stringify({
                version: 1,
                sampleRate: 8000,
                numPeaks: 1,
                peaks: [0.9],
            })
        );

        const result = await service.getOrComputeCached('s2', {
            inputPath: source,
        });

        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(result.version).toBe(WAVEFORM_SIDECAR_VERSION);
        const onDisk = JSON.parse(
            await readFile(sidecarFor(service, 's2'), 'utf-8')
        );
        expect(onDisk.version).toBe(WAVEFORM_SIDECAR_VERSION);
    });
});

describe('readCachedWaveform', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'luminary-waveform-read-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('is null for a missing file', async () => {
        expect(await readCachedWaveform(join(dir, 'none.json'))).toBeNull();
    });

    it('is null for a stale version', async () => {
        const path = join(dir, 'v1.json');
        writeFileSync(
            path,
            JSON.stringify({ version: 1, peaks: [0.1], numPeaks: 1 })
        );
        expect(await readCachedWaveform(path)).toBeNull();
    });

    it('is null for a body with no peaks', async () => {
        const path = join(dir, 'nopeaks.json');
        writeFileSync(
            path,
            JSON.stringify({ version: WAVEFORM_SIDECAR_VERSION })
        );
        expect(await readCachedWaveform(path)).toBeNull();
    });

    it('is null for a body that is not JSON', async () => {
        const path = join(dir, 'garbage.json');
        writeFileSync(path, 'not json');
        expect(await readCachedWaveform(path)).toBeNull();
    });

    it('returns a current-version sidecar', async () => {
        const path = join(dir, 'v2.json');
        const sidecar = {
            version: WAVEFORM_SIDECAR_VERSION,
            sampleRate: 8000,
            numPeaks: 1,
            peaks: [0.4],
        };
        writeFileSync(path, JSON.stringify(sidecar));
        expect(await readCachedWaveform(path)).toEqual(sidecar);
    });
});
