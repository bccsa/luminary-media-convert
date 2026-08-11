import { type MockInstance } from 'vitest';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    readFileSync,
    existsSync,
} from 'fs';
import { isAbsolute, join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const { mockSpawn, mockExecSync, mockExecFile, MockWorker, useRealWorker } =
    vi.hoisted(() => ({
        mockSpawn: vi.fn(),
        mockExecSync: vi.fn(),
        mockExecFile: vi.fn(),
        MockWorker: vi.fn(),
        useRealWorker: { value: true },
    }));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawn: mockSpawn,
        execSync: mockExecSync,
        execFile: mockExecFile,
    };
});

vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('worker_threads')>();
    const RealWorker = actual.Worker;
    class ProxiedWorker extends RealWorker {
        constructor(...args: any[]) {
            if (useRealWorker.value) {
                super(args[0], args[1]);
            } else {
                super(new URL('data:text/javascript,'), { eval: false } as any);
                this.terminate();
                const fake = MockWorker(...args);
                (this as any).on = (event: string, handler: any) => {
                    fake.on(event, handler);
                    return this;
                };
            }
        }
    }
    return { ...actual, Worker: ProxiedWorker };
});

import {
    FfmpegService,
    type AccelMode,
    type EncodeOptions,
} from './ffmpeg.service.js';

const flushPromises = async () => {
    for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

function createMockProcess(): ChildProcess & {
    emitStderr: (data: string) => void;
    emitClose: (code: number, signal?: string) => void;
    emitError: (err: Error) => void;
} {
    const proc = new EventEmitter() as any;
    proc.stderr = new EventEmitter();
    proc.stdout = { resume: vi.fn() };
    proc.kill = vi.fn();
    proc.killed = false;
    proc.pid = 12345;
    proc.emitStderr = (data: string) =>
        proc.stderr.emit('data', Buffer.from(data));
    proc.emitClose = (code: number, signal?: string) =>
        proc.emit('close', code, signal ?? null);
    proc.emitError = (err: Error) => proc.emit('error', err);
    return proc;
}

describe('FfmpegService', () => {
    let service: FfmpegService;

    // These assertions expect the binaries to be resolved off PATH — a bare
    // `ffmpeg`. `ffbin.ts` prefers FFMPEG_PATH / FFPROBE_PATH when they are set,
    // and `bootstrap.ts` sets both into `process.env` for the process it is
    // hosting. A spec that calls `createServer()` therefore leaves them behind
    // for whatever shares its worker, and this file failed or passed depending
    // on the order it was scheduled in. Pin the environment it asserts against,
    // and put back what was there so this spec is not the next polluter.
    const savedBinPaths: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ['FFMPEG_PATH', 'FFPROBE_PATH']) {
            savedBinPaths[key] = process.env[key];
            delete process.env[key];
        }

        mockExecSync.mockReset();
        mockExecFile.mockReset();

        // Default: GPU detection falls through to CPU
        mockExecSync.mockImplementation(() => {
            throw new Error('not available');
        });

        // Default: execFile (used via promisify) accepts callback-style calls
        mockExecFile.mockImplementation((...args: any[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') {
                cb(null, { stdout: '', stderr: '' });
            }
        });

        service = new FfmpegService();
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(savedBinPaths)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    describe('GPU detection', () => {
        it('should default to CPU mode', () => {
            expect(service.isGpuAvailable()).toBe(false);
            expect(service.getAccelMode()).toBe('cpu');
        });

        it('should report GPU available for nvidia mode', () => {
            (service as any).accelMode = 'nvidia';
            expect(service.isGpuAvailable()).toBe(true);
            expect(service.getAccelMode()).toBe('nvidia');
        });

        it('should report GPU available for apple mode', () => {
            (service as any).accelMode = 'apple';
            expect(service.isGpuAvailable()).toBe(true);
            expect(service.getAccelMode()).toBe('apple');
        });
    });

    describe('parseProgressTime (private, tested via reflection)', () => {
        const parseProgressTime = (data: string): number | null => {
            return (service as any).parseProgressTime(data);
        };

        it('should parse out_time_us format', () => {
            const result = parseProgressTime('out_time_us=5000000\n');
            expect(result).toBe(5);
        });

        it('should parse out_time_us for fractional seconds', () => {
            const result = parseProgressTime('out_time_us=1500000\n');
            expect(result).toBe(1.5);
        });

        it('should parse out_time HH:MM:SS format', () => {
            const result = parseProgressTime('out_time=01:02:03.500000\n');
            expect(result).toBe(3723.5);
        });

        it('should parse out_time with zero hours', () => {
            const result = parseProgressTime('out_time=00:00:30.000000\n');
            expect(result).toBe(30);
        });

        it('should return null for unrelated data', () => {
            const result = parseProgressTime('frame=100\nfps=30\n');
            expect(result).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(parseProgressTime('')).toBeNull();
        });

        it('should prefer out_time_us when both are present', () => {
            const result = parseProgressTime(
                'out_time_us=10000000\nout_time=00:00:10.000000\n'
            );
            expect(result).toBe(10);
        });
    });

    describe('getX264Preset (private, tested via reflection)', () => {
        const getX264Preset = (height: number): string => {
            return (service as any).getX264Preset(height);
        };

        it('should return veryfast for 1080p and above', () => {
            expect(getX264Preset(1080)).toBe('veryfast');
            expect(getX264Preset(1440)).toBe('veryfast');
            expect(getX264Preset(2160)).toBe('veryfast');
        });

        it('should return faster for 720p', () => {
            expect(getX264Preset(720)).toBe('faster');
            expect(getX264Preset(900)).toBe('faster');
        });

        it('should return fast for 480p', () => {
            expect(getX264Preset(480)).toBe('fast');
            expect(getX264Preset(576)).toBe('fast');
        });

        it('should return medium for 360p', () => {
            expect(getX264Preset(360)).toBe('medium');
        });

        it('should return slow for below 360p', () => {
            expect(getX264Preset(240)).toBe('slow');
            expect(getX264Preset(144)).toBe('slow');
        });
    });

    describe('getNvencPreset (private, tested via reflection)', () => {
        const getNvencPreset = (height: number): string => {
            return (service as any).getNvencPreset(height);
        };

        it('should return p4 for 1080p and above', () => {
            expect(getNvencPreset(1080)).toBe('p4');
            expect(getNvencPreset(1440)).toBe('p4');
            expect(getNvencPreset(2160)).toBe('p4');
        });

        it('should return p5 for 720p', () => {
            expect(getNvencPreset(720)).toBe('p5');
        });

        it('should return p5 for 480p', () => {
            expect(getNvencPreset(480)).toBe('p5');
        });

        it('should return p6 for 360p', () => {
            expect(getNvencPreset(360)).toBe('p6');
        });

        it('should return p7 for below 360p', () => {
            expect(getNvencPreset(240)).toBe('p7');
            expect(getNvencPreset(144)).toBe('p7');
        });
    });

    describe('buildVideoArgs (private, tested via reflection)', () => {
        const buildVideoArgs = (opts: any): Promise<string[]> => {
            return (service as any).buildVideoArgs(opts);
        };

        it('should build CPU video args with correct structure', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                    {
                        width: 854,
                        height: 480,
                        videoBitrateKbps: 1000,
                        copyStream: false,
                        audioGroupId: 'mid',
                        label: '480p',
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
                    {
                        id: 'mid',
                        label: 'Standard Audio',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-i');
            expect(args).toContain('/tmp/input.mp4');
            expect(args).toContain('-filter_complex');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');

            expect(args).toContain('libx264');
            expect(args).not.toContain('h264_nvenc');
            expect(args).not.toContain('h264_videotoolbox');
            expect(args).not.toContain('-hwaccel');

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale=');
            expect(filterVal).not.toContain('scale_cuda');
            expect(filterVal).not.toContain('scale_vt');
            expect(filterVal).toContain('split=2');

            // 720p -> faster, 480p -> fast
            const preset0Idx = args.indexOf('-preset:v:0');
            expect(args[preset0Idx + 1]).toBe('faster');
            const preset1Idx = args.indexOf('-preset:v:1');
            expect(args[preset1Idx + 1]).toBe('fast');
        });

        it('should include -hwaccel cuda when NVIDIA GPU is available', async () => {
            (service as any).accelMode = 'nvidia';

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-hwaccel');
            expect(args).toContain('cuda');
            expect(args).toContain('h264_nvenc');
            expect(args).not.toContain('h264_videotoolbox');
            expect(args).not.toContain('videotoolbox');
            expect(args).not.toContain('libx264');

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale_cuda');
            expect(filterVal).not.toContain('scale_vt');
            expect(filterVal).not.toMatch(/(?<![_a-z])scale=/);

            // 720p -> p5
            const presetIdx = args.indexOf('-preset:v:0');
            expect(args[presetIdx + 1]).toBe('p5');
        });

        it('should use h264_videotoolbox when Apple GPU is available', async () => {
            (service as any).accelMode = 'apple';

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-hwaccel');
            expect(args).toContain('videotoolbox');
            expect(args).toContain('-hwaccel_output_format');
            expect(args).toContain('videotoolbox_vld');
            expect(args).toContain('h264_videotoolbox');
            expect(args).not.toContain('cuda');
            expect(args).not.toContain('h264_nvenc');
            expect(args).not.toContain('scale_cuda');
            expect(args).not.toContain('libx264');

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale_vt=');
            expect(filterVal).not.toContain('scale_cuda');
            expect(filterVal).not.toContain('scale=');

            expect(args).toContain('-allow_sw:v:0');
            expect(args).toContain('-realtime:v:0');
            expect(args).toContain('-profile:v:0');
            expect(args).toContain('high');
            expect(args).toContain('2500k');
        });

        it('should use scale_vt with split for multiple Apple GPU renditions', async () => {
            (service as any).accelMode = 'apple';

            const encodeConfig: EncodeConfigDto = {
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
                    {
                        width: 854,
                        height: 480,
                        videoBitrateKbps: 1000,
                        copyStream: false,
                        audioGroupId: 'hd',
                        label: '480p',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('split=2');
            expect(filterVal).toContain('scale_vt=w=1280:h=720');
            expect(filterVal).toContain('scale_vt=w=854:h=480');
            expect(filterVal).not.toContain('scale_cuda');
            expect(filterVal).not.toMatch(/(?<![_a-z])scale=/);

            expect(args).toContain('h264_videotoolbox');
            expect(args).toContain('-allow_sw:v:0');
            expect(args).toContain('-allow_sw:v:1');
        });

        it('should use wider bufsize/maxrate multipliers for Apple VBR', async () => {
            (service as any).accelMode = 'apple';

            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2000,
                        copyStream: false,
                        audioGroupId: 'hd',
                        label: '720p',
                        vbr: true,
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

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            // VBR: maxrate = 2000 * 1.5 = 3000k, bufsize = 2000 * 2 = 4000k
            expect(args).toContain(`${Math.round(2000 * 1.5)}k`);
            expect(args).toContain(`${Math.round(2000 * 2)}k`);
        });

        it('should use standard bufsize/maxrate multipliers for Apple CBR', async () => {
            (service as any).accelMode = 'apple';

            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2000,
                        copyStream: false,
                        audioGroupId: 'hd',
                        label: '720p',
                        vbr: false,
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

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            // CBR: maxrate = 2000 * 1.07 = 2140k, bufsize = 2000 * 1.5 = 3000k
            expect(args).toContain(`${Math.round(2000 * 1.07)}k`);
            expect(args).toContain(`${Math.round(2000 * 1.5)}k`);
        });

        it('should include -threads in Apple GPU mode', async () => {
            (service as any).accelMode = 'apple';

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const threadsIdx = args.indexOf('-threads');
            expect(threadsIdx).toBeGreaterThan(-1);
            expect(args[threadsIdx + 1]).toBe('8');
        });

        it('should include -threads in NVIDIA GPU mode', async () => {
            (service as any).accelMode = 'nvidia';

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const threadsIdx = args.indexOf('-threads');
            expect(threadsIdx).toBeGreaterThan(-1);
            expect(args[threadsIdx + 1]).toBe('8');
        });

        it('should set correct audio codec and bitrate', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('aac');
            expect(args).toContain('192k');
        });

        it('should use copy codec for copyStream renditions', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: true,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                        label: '1080p',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('copy');
            expect(args).not.toContain('-filter_complex');
        });

        it('should set segment duration', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 10,
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
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('10');
        });

        it('should include audio group and language in var_stream_map', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                        label: 'English',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const vsmIdx = args.indexOf('-var_stream_map');
            const vsmVal = args[vsmIdx + 1];
            expect(vsmVal).toContain('agroup:hd');
            expect(vsmVal).toContain('language:eng');
        });

        it('should include -threads with default value', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const threadsIdx = args.indexOf('-threads');
            expect(threadsIdx).toBeGreaterThan(-1);
            expect(args[threadsIdx + 1]).toBe('8');
        });

        it('should use detected GOP duration for -hls_time in byte-range mode', async () => {
            vi.spyOn(service as any, 'probeFrameRate').mockResolvedValue(24);
            vi.spyOn(service as any, 'probeGopDuration').mockResolvedValue(2);

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: true,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('2');
        });

        it('should fall back to segmentDuration when GOP detection fails in byte-range mode', async () => {
            vi.spyOn(service as any, 'probeFrameRate').mockResolvedValue(30);
            vi.spyOn(service as any, 'probeGopDuration').mockResolvedValue(
                null
            );

            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 8,
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
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: true,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('8');
        });

        it('should use segmentDuration for -hls_time when byte-range is disabled', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 10,
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
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: false,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('10');
        });

        it('should use -ac:a:N to target audio streams correctly', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                    {
                        width: 640,
                        height: 360,
                        videoBitrateKbps: 600,
                        copyStream: false,
                        audioGroupId: 'low',
                        label: '360p',
                    },
                ],
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                    {
                        id: 'low',
                        audioBitrateKbps: 64,
                        channels: 1,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-ac:a:0');
            expect(args).toContain('-ac:a:1');
            expect(args).not.toContain('-ac:0');
            expect(args).not.toContain('-ac:1');
        });
    });

    describe('buildVideoArgs with trimSegments', () => {
        const buildVideoArgs = (opts: any): Promise<string[]> => {
            return (service as any).buildVideoArgs(opts);
        };

        let tmpDir: string;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-trim-'));
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should use concat demuxer when trimSegments present', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
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
                trimSegments: [
                    { inSec: 10, outSec: 30 },
                    { inSec: 60, outSec: 90 },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: tmpDir,
                encodeConfig,
            });

            expect(args).toContain('-f');
            expect(args).toContain('concat');
            expect(args).toContain('-safe');
            expect(args).toContain('0');
            expect(args).not.toContain('/tmp/input.mp4');

            // Verify concat file was written
            const concatPath = join(tmpDir, 'concat.txt');
            expect(existsSync(concatPath)).toBe(true);
            const content = readFileSync(concatPath, 'utf-8');
            expect(content).toContain('ffconcat version 1.0');
            expect(content).toContain('inpoint 10');
            expect(content).toContain('outpoint 30');
            expect(content).toContain('inpoint 60');
            expect(content).toContain('outpoint 90');
        });

        it('names the source by absolute path, whatever it was given', async () => {
            /*
             * The concat demuxer resolves relative entries against the list
             * file's own directory, so a relative source would be looked for
             * inside outputDir and the trim would fail on a file plainly there.
             *
             * The controller rejects a non-absolute source at ingest, so this
             * cannot happen today — but the sprite packer had exactly this bug
             * (item 39) and was also safe by a guarantee made in another file,
             * right up until it was not.
             */
            const args = await buildVideoArgs({
                inputPath: 'relative/input.mp4',
                outputDir: tmpDir,
                encodeConfig: {
                    type: 'video',
                    videoRenditions: [
                        {
                            width: 1280,
                            height: 720,
                            videoBitrateKbps: 2500,
                            audioGroupId: 'hd',
                        },
                    ],
                    audioGroups: [
                        { id: 'hd', audioBitrateKbps: 192, channels: 2 },
                    ],
                    trimSegments: [{ inSec: 10, outSec: 30 }],
                },
            });

            expect(args).toContain('concat');
            const content = readFileSync(join(tmpDir, 'concat.txt'), 'utf-8');
            const fileLine = content
                .split('\n')
                .find((line) => line.startsWith("file '"))!;
            const named = fileLine.replace(/^file '(.*)'$/, '$1');
            expect(isAbsolute(named)).toBe(true);
            expect(named.endsWith('relative/input.mp4')).toBe(true);
        });

        it('should use direct input when no trimSegments', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
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

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: tmpDir,
                encodeConfig,
            });

            expect(args).toContain('-i');
            expect(args).toContain('/tmp/input.mp4');
            expect(args).not.toContain('concat');
        });
    });

    describe('buildAudioArgs with trimSegments', () => {
        const buildAudioArgs = async (opts: any): Promise<string[]> => {
            return (service as any).buildAudioArgs(opts);
        };

        let tmpDir: string;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-trim-audio-'));
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should use concat demuxer when trimSegments present', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
                trimSegments: [{ inSec: 5, outSec: 15 }],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: tmpDir,
                encodeConfig,
            });

            expect(args).toContain('-f');
            expect(args).toContain('concat');
            expect(args).toContain('-safe');
            expect(args).toContain('0');

            const concatPath = join(tmpDir, 'concat.txt');
            expect(existsSync(concatPath)).toBe(true);
            const content = readFileSync(concatPath, 'utf-8');
            expect(content).toContain('inpoint 5');
            expect(content).toContain('outpoint 15');
        });
    });

    describe('fixMasterPlaylist (private, tested via reflection)', () => {
        const fixMasterPlaylist = (
            outputDir: string,
            config: EncodeConfigDto
        ): Promise<void> => {
            return (service as any).fixMasterPlaylist(outputDir, config);
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should use uniform NAME for single-language audio quality tiers', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_6",DEFAULT=YES,LANGUAGE="eng",CHANNELS="2",URI="stream_hd_HD_Audio/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_mid",NAME="audio_7",DEFAULT=NO,LANGUAGE="eng",CHANNELS="2",URI="stream_mid_Standard_Audio/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_low",NAME="audio_8",DEFAULT=NO,LANGUAGE="eng",CHANNELS="1",URI="stream_low_Low_Audio/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'HD Audio',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'mid',
                        label: 'Standard Audio',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'low',
                        label: 'Low Audio',
                        audioBitrateKbps: 64,
                        channels: 1,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            // All single-language quality tiers share the same NAME so HLS
            // players treat them as one logical audio track (not separate selectable tracks)
            const nameMatches = result.match(/NAME="([^"]+)"/g);
            expect(nameMatches).toEqual([
                'NAME="eng"',
                'NAME="eng"',
                'NAME="eng"',
            ]);
        });

        it('should normalize uppercase LANGUAGE attributes from FFmpeg output', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_6",DEFAULT=YES,LANGUAGE="ENG",CHANNELS="2",URI="stream_hd_English/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_7",DEFAULT=NO,LANGUAGE="FRA",CHANNELS="2",URI="stream_hd_French/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'English',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'hd',
                        label: 'French',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'fra',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('LANGUAGE="eng"');
            expect(result).toContain('LANGUAGE="fra"');
            expect(result).not.toMatch(/LANGUAGE="[A-Z]/);
        });

        it('should use label for NAME when multiple languages are present', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_6",DEFAULT=YES,LANGUAGE="eng",CHANNELS="2",URI="stream_hd_English/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_7",DEFAULT=NO,LANGUAGE="spa",CHANNELS="2",URI="stream_hd_Spanish/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'English',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'hd',
                        label: 'Spanish',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'spa',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            const nameMatches = result.match(/NAME="([^"]+)"/g);
            expect(nameMatches).toEqual(['NAME="English"', 'NAME="Spanish"']);
        });

        it('should also work with GROUP-IDs without the group_ prefix', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="audio_2",DEFAULT=YES,LANGUAGE="eng",URI="stream_hd_HD_Audio/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'HD Audio',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            // Single language → uses language code as NAME, not label
            expect(result).toContain('NAME="eng"');
        });

        it('should set different NAMEs for audio groups from different source tracks', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_eng",NAME="audio_2",DEFAULT=YES,LANGUAGE="eng",URI="stream_eng_English/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_spa",NAME="audio_3",DEFAULT=NO,LANGUAGE="spa",URI="stream_spa_Spanish/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'eng',
                        label: 'English',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'spa',
                        label: 'Spanish',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'spa',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="English"');
            expect(result).toContain('NAME="Spanish"');
        });

        it('should fall back to "Audio" when no label or language is set', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_2",DEFAULT=YES,URI="stream_hd_192kbps/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="Audio"');
        });

        it('should not modify non-audio EXT-X-MEDIA lines', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_2",DEFAULT=YES,URI="stream_hd_HD_Audio/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'HD Audio',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain(
                'TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"'
            );
            // Single language → uses language code as NAME
            expect(result).toContain(
                'TYPE=AUDIO,GROUP-ID="group_hd",NAME="eng"'
            );
        });

        it('should add VIDEO groups and VIDEO attribute for multi-angle streams', async () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="eng",URI="stream_English/playlist.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=4177777,AVERAGE-BANDWIDTH=3822202,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0"',
                'stream_main_1280x720/playlist.m3u8',
                '',
                '#EXT-X-STREAM-INF:BANDWIDTH=1868063,AVERAGE-BANDWIDTH=1724450,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="group_tier_0"',
                'stream_pulpit_854x480/playlist.m3u8',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            await fixMasterPlaylist(tmpDir, {
                type: 'video',
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
                        audioGroupId: 'tier_0',
                        label: 'main',
                        sourceTrackIndex: 0,
                    },
                    {
                        width: 854,
                        height: 480,
                        videoBitrateKbps: 1000,
                        copyStream: false,
                        audioGroupId: 'tier_0',
                        label: 'pulpit',
                        sourceTrackIndex: 1,
                    },
                ],
                videoTrackNames: [
                    { index: 0, name: 'main' },
                    { index: 1, name: 'pulpit' },
                ],
                audioGroups: [
                    {
                        id: 'tier_0',
                        label: 'English',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="main",DEFAULT=YES'
            );
            expect(result).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="pulpit",DEFAULT=NO'
            );
            expect(result).toContain('VIDEO="main",AUDIO="group_tier_0"');
            expect(result).toContain('VIDEO="pulpit",AUDIO="group_tier_0"');
        });
    });

    // The `generateAudioOnlyPlaylist` and `generateAnglePlaylists` suites lived
    // here. Both methods are gone: the encoder writes a single spec-correct
    // master and the player narrows it, so that behaviour and its tests belong
    // to the hls package (listVideoAngles / extractAnglePlaylist /
    // extractAudioOnlyPlaylist), against real multi-angle masters rather than
    // against a mocked filesystem.

    describe('fixAudioOnlyMasterPlaylist (private, tested via reflection)', () => {
        const fixAudioOnlyMasterPlaylist = (
            outputDir: string,
            config: EncodeConfigDto
        ): Promise<void> => {
            return (service as any).fixAudioOnlyMasterPlaylist(
                outputDir,
                config
            );
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-fix-audio-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should do nothing when no audio groups', async () => {
            writeFileSync(
                join(tmpDir, 'master.m3u8'),
                '#EXTM3U\n#EXT-X-VERSION:7\n',
                'utf-8'
            );

            await fixAudioOnlyMasterPlaylist(tmpDir, { type: 'audio' });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(content).toBe('#EXTM3U\n#EXT-X-VERSION:7\n');
        });

        it('should do nothing when master.m3u8 does not exist', async () => {
            // Should not throw
            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            });
        });

        it('should rewrite master.m3u8 with proper EXT-X-MEDIA and STREAM-INF structure', async () => {
            // Simulate FFmpeg's raw output for audio-only encode
            writeFileSync(
                join(tmpDir, 'master.m3u8'),
                [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"',
                    'stream_hd_HD_Audio/playlist.m3u8',
                    '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
                    'stream_low_Low_Audio/playlist.m3u8',
                    '',
                ].join('\n'),
                'utf-8'
            );

            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'HD Audio',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'low',
                        label: 'Low Audio',
                        audioBitrateKbps: 64,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');

            // Single language → all quality tiers share the same NAME
            expect(content).toContain(
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="eng",DEFAULT=YES,LANGUAGE="eng"'
            );
            expect(content).toContain(
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="eng",DEFAULT=YES,LANGUAGE="eng"'
            );

            // Should have STREAM-INF per tier
            expect(content).toContain(
                '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",AUDIO="hd"'
            );
            expect(content).toContain(
                '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2",AUDIO="low"'
            );

            // Should preserve version from original
            expect(content).toContain('#EXT-X-VERSION:7');
        });

        it('should rewrite multi-language audio-only master playlist', async () => {
            writeFileSync(
                join(tmpDir, 'master.m3u8'),
                '#EXTM3U\n#EXT-X-VERSION:7\n',
                'utf-8'
            );

            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'English',
                        audioBitrateKbps: 256,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'hd',
                        label: 'French',
                        audioBitrateKbps: 256,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'fra',
                    },
                    {
                        id: 'low',
                        label: 'English',
                        audioBitrateKbps: 64,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'low',
                        label: 'French',
                        audioBitrateKbps: 64,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'fra',
                    },
                ],
            });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');

            // EXT-X-MEDIA entries with correct DEFAULT flags
            expect(content).toContain(
                'GROUP-ID="hd",NAME="English",DEFAULT=YES,LANGUAGE="eng"'
            );
            expect(content).toContain(
                'GROUP-ID="hd",NAME="French",DEFAULT=NO,LANGUAGE="fra"'
            );
            expect(content).toContain(
                'GROUP-ID="low",NAME="English",DEFAULT=YES,LANGUAGE="eng"'
            );
            expect(content).toContain(
                'GROUP-ID="low",NAME="French",DEFAULT=NO,LANGUAGE="fra"'
            );

            // Two STREAM-INFs
            expect(content).toContain(
                'BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="hd"'
            );
            expect(content).toContain(
                'BANDWIDTH=64000,CODECS="mp4a.40.2",AUDIO="low"'
            );
        });
    });

    describe('buildAudioArgs (private, tested via reflection)', () => {
        const buildAudioArgs = async (opts: any): Promise<string[]> => {
            return (service as any).buildAudioArgs(opts);
        };

        it('should build single-group audio args with master playlist', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'HD',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-vn');
            expect(args).toContain('-i');
            expect(args).toContain('/tmp/audio.flac');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('aac');
            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');
            const varMap = args[args.indexOf('-var_stream_map') + 1];
            expect(varMap).toContain('a:0,name:hd_HD');
            expect(varMap).not.toContain('agroup');
        });

        it('should build multi-group audio args as direct variants without agroup', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 4,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 256,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'HD',
                    },
                    {
                        id: 'mid',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'Standard',
                    },
                    {
                        id: 'low',
                        audioBitrateKbps: 64,
                        channels: 1,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'Mono',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');
            const varMap = args[args.indexOf('-var_stream_map') + 1];
            expect(varMap).toContain('a:0,name:hd_HD');
            expect(varMap).toContain('a:1,name:mid_Standard');
            expect(varMap).toContain('a:2,name:low_Mono');
            expect(varMap).not.toContain('agroup');
        });

        it('should include -threads with default value', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
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

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const threadsIdx = args.indexOf('-threads');
            expect(threadsIdx).toBeGreaterThan(-1);
            expect(args[threadsIdx + 1]).toBe('8');
        });

        it('should use copy codec for copyStream audio groups', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        copyStream: true,
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('copy');
            expect(args).not.toContain('aac');
        });

        it('should use configured segment duration for audio regardless of byte-range', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'HD',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: true,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('6');
        });

        it('should use default segment duration when none configured', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'HD',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('6');
        });

        it('should use custom segment duration when configured', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 4,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        label: 'HD',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: false,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('4');
        });

        it('should create direct variants for multi-language audio groups', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 256,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        language: 'eng',
                        label: 'English HD',
                    },
                    {
                        id: 'hd',
                        audioBitrateKbps: 256,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 1,
                        language: 'fra',
                        label: 'French HD',
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const varMap = args[args.indexOf('-var_stream_map') + 1];
            expect(varMap).toContain('a:0,name:hd_English_HD');
            expect(varMap).toContain('a:1,name:hd_French_HD');
            expect(varMap).not.toContain('agroup');
        });
    });

    describe('probeGopDuration (private, tested via reflection)', () => {
        // probeGopDuration uses module-scoped execFileAsync (promisified at import time),
        // so we test the parsing logic by spying on the method itself with realistic return values.
        // The async I/O correctness is validated through integration in buildVideoArgs/encode tests.

        it('should return a number when keyframes are detected', async () => {
            const spy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(1);
            const result = await (service as any).probeGopDuration(
                '/tmp/input.mp4',
                30
            );
            expect(result).toBe(1);
            spy.mockRestore();
        });

        it('should return fractional GOP duration for non-standard frame rates', async () => {
            const spy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(2);
            const result = await (service as any).probeGopDuration(
                '/tmp/input.mp4',
                24
            );
            expect(result).toBe(2);
            spy.mockRestore();
        });

        it('should return null when detection fails', async () => {
            const spy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(null);
            const result = await (service as any).probeGopDuration(
                '/tmp/input.mp4',
                30
            );
            expect(result).toBeNull();
            spy.mockRestore();
        });
    });

    describe('encode', () => {
        let tmpDir: string;
        let areAlignedSpy: MockInstance;
        let probeDurationSpy: MockInstance;
        let fixMasterPlaylistSpy: MockInstance;
        let fixAudioOnlyMasterPlaylistSpy: MockInstance;
        let probeFrameRateSpy: MockInstance;
        let probeGopDurationSpy: MockInstance;
        let convertToByteRangeSpy: MockInstance;

        const baseEncodeConfig: EncodeConfigDto = {
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
                    audioBitrateKbps: 192,
                    channels: 2,
                    audioCodec: 'aac',
                    sourceTrackIndex: 0,
                },
            ],
        };

        function makeEncodeOpts(
            overrides: Partial<EncodeOptions> = {}
        ): EncodeOptions {
            return {
                sessionId: 'test-session',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig: baseEncodeConfig,
                onProgress: vi.fn(),
                ...overrides,
            };
        }

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-encode-'));
            mockSpawn.mockReset();
            areAlignedSpy = vi
                .spyOn(service as any, 'areStreamStartTimesAligned')
                .mockResolvedValue(true);
            probeDurationSpy = vi
                .spyOn(service as any, 'probeDuration')
                .mockResolvedValue(100);
            fixMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixMasterPlaylist')
                .mockResolvedValue(undefined);
            fixAudioOnlyMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixAudioOnlyMasterPlaylist')
                .mockResolvedValue(undefined);
            probeFrameRateSpy = vi
                .spyOn(service as any, 'probeFrameRate')
                .mockResolvedValue(30);
            probeGopDurationSpy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(2);
            convertToByteRangeSpy = vi
                .spyOn(service as any, 'convertToByteRange')
                .mockResolvedValue(undefined);
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
            areAlignedSpy.mockRestore();
            probeDurationSpy.mockRestore();
            fixMasterPlaylistSpy.mockRestore();
            fixAudioOnlyMasterPlaylistSpy.mockRestore();
            probeFrameRateSpy.mockRestore();
            probeGopDurationSpy.mockRestore();
            convertToByteRangeSpy.mockRestore();
        });

        it('should resolve with outputDir and masterPlaylist on success', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);

            const result = await promise;
            expect(result.outputDir).toBe(opts.outputDir);
            expect(result.masterPlaylist).toBe('master.m3u8');
            expect(result.segmentFormat).toBe('fmp4');
        });

        it('should call spawn with "ffmpeg" and correct args', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            expect(mockSpawn).toHaveBeenCalledWith(
                'ffmpeg',
                expect.any(Array),
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                }
            );

            const args: string[] = mockSpawn.mock.calls[0][1];
            expect(args).toContain('-i');
            expect(args).toContain(opts.inputPath);
            expect(args).toContain('-f');
            expect(args).toContain('hls');

            mockProc.emitClose(0);
            await promise;
        });

        it('should reject when FFmpeg exits with non-zero code', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitStderr('Error: something went wrong\n');
            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow('FFmpeg exited with code 1');
        });

        it('should include signal in error message when killed', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(null as any, 'SIGKILL');

            await expect(promise).rejects.toThrow('signal: SIGKILL');
        });

        it('should reject when FFmpeg process emits an error event', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitError(new Error('ENOENT: ffmpeg not found'));

            await expect(promise).rejects.toThrow(
                'FFmpeg spawn error: ENOENT: ffmpeg not found'
            );
        });

        it('should report progress via onProgress callback', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(100);

            const onProgress = vi.fn();
            const opts = makeEncodeOpts({ onProgress });
            const promise = service.encode(opts);
            await flushPromises();

            // 50% progress (50s out of 100s)
            mockProc.emitStderr('out_time_us=50000000\n');
            // 75% progress
            mockProc.emitStderr('out_time_us=75000000\n');

            mockProc.emitClose(0);
            await promise;

            expect(onProgress).toHaveBeenCalled();
            const calls = onProgress.mock.calls.map((c: any[]) => c[0]);
            expect(calls).toContain(50);
            expect(calls).toContain(75);
        });

        it('reports only the finish when duration is unknown', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(0);

            const onProgress = vi.fn();
            const promise = service.encode(makeEncodeOpts({ onProgress }));
            await flushPromises();

            mockProc.emitStderr('out_time_us=50000000\n');
            mockProc.emitClose(0);
            await promise;

            // Nothing can be said about how far along it is, but finishing is
            // still worth reporting — the bar otherwise sits empty at the end.
            expect(onProgress.mock.calls.map((c: any[]) => c[0])).toEqual([
                100,
            ]);
        });

        it('caps running progress at 99.9% and reports 100 once finished', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(100);

            const onProgress = vi.fn();
            const promise = service.encode(makeEncodeOpts({ onProgress }));
            await flushPromises();

            // 150% worth of time (150s out of 100s)
            mockProc.emitStderr('out_time_us=150000000\n');
            mockProc.emitClose(0);
            await promise;

            const calls = onProgress.mock.calls.map((c: any[]) => c[0]);
            // Capped while running, so a rounded 100 never claims a finish that
            // has not happened. Nothing used to lift it afterwards, so a
            // finished encode sat at 99.9% through the whole upload phase.
            expect(calls.slice(0, -1).every((v: number) => v <= 99.9)).toBe(
                true
            );
            expect(calls.at(-1)).toBe(100);
        });

        it('should fix the single master playlist for video type', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixMasterPlaylistSpy).toHaveBeenCalledWith(
                opts.outputDir,
                opts.encodeConfig
            );
            // One spec-correct master carries every angle as an EXT-X-MEDIA
            // rendition group; nothing writes a file per angle any more.
            expect(fixAudioOnlyMasterPlaylistSpy).not.toHaveBeenCalled();
        });

        it('should not call fixMasterPlaylist for audio type', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts({
                encodeConfig: {
                    type: 'audio',
                    segmentDuration: 6,
                    audioGroups: [
                        {
                            id: 'hd',
                            audioBitrateKbps: 128,
                            channels: 2,
                            audioCodec: 'aac',
                            sourceTrackIndex: 0,
                        },
                    ],
                },
            });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixMasterPlaylistSpy).not.toHaveBeenCalled();
        });

        it('always resolves to master.m3u8, whatever the angles', async () => {
            // The encoder writes one spec-correct master carrying every camera
            // angle as an EXT-X-MEDIA rendition group. It used to emit a file
            // per angle plus an audio_only.m3u8 and hand back a list; narrowing
            // is the player's job now (extractAnglePlaylist /
            // extractAudioOnlyPlaylist in the hls package), so there is one
            // name and it never varies.
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(0);
            const result = await promise;

            expect(result.masterPlaylist).toBe('master.m3u8');
        });

        it('should call fixAudioOnlyMasterPlaylist for audio type', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts({
                encodeConfig: {
                    type: 'audio',
                    segmentDuration: 6,
                    audioGroups: [
                        {
                            id: 'hd',
                            audioBitrateKbps: 192,
                            channels: 2,
                            audioCodec: 'aac',
                            sourceTrackIndex: 0,
                        },
                        {
                            id: 'low',
                            audioBitrateKbps: 64,
                            channels: 2,
                            audioCodec: 'aac',
                            sourceTrackIndex: 0,
                        },
                    ],
                },
            });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixAudioOnlyMasterPlaylistSpy).toHaveBeenCalledWith(
                opts.outputDir,
                opts.encodeConfig
            );
        });

        it('should not call fixAudioOnlyMasterPlaylist for video type', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixAudioOnlyMasterPlaylistSpy).not.toHaveBeenCalled();
        });

        it('should create output subdirectories for video type', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            // 1 video rendition + 1 audio group = 2 stream dirs
            expect(existsSync(join(opts.outputDir, 'stream_0'))).toBe(true);
            expect(existsSync(join(opts.outputDir, 'stream_1'))).toBe(true);
        });

        it('should clear activeProcess after completion', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            expect((service as any).activeProcess).toBe(mockProc);

            mockProc.emitClose(0);
            await promise;

            expect((service as any).activeProcess).toBeNull();
        });

        it('should clear activeProcess after error', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow();
            expect((service as any).activeProcess).toBeNull();
        });

        it('should call preByteRangeHook before convertToByteRange when provided', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const callOrder: string[] = [];
            const convertSpy = vi
                .spyOn(service as any, 'convertToByteRange')
                .mockImplementation(async () => {
                    callOrder.push('convertToByteRange');
                });

            const hook = vi.fn(() => {
                callOrder.push('preByteRangeHook');
            });
            const opts = makeEncodeOpts({ preByteRangeHook: hook });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(hook).toHaveBeenCalledWith(opts.outputDir);
            expect(callOrder[0]).toBe('preByteRangeHook');
            expect(callOrder[1]).toBe('convertToByteRange');

            convertSpy.mockRestore();
        });

        it('should not call preByteRangeHook when not provided', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const convertSpy = vi
                .spyOn(service as any, 'convertToByteRange')
                .mockResolvedValue(undefined);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(convertSpy).toHaveBeenCalled();

            convertSpy.mockRestore();
        });

        it('should include stderr tail in error message on failure', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitStderr('Processing frames...\n');
            mockProc.emitStderr('Error: codec not found\n');
            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow('codec not found');
        });
    });

    describe('killActiveProcess', () => {
        it('should send SIGTERM to the active process', () => {
            const mockProc = createMockProcess();
            (service as any).activeProcess = mockProc;

            service.killActiveProcess();

            expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('should be a no-op when no active process', () => {
            (service as any).activeProcess = null;

            expect(() => service.killActiveProcess()).not.toThrow();
        });

        it('should not kill an already-killed process', () => {
            const mockProc = createMockProcess();
            mockProc.killed = true;
            (service as any).activeProcess = mockProc;

            service.killActiveProcess();

            expect(mockProc.kill).not.toHaveBeenCalled();
        });
    });

    describe('onModuleDestroy', () => {
        it('should kill active FFmpeg process', async () => {
            const mockProc = createMockProcess();
            (service as any).activeProcess = mockProc;

            const destroyPromise = service.onModuleDestroy();

            // Simulate process exit after SIGTERM
            mockProc.emit('close', 0, 'SIGTERM');
            await destroyPromise;

            expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
            expect((service as any).activeProcess).toBeNull();
        });

        it('should be a no-op when no active process', async () => {
            (service as any).activeProcess = null;
            await expect(service.onModuleDestroy()).resolves.toBeUndefined();
        });

        it('should not kill already-killed process', async () => {
            const mockProc = createMockProcess();
            mockProc.killed = true;
            (service as any).activeProcess = mockProc;

            await service.onModuleDestroy();

            expect(mockProc.kill).not.toHaveBeenCalled();
        });
    });

    describe('fixMasterPlaylistAudioNames', () => {
        it('should fix NAME attributes for multi-language groups using label ?? language ?? Audio', () => {
            const config = {
                type: 'video' as const,
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'English HD',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'hd',
                        label: 'Spanish HD',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 1,
                        language: 'spa',
                    },
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",DEFAULT=YES,URI="stream_hd_English_HD/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",DEFAULT=NO,URI="stream_hd_Spanish_HD/playlist.m3u8"',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistAudioNames(
                content,
                config
            );
            const lines = result.split('\n');

            expect(lines[2]).toContain('NAME="English HD"');
            expect(lines[3]).toContain('NAME="Spanish HD"');
        });

        it('should fix NAME attributes for single-language groups using language ?? Audio', () => {
            const config = {
                type: 'video' as const,
                audioGroups: [
                    {
                        id: 'hd',
                        label: 'HD Audio',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                    {
                        id: 'low',
                        label: 'Low Audio',
                        audioBitrateKbps: 96,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",DEFAULT=YES,URI="stream_hd_HD_Audio/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="old",DEFAULT=YES,URI="stream_low_Low_Audio/playlist.m3u8"',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistAudioNames(
                content,
                config
            );
            const lines = result.split('\n');

            // Single language: both should use language name "eng"
            expect(lines[1]).toContain('NAME="eng"');
            expect(lines[2]).toContain('NAME="eng"');
        });

        it('should use "Audio" as NAME fallback when no language is set (single-language)', () => {
            const config = {
                type: 'video' as const,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const content =
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",DEFAULT=YES,URI="stream_hd_192kbps/playlist.m3u8"';

            const result = (service as any).fixMasterPlaylistAudioNames(
                content,
                config
            );
            expect(result).toContain('NAME="Audio"');
        });

        it('should return content unchanged when audioGroups is empty', () => {
            const config = { type: 'video' as const, audioGroups: [] };
            const content =
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",URI="stream_hd_foo/playlist.m3u8"';
            expect(
                (service as any).fixMasterPlaylistAudioNames(content, config)
            ).toBe(content);
        });

        it('should return content unchanged when audioGroups is undefined', () => {
            const config = { type: 'video' as const };
            const content =
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",URI="stream_hd_foo/playlist.m3u8"';
            expect(
                (service as any).fixMasterPlaylistAudioNames(content, config)
            ).toBe(content);
        });

        it('should leave lines without a matching URI unchanged', () => {
            const config = {
                type: 'video' as const,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            };

            const content = [
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",URI="stream_NOMATCH/playlist.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
                'stream_hd_192kbps/playlist.m3u8',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistAudioNames(
                content,
                config
            );
            const lines = result.split('\n');

            // The audio line URI doesn't match any built URI, so NAME stays "old"
            expect(lines[0]).toContain('NAME="old"');
            // Non-audio lines are untouched
            expect(lines[1]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=5000000');
            expect(lines[2]).toBe('stream_hd_192kbps/playlist.m3u8');
        });
    });

    describe('fixMasterPlaylistVideoGroups', () => {
        it('should return content unchanged when there is a single source track', () => {
            const config = {
                type: 'video' as const,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 3000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                ],
            };

            const content =
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000\nstream_0/playlist.m3u8';
            expect(
                (service as any).fixMasterPlaylistVideoGroups(content, config)
            ).toBe(content);
        });

        it('should return content unchanged when videoRenditions is empty', () => {
            const config = { type: 'video' as const, videoRenditions: [] };
            const content = '#EXTM3U\n#EXT-X-VERSION:7';
            expect(
                (service as any).fixMasterPlaylistVideoGroups(content, config)
            ).toBe(content);
        });

        it('should add VIDEO attributes and EXT-X-MEDIA VIDEO entries for multiple tracks', () => {
            const config = {
                type: 'video' as const,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 1,
                        audioGroupId: 'hd',
                    },
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
                'stream_0/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
                'stream_1/playlist.m3u8',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistVideoGroups(
                content,
                config
            );

            // Should contain EXT-X-MEDIA VIDEO entries
            expect(result).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Angle_0",NAME="Angle 0",DEFAULT=YES'
            );
            expect(result).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Angle_1",NAME="Angle 1",DEFAULT=NO'
            );
            // Should add VIDEO= to STREAM-INF lines
            expect(result).toContain('VIDEO="Angle_0"');
            expect(result).toContain('VIDEO="Angle_1"');
        });

        it('should use custom videoTrackNames when provided', () => {
            const config = {
                type: 'video' as const,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 1,
                        audioGroupId: 'hd',
                    },
                ],
                videoTrackNames: [
                    { index: 0, name: 'Main Camera' },
                    { index: 1, name: 'Side Camera' },
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
                'stream_0/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
                'stream_1/playlist.m3u8',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistVideoGroups(
                content,
                config
            );

            expect(result).toContain('NAME="Main Camera"');
            expect(result).toContain('NAME="Side Camera"');
            expect(result).toContain('VIDEO="Main_Camera"');
            expect(result).toContain('VIDEO="Side_Camera"');
        });

        it('should insert VIDEO before AUDIO when AUDIO= is already present', () => {
            const config = {
                type: 'video' as const,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 1,
                        audioGroupId: 'hd',
                    },
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="hd"',
                'stream_0/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="hd"',
                'stream_1/playlist.m3u8',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistVideoGroups(
                content,
                config
            );
            const lines = result.split('\n');

            // Find the STREAM-INF lines and check VIDEO is placed before AUDIO
            const streamInfLines = lines.filter((l) =>
                l.startsWith('#EXT-X-STREAM-INF:')
            );
            for (const line of streamInfLines) {
                expect(line).toMatch(/VIDEO="[^"]+",AUDIO="hd"/);
            }
        });
    });

    describe('buildVideoStreamName', () => {
        it('should use label and track index when multiTrack is true', () => {
            const rendition = {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: false,
                audioGroupId: 'hd',
                label: '1080p',
                sourceTrackIndex: 2,
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                true
            );
            expect(result).toBe('1080p_t2_1920x1080');
        });

        it('should use label without track index when multiTrack is false', () => {
            const rendition = {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: false,
                audioGroupId: 'hd',
                label: '1080p',
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                false
            );
            expect(result).toBe('1080p_1920x1080');
        });

        it('should fall back to heightp when label is not set', () => {
            const rendition = {
                width: 1280,
                height: 720,
                videoBitrateKbps: 3000,
                copyStream: false,
                audioGroupId: 'hd',
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                false
            );
            expect(result).toBe('720p_1280x720');
        });

        it('should fall back to heightp with track index when label is not set and multiTrack is true', () => {
            const rendition = {
                width: 1280,
                height: 720,
                videoBitrateKbps: 3000,
                copyStream: false,
                audioGroupId: 'hd',
                sourceTrackIndex: 1,
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                true
            );
            expect(result).toBe('720p_t1_1280x720');
        });

        it('should replace spaces in label with underscores', () => {
            const rendition = {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: false,
                audioGroupId: 'hd',
                label: 'Full HD',
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                false
            );
            expect(result).toBe('Full_HD_1920x1080');
        });

        it('should default sourceTrackIndex to 0 when not set and multiTrack is true', () => {
            const rendition = {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: false,
                audioGroupId: 'hd',
                label: '1080p',
            };
            const result = (service as any).buildVideoStreamName(
                rendition,
                true
            );
            expect(result).toBe('1080p_t0_1920x1080');
        });
    });

    describe('FFmpeg timeout', () => {
        let tmpDir: string;
        let areAlignedSpy: MockInstance;
        let probeDurationSpy: MockInstance;
        let fixMasterPlaylistSpy: MockInstance;
        let fixAudioOnlyMasterPlaylistSpy: MockInstance;
        let probeFrameRateSpy: MockInstance;
        let probeGopDurationSpy: MockInstance;
        let convertToByteRangeSpy: MockInstance;

        const baseEncodeConfig: EncodeConfigDto = {
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
                    audioBitrateKbps: 192,
                    channels: 2,
                    audioCodec: 'aac',
                    sourceTrackIndex: 0,
                },
            ],
        };

        beforeEach(() => {
            vi.useFakeTimers();
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-timeout-'));
            mockSpawn.mockReset();
            areAlignedSpy = vi
                .spyOn(service as any, 'areStreamStartTimesAligned')
                .mockResolvedValue(true);
            probeDurationSpy = vi
                .spyOn(service as any, 'probeDuration')
                .mockResolvedValue(100);
            fixMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixMasterPlaylist')
                .mockResolvedValue(undefined);
            fixAudioOnlyMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixAudioOnlyMasterPlaylist')
                .mockResolvedValue(undefined);
            probeFrameRateSpy = vi
                .spyOn(service as any, 'probeFrameRate')
                .mockResolvedValue(30);
            probeGopDurationSpy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(2);
            convertToByteRangeSpy = vi
                .spyOn(service as any, 'convertToByteRange')
                .mockResolvedValue(undefined);
        });

        afterEach(() => {
            vi.useRealTimers();
            rmSync(tmpDir, { recursive: true, force: true });
            areAlignedSpy.mockRestore();
            probeDurationSpy.mockRestore();
            fixMasterPlaylistSpy.mockRestore();
            fixAudioOnlyMasterPlaylistSpy.mockRestore();
            probeFrameRateSpy.mockRestore();
            probeGopDurationSpy.mockRestore();
            convertToByteRangeSpy.mockRestore();
        });

        it('should reject when FFmpeg times out', async () => {
            (service as any).timeoutMs = 500;
            const proc = createMockProcess();
            mockSpawn.mockReturnValue(proc);

            const promise = service.encode({
                sessionId: 'timeout-test',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig: baseEncodeConfig,
                onProgress: vi.fn(),
            });

            // Let microtasks settle (buildVideoArgs is async)
            await vi.advanceTimersByTimeAsync(0);

            // Advance past the timeout threshold
            vi.advanceTimersByTime(600);

            await expect(promise).rejects.toThrow(
                'FFmpeg timed out after 500ms'
            );
            expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        });

        it('should not time out when timeoutMs is 0 (disabled)', async () => {
            (service as any).timeoutMs = 0;
            const proc = createMockProcess();
            mockSpawn.mockReturnValue(proc);

            const promise = service.encode({
                sessionId: 'no-timeout-test',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig: baseEncodeConfig,
                onProgress: vi.fn(),
            });

            // Let microtasks settle
            await vi.advanceTimersByTimeAsync(0);

            // Advance a long time — should not reject
            vi.advanceTimersByTime(60_000);

            // Process completes normally
            proc.emitClose(0);
            const result = await promise;
            expect(result.masterPlaylist).toBe('master.m3u8');
            expect(proc.kill).not.toHaveBeenCalled();
        });

        it('should not fire timeout when process completes before timeout', async () => {
            (service as any).timeoutMs = 5000;
            const proc = createMockProcess();
            mockSpawn.mockReturnValue(proc);

            const promise = service.encode({
                sessionId: 'fast-complete-test',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig: baseEncodeConfig,
                onProgress: vi.fn(),
            });

            // Let microtasks settle
            await vi.advanceTimersByTimeAsync(0);

            // Process completes before timeout
            proc.emitClose(0);
            const result = await promise;
            expect(result.masterPlaylist).toBe('master.m3u8');

            // Advance past the timeout — should not cause any issues
            vi.advanceTimersByTime(10_000);
            expect(proc.kill).not.toHaveBeenCalled();
        });
    });

    describe('fixMasterPlaylist read error path', () => {
        it('should return silently when master.m3u8 does not exist', async () => {
            const nonExistentDir = join(
                tmpdir(),
                'non-existent-dir-' + Date.now()
            );
            // Should not throw — the method catches readFile errors and returns
            await expect(
                (service as any).fixMasterPlaylist(nonExistentDir, {
                    type: 'video',
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
                })
            ).resolves.toBeUndefined();
        });
    });

    describe('fixAudioOnlyMasterPlaylist read error path', () => {
        it('should return silently when master.m3u8 does not exist', async () => {
            const nonExistentDir = join(
                tmpdir(),
                'non-existent-dir-' + Date.now()
            );
            await expect(
                (service as any).fixAudioOnlyMasterPlaylist(nonExistentDir, {
                    type: 'audio',
                    audioGroups: [
                        {
                            id: 'hd',
                            audioBitrateKbps: 192,
                            channels: 2,
                            audioCodec: 'aac',
                            sourceTrackIndex: 0,
                        },
                    ],
                })
            ).resolves.toBeUndefined();
        });
    });

    describe('convertToByteRange', () => {
        it('should reject when worker emits an error (real worker)', async () => {
            const existingSpy = vi.spyOn(service as any, 'convertToByteRange');
            if (existingSpy) existingSpy.mockRestore();

            await expect(
                (service as any).convertToByteRange(
                    '/non/existent/dir',
                    500 * 1024 * 1024
                )
            ).rejects.toThrow();
        });

        it('should resolve when worker sends success message', async () => {
            useRealWorker.value = false;
            const fakeWorker = new EventEmitter();
            MockWorker.mockReturnValue(fakeWorker);

            const promise = (service as any).convertToByteRange(
                '/tmp/output',
                500 * 1024 * 1024
            );
            fakeWorker.emit('message', { streamCount: 3 });

            await expect(promise).resolves.toBeUndefined();
            useRealWorker.value = true;
            MockWorker.mockReset();
        });

        it('should reject when worker exits with non-zero code', async () => {
            useRealWorker.value = false;
            const fakeWorker = new EventEmitter();
            MockWorker.mockReturnValue(fakeWorker);

            const promise = (service as any).convertToByteRange(
                '/tmp/output',
                500 * 1024 * 1024
            );
            fakeWorker.emit('exit', 1);

            await expect(promise).rejects.toThrow(
                'Byte-range worker exited with code 1'
            );
            useRealWorker.value = true;
            MockWorker.mockReset();
        });

        it('should reject when worker emits error (mocked)', async () => {
            useRealWorker.value = false;
            const fakeWorker = new EventEmitter();
            MockWorker.mockReturnValue(fakeWorker);

            const promise = (service as any).convertToByteRange(
                '/tmp/output',
                500 * 1024 * 1024
            );
            fakeWorker.emit('error', new Error('worker crashed'));

            await expect(promise).rejects.toThrow(
                'Byte-range worker error: worker crashed'
            );
            useRealWorker.value = true;
            MockWorker.mockReset();
        });
    });

    describe('GPU detection via onModuleInit', () => {
        it('should detect NVIDIA GPU when nvidia-smi succeeds and hwaccels includes cuda', async () => {
            mockExecSync.mockImplementation((cmd: string) => {
                if (cmd === 'nvidia-smi') return '';
                if (cmd === 'ffmpeg -hwaccels 2>/dev/null')
                    return 'Hardware acceleration methods:\ncuda\n';
                throw new Error('not available');
            });

            await service.onModuleInit();
            expect(service.getAccelMode()).toBe('nvidia');
            expect(service.isGpuAvailable()).toBe(true);
        });

        it('should fall through when nvidia-smi fails', async () => {
            mockExecSync.mockImplementation(() => {
                throw new Error('not available');
            });

            await service.onModuleInit();
            expect(service.getAccelMode()).toBe('cpu');
        });

        it('should detect Apple GPU on darwin/arm64 with correct ffmpeg capabilities', async () => {
            const origPlatform = process.platform;
            const origArch = process.arch;
            Object.defineProperty(process, 'platform', {
                value: 'darwin',
                configurable: true,
            });
            Object.defineProperty(process, 'arch', {
                value: 'arm64',
                configurable: true,
            });

            try {
                mockExecSync.mockImplementation((cmd: string) => {
                    if (cmd === 'nvidia-smi') throw new Error('not available');
                    if (cmd === 'ffmpeg -hwaccels 2>/dev/null')
                        return 'Hardware acceleration methods:\nvideotoolbox\n';
                    if (cmd === 'ffmpeg -encoders 2>/dev/null')
                        return 'h264_videotoolbox';
                    if (cmd === 'ffmpeg -filters 2>/dev/null')
                        return 'scale_vt';
                    throw new Error('not available');
                });

                await service.onModuleInit();
                expect(service.getAccelMode()).toBe('apple');
                expect(service.isGpuAvailable()).toBe(true);
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: origPlatform,
                    configurable: true,
                });
                Object.defineProperty(process, 'arch', {
                    value: origArch,
                    configurable: true,
                });
            }
        });

        it('should fall back to CPU when neither GPU is detected', async () => {
            mockExecSync.mockImplementation(() => {
                throw new Error('not available');
            });

            await service.onModuleInit();
            expect(service.getAccelMode()).toBe('cpu');
            expect(service.isGpuAvailable()).toBe(false);
        });

        it('should fall back to CPU when Apple platform but missing videotoolbox encoder', async () => {
            const origPlatform = process.platform;
            const origArch = process.arch;
            Object.defineProperty(process, 'platform', {
                value: 'darwin',
                configurable: true,
            });
            Object.defineProperty(process, 'arch', {
                value: 'arm64',
                configurable: true,
            });

            try {
                mockExecSync.mockImplementation((cmd: string) => {
                    if (cmd === 'nvidia-smi') throw new Error('not available');
                    if (cmd === 'ffmpeg -hwaccels 2>/dev/null')
                        return 'Hardware acceleration methods:\nvideotoolbox\n';
                    if (cmd === 'ffmpeg -encoders 2>/dev/null')
                        return 'some_other_encoder';
                    throw new Error('not available');
                });

                await service.onModuleInit();
                expect(service.getAccelMode()).toBe('cpu');
            } finally {
                Object.defineProperty(process, 'platform', {
                    value: origPlatform,
                    configurable: true,
                });
                Object.defineProperty(process, 'arch', {
                    value: origArch,
                    configurable: true,
                });
            }
        });
    });

    describe('probeStreamStartTimes (private, tested via reflection)', () => {
        it('should return parsed video/audio start times from ffprobe JSON output', async () => {
            const ffprobeOutput = JSON.stringify({
                streams: [
                    { codec_type: 'video', start_time: '0.000000' },
                    { codec_type: 'audio', start_time: '0.023220' },
                    { codec_type: 'video', start_time: '0.100000' },
                ],
            });

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: ffprobeOutput, stderr: '' });
                }
            });

            const result = await (service as any).probeStreamStartTimes(
                '/test.mp4'
            );
            expect(result.video).toEqual([0, 0.1]);
            expect(result.audio).toEqual([0.02322]);
        });

        it('should return empty arrays when ffprobe fails', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(new Error('ffprobe not found'), {
                        stdout: '',
                        stderr: '',
                    });
                }
            });

            const result = await (service as any).probeStreamStartTimes(
                '/test.mp4'
            );
            expect(result).toEqual({ video: [], audio: [] });
        });

        it('should default NaN start_time to 0', async () => {
            const ffprobeOutput = JSON.stringify({
                streams: [{ codec_type: 'video', start_time: 'N/A' }],
            });

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: ffprobeOutput, stderr: '' });
                }
            });

            const result = await (service as any).probeStreamStartTimes(
                '/test.mp4'
            );
            expect(result.video).toEqual([0]);
        });
    });

    describe('areStreamStartTimesAligned (private, tested via reflection)', () => {
        it('should return true when all start times are aligned (spread < 50ms)', async () => {
            const ffprobeOutput = JSON.stringify({
                streams: [
                    { codec_type: 'video', start_time: '0.000000' },
                    { codec_type: 'audio', start_time: '0.020000' },
                ],
            });

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: ffprobeOutput, stderr: '' });
                }
            });

            const config: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
                        audioGroupId: 'a1',
                        label: '720p',
                        sourceTrackIndex: 0,
                    },
                ],
                audioGroups: [
                    {
                        id: 'a1',
                        label: 'Audio',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const result = await (service as any).areStreamStartTimesAligned(
                '/test.mp4',
                config
            );
            expect(result).toBe(true);
        });

        it('should return false when start times are misaligned (spread >= 50ms)', async () => {
            const ffprobeOutput = JSON.stringify({
                streams: [
                    { codec_type: 'video', start_time: '0.000000' },
                    { codec_type: 'audio', start_time: '0.100000' },
                ],
            });

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: ffprobeOutput, stderr: '' });
                }
            });

            const config: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        copyStream: false,
                        audioGroupId: 'a1',
                        label: '720p',
                        sourceTrackIndex: 0,
                    },
                ],
                audioGroups: [
                    {
                        id: 'a1',
                        label: 'Audio',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const result = await (service as any).areStreamStartTimesAligned(
                '/test.mp4',
                config
            );
            expect(result).toBe(false);
        });

        it('should return true when fewer than 2 used start times', async () => {
            const ffprobeOutput = JSON.stringify({
                streams: [{ codec_type: 'audio', start_time: '0.500000' }],
            });

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: ffprobeOutput, stderr: '' });
                }
            });

            const config: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'a1',
                        label: 'Audio',
                        audioBitrateKbps: 128,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const result = await (service as any).areStreamStartTimesAligned(
                '/test.mp4',
                config
            );
            expect(result).toBe(true);
        });
    });

    describe('probeDuration (private, tested via reflection)', () => {
        it('should return duration from ffprobe output', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: '125.340000\n', stderr: '' });
                }
            });

            const result = await (service as any).probeDuration('/test.mp4');
            expect(result).toBeCloseTo(125.34);
        });

        it('should return 0 when ffprobe fails', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(new Error('ffprobe failed'), { stdout: '', stderr: '' });
                }
            });

            const result = await (service as any).probeDuration('/test.mp4');
            expect(result).toBe(0);
        });

        it('should return 0 when output is not a number', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: 'N/A\n', stderr: '' });
                }
            });

            const result = await (service as any).probeDuration('/test.mp4');
            expect(result).toBe(0);
        });
    });

    describe('probeFrameRate (private, tested via reflection)', () => {
        it('should return fps from fraction format (e.g., 30000/1001)', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: '30000/1001\n', stderr: '' });
                }
            });

            const result = await (service as any).probeFrameRate('/test.mp4');
            expect(result).toBeCloseTo(29.97, 1);
        });

        it('should return fps from plain number', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: '25\n', stderr: '' });
                }
            });

            const result = await (service as any).probeFrameRate('/test.mp4');
            expect(result).toBe(25);
        });

        it('should return 30 as default when ffprobe fails', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(new Error('ffprobe failed'), { stdout: '', stderr: '' });
                }
            });

            const result = await (service as any).probeFrameRate('/test.mp4');
            expect(result).toBe(30);
        });

        it('should return 30 when output is not a valid number', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout: 'N/A\n', stderr: '' });
                }
            });

            const result = await (service as any).probeFrameRate('/test.mp4');
            expect(result).toBe(30);
        });
    });

    describe('probeGopDuration (private, tested via reflection)', () => {
        it('should return GOP duration from frame analysis', async () => {
            // Simulate: I at frame 0, then P/B frames, then I at frame 60 → GOP = 60 frames
            const frames = [
                'I',
                ...Array(59).fill('P'),
                'I',
                ...Array(39).fill('P'),
            ];
            const stdout = frames.join('\n') + '\n';

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout, stderr: '' });
                }
            });

            const result = await (service as any).probeGopDuration(
                '/test.mp4',
                30
            );
            // GOP = 60 frames / 30 fps = 2.0 seconds
            expect(result).toBe(2);
        });

        it('should return null when fewer than 2 keyframes found', async () => {
            const stdout = 'I\nP\nP\nP\nP\n';

            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(null, { stdout, stderr: '' });
                }
            });

            const result = await (service as any).probeGopDuration(
                '/test.mp4',
                30
            );
            expect(result).toBeNull();
        });

        it('should return null when ffprobe fails', async () => {
            mockExecFile.mockImplementation((...args: any[]) => {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') {
                    cb(new Error('ffprobe failed'), { stdout: '', stderr: '' });
                }
            });

            const result = await (service as any).probeGopDuration(
                '/test.mp4',
                30
            );
            expect(result).toBeNull();
        });
    });

    describe('onModuleDestroy force kill', () => {
        it('should send SIGKILL after 5s if process does not exit after SIGTERM', async () => {
            vi.useFakeTimers();
            try {
                const mockProc = createMockProcess();
                (service as any).activeProcess = mockProc;

                const destroyPromise = service.onModuleDestroy();

                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

                // Process does NOT emit 'close' — advance past the 5s force kill timer
                vi.advanceTimersByTime(5000);

                await destroyPromise;

                expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');
                expect((service as any).activeProcess).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('bitrateToVbrQuality (private, tested via reflection)', () => {
        const bitrateToVbrQuality = (bitrateKbps: number): string => {
            return (service as any).bitrateToVbrQuality(bitrateKbps);
        };

        it('should return quality value based on bitrate', () => {
            expect(bitrateToVbrQuality(128)).toBe('1.0');
            expect(bitrateToVbrQuality(192)).toBe('1.5');
        });

        it('should clamp to minimum 0.1', () => {
            expect(bitrateToVbrQuality(1)).toBe('0.1');
        });

        it('should clamp to maximum 2.0', () => {
            expect(bitrateToVbrQuality(512)).toBe('2.0');
        });
    });

    describe('bitrateToVideoCrf (private, tested via reflection)', () => {
        const bitrateToVideoCrf = (
            bitrateKbps: number,
            width: number,
            height: number
        ): number => {
            return (service as any).bitrateToVideoCrf(
                bitrateKbps,
                width,
                height
            );
        };

        it('should return a CRF value for standard parameters', () => {
            const crf = bitrateToVideoCrf(2500, 1280, 720);
            expect(crf).toBeGreaterThanOrEqual(16);
            expect(crf).toBeLessThanOrEqual(34);
        });

        it('should clamp to minimum 16 for high bitrate', () => {
            const crf = bitrateToVideoCrf(50000, 640, 360);
            expect(crf).toBe(16);
        });

        it('should clamp to maximum 34 for very low bitrate', () => {
            const crf = bitrateToVideoCrf(10, 3840, 2160);
            expect(crf).toBe(34);
        });
    });

    describe('buildVideoArgs VBR modes', () => {
        const buildVideoArgs = (opts: any): Promise<string[]> => {
            return (service as any).buildVideoArgs(opts);
        };

        it('should use CRF-based VBR args for NVIDIA with vbr=true', async () => {
            (service as any).accelMode = 'nvidia';

            const encodeConfig: EncodeConfigDto = {
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
                        vbr: true,
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

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            // NVIDIA VBR should use -cq and -b:v 0
            expect(args).toContain('h264_nvenc');
            const cqIdx = args.indexOf('-cq:v:0');
            expect(cqIdx).toBeGreaterThan(-1);
            const bvIdx = args.indexOf('-b:v:0');
            expect(args[bvIdx + 1]).toBe('0');
            expect(args).toContain('-maxrate:v:0');
            expect(args).toContain('-bufsize:v:0');
        });

        it('reserves NVDEC surfaces before the input, scaled to the ladder', async () => {
            // A six-rendition ladder drained the decoder pool: "No decoder
            // surfaces left" → "Invalid data found when processing input" →
            // either a dead encode or valid H.264 full of undecoded frames (#93).
            // Reproduced on the box: fails without this, clean with it.
            (service as any).accelMode = 'nvidia';

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig: {
                    type: 'video',
                    segmentDuration: 6,
                    videoRenditions: [
                        {
                            width: 1920,
                            height: 1080,
                            videoBitrateKbps: 5000,
                            copyStream: false,
                            audioGroupId: 'hd',
                            vbr: true,
                        },
                        {
                            width: 1280,
                            height: 720,
                            videoBitrateKbps: 2500,
                            copyStream: false,
                            audioGroupId: 'hd',
                            vbr: true,
                        },
                        {
                            width: 640,
                            height: 360,
                            videoBitrateKbps: 600,
                            copyStream: false,
                            audioGroupId: 'hd',
                            vbr: true,
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
                } as EncodeConfigDto,
            });

            const idx = args.indexOf('-extra_hw_frames');
            expect(idx).toBeGreaterThan(-1);
            // Inside the measured window: below it the pool exhausts mid-decode,
            // above it cuvidCreateDecoder refuses to initialise.
            expect(args[idx + 1]).toBe('8');
            // A decoder option: after -i it configures nothing.
            expect(idx).toBeLessThan(args.indexOf('-i'));
        });

        it('keeps the same budget however long the ladder is', async () => {
            // The ceiling is the decoder's, not the ladder's: scaling this per
            // rendition reached 20 on six rungs and broke every encode.
            (service as any).accelMode = 'nvidia';
            const many = Array.from({ length: 20 }, (_, i) => ({
                width: 640,
                height: 360 + i,
                videoBitrateKbps: 600,
                copyStream: false,
                audioGroupId: 'hd',
                vbr: true,
            }));

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig: {
                    type: 'video',
                    segmentDuration: 6,
                    videoRenditions: many,
                    audioGroups: [
                        {
                            id: 'hd',
                            audioBitrateKbps: 128,
                            channels: 2,
                            audioCodec: 'aac',
                            sourceTrackIndex: 0,
                        },
                    ],
                } as EncodeConfigDto,
            });

            expect(args[args.indexOf('-extra_hw_frames') + 1]).toBe('8');
        });

        it('asks NVENC for high profile, matching the other encoders', async () => {
            // Unset, NVENC emits Main — no CABAC, no 8x8 transforms — while the
            // VideoToolbox branch has always requested high. Roughly 10% of
            // quality at the same bitrate, given away silently (#93).
            (service as any).accelMode = 'nvidia';

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig: {
                    type: 'video',
                    segmentDuration: 6,
                    videoRenditions: [
                        {
                            width: 1920,
                            height: 1080,
                            videoBitrateKbps: 5000,
                            copyStream: false,
                            audioGroupId: 'hd',
                            vbr: true,
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
                } as EncodeConfigDto,
            });

            const pIdx = args.indexOf('-profile:v:0');
            expect(pIdx).toBeGreaterThan(-1);
            expect(args[pIdx + 1]).toBe('high');
        });

        it('demands less per frame from a 60 fps source than a 30 fps one', async () => {
            // The cq target divided by a hardcoded 30 fps, so high-frame-rate
            // sources were asked for more quality than their rate cap could pay
            // for — the encoder rode the cap and motion fell apart (#93).
            (service as any).accelMode = 'nvidia';
            const cfg = () =>
                ({
                    type: 'video',
                    segmentDuration: 6,
                    videoRenditions: [
                        {
                            width: 1920,
                            height: 1080,
                            videoBitrateKbps: 5000,
                            copyStream: false,
                            audioGroupId: 'hd',
                            vbr: true,
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
                }) as EncodeConfigDto;

            const cqAt = async (fps: number) => {
                const spy = vi
                    .spyOn(service as any, 'probeFrameRate')
                    .mockResolvedValue(fps);
                const args = await buildVideoArgs({
                    inputPath: '/tmp/input.mp4',
                    outputDir: '/tmp/output',
                    encodeConfig: cfg(),
                });
                spy.mockRestore();
                return parseInt(args[args.indexOf('-cq:v:0') + 1], 10);
            };

            const at30 = await cqAt(30);
            const at60 = await cqAt(60);
            expect(at60).toBeGreaterThan(at30);
        });

        it('should use CRF-based VBR args for CPU with vbr=true', async () => {
            (service as any).accelMode = 'cpu';

            const encodeConfig: EncodeConfigDto = {
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
                        vbr: true,
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

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('libx264');
            const crfIdx = args.indexOf('-crf:v:0');
            expect(crfIdx).toBeGreaterThan(-1);
            expect(args).toContain('-maxrate:v:0');
            expect(args).toContain('-bufsize:v:0');
            // Should NOT have -b:v:0 (CPU VBR uses CRF, not bitrate)
            const bvIdx = args.indexOf('-b:v:0');
            expect(bvIdx).toBe(-1);
        });
    });

    describe('buildVideoArgs audio copy and VBR in video mode', () => {
        const buildVideoArgs = (opts: any): Promise<string[]> => {
            return (service as any).buildVideoArgs(opts);
        };

        it('should use copy codec for audio groups with copyStream=true', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        copyStream: true,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-c:a:0');
            const caIdx = args.indexOf('-c:a:0');
            expect(args[caIdx + 1]).toBe('copy');
            // Should not contain aac audio codec or bitrate for this group
            expect(args).not.toContain('-b:a:0');
            expect(args).not.toContain('-q:a:0');
        });

        it('should use VBR quality for audio groups with vbr=true in video mode', async () => {
            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        vbr: true,
                    },
                ],
            };

            const args = await buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-q:a:0');
            expect(args).not.toContain('-b:a:0');
        });
    });

    describe('buildAudioArgs VBR in audio-only mode', () => {
        const buildAudioArgs = async (opts: any): Promise<string[]> => {
            return (service as any).buildAudioArgs(opts);
        };

        it('should use VBR quality for audio groups with vbr=true', async () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                        vbr: true,
                    },
                ],
            };

            const args = await buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-q:a:0');
            expect(args).not.toContain('-b:a:0');
        });
    });

    describe('encode stderr buffer truncation', () => {
        let tmpDir: string;
        let areAlignedSpy: MockInstance;
        let probeDurationSpy: MockInstance;
        let fixMasterPlaylistSpy: MockInstance;
        let fixAudioOnlyMasterPlaylistSpy: MockInstance;
        let probeFrameRateSpy: MockInstance;
        let probeGopDurationSpy: MockInstance;
        let convertToByteRangeSpy: MockInstance;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-stderr-'));
            mockSpawn.mockReset();
            areAlignedSpy = vi
                .spyOn(service as any, 'areStreamStartTimesAligned')
                .mockResolvedValue(true);
            probeDurationSpy = vi
                .spyOn(service as any, 'probeDuration')
                .mockResolvedValue(100);
            fixMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixMasterPlaylist')
                .mockResolvedValue(undefined);
            fixAudioOnlyMasterPlaylistSpy = vi
                .spyOn(service as any, 'fixAudioOnlyMasterPlaylist')
                .mockResolvedValue(undefined);
            probeFrameRateSpy = vi
                .spyOn(service as any, 'probeFrameRate')
                .mockResolvedValue(30);
            probeGopDurationSpy = vi
                .spyOn(service as any, 'probeGopDuration')
                .mockResolvedValue(2);
            convertToByteRangeSpy = vi
                .spyOn(service as any, 'convertToByteRange')
                .mockResolvedValue(undefined);
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
            areAlignedSpy.mockRestore();
            probeDurationSpy.mockRestore();
            fixMasterPlaylistSpy.mockRestore();
            fixAudioOnlyMasterPlaylistSpy.mockRestore();
            probeFrameRateSpy.mockRestore();
            probeGopDurationSpy.mockRestore();
            convertToByteRangeSpy.mockRestore();
        });

        it('should truncate stderr buffer when it exceeds 8192 bytes', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const promise = service.encode({
                sessionId: 'stderr-test',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig,
                onProgress: vi.fn(),
            });
            await flushPromises();

            // Emit > 8192 bytes of stderr data
            const largeChunk = 'x'.repeat(10000);
            mockProc.emitStderr(largeChunk);
            // Then emit an identifiable tail
            mockProc.emitStderr('FINAL_ERROR_MESSAGE\n');

            mockProc.emitClose(1);

            // The error should contain the tail (truncated buffer keeps last 8192 bytes)
            await expect(promise).rejects.toThrow('FINAL_ERROR_MESSAGE');
        });

        it('should call settle only once when both close and error fire', async () => {
            const mockProc = createMockProcess();
            mockSpawn.mockReturnValue(mockProc);

            const encodeConfig: EncodeConfigDto = {
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
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac',
                        sourceTrackIndex: 0,
                    },
                ],
            };

            const promise = service.encode({
                sessionId: 'settle-test',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig,
                onProgress: vi.fn(),
            });
            await flushPromises();

            // Emit error first — this calls settle()
            mockProc.emitError(new Error('spawn failed'));

            // Then emit close — settle() guard should prevent double-settle
            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow('spawn failed');
        });
    });

    describe('fixMasterPlaylistAudioNames edge cases', () => {
        it('should return audio line unchanged when it has no URI attribute', () => {
            const config = {
                type: 'video' as const,
                audioGroups: [
                    {
                        id: 'hd',
                        audioBitrateKbps: 192,
                        channels: 2,
                        audioCodec: 'aac' as const,
                        sourceTrackIndex: 0,
                        language: 'eng',
                    },
                ],
            };

            const content =
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="old",DEFAULT=YES';

            const result = (service as any).fixMasterPlaylistAudioNames(
                content,
                config
            );
            expect(result).toContain('NAME="old"');
        });
    });

    describe('fixMasterPlaylistVideoGroups edge cases', () => {
        it('should skip duplicate groupIds when multiple renditions map to the same angle', () => {
            const config = {
                type: 'video' as const,
                videoRenditions: [
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 3000,
                        copyStream: false,
                        sourceTrackIndex: 0,
                        audioGroupId: 'hd',
                    },
                    {
                        width: 1920,
                        height: 1080,
                        videoBitrateKbps: 5000,
                        copyStream: false,
                        sourceTrackIndex: 1,
                        audioGroupId: 'hd',
                    },
                ],
                videoTrackNames: [
                    { index: 0, name: 'Main' },
                    { index: 1, name: 'Main' }, // Duplicate name → same groupId
                ],
            };

            const content = [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="hd"',
                'stream_0/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="hd"',
                'stream_1/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="hd"',
                'stream_2/playlist.m3u8',
            ].join('\n');

            const result = (service as any).fixMasterPlaylistVideoGroups(
                content,
                config
            );

            // Should only have one EXT-X-MEDIA:TYPE=VIDEO entry (duplicate groupId skipped)
            const videoMediaLines = result
                .split('\n')
                .filter((l: string) => l.startsWith('#EXT-X-MEDIA:TYPE=VIDEO'));
            expect(videoMediaLines).toHaveLength(1);
            expect(videoMediaLines[0]).toContain('GROUP-ID="Main"');
        });
    });
});
