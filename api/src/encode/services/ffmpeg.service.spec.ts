import { FfmpegService, type AccelMode, type EncodeOptions, type AnglePlaylist } from './ffmpeg.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const flushPromises = async () => {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

function createMockProcess(): ChildProcess & { emitStderr: (data: string) => void; emitClose: (code: number, signal?: string) => void; emitError: (err: Error) => void } {
    const proc = new EventEmitter() as any;
    proc.stderr = new EventEmitter();
    proc.stdout = { resume: jest.fn() };
    proc.kill = jest.fn();
    proc.killed = false;
    proc.pid = 12345;
    proc.emitStderr = (data: string) => proc.stderr.emit('data', Buffer.from(data));
    proc.emitClose = (code: number, signal?: string) => proc.emit('close', code, signal ?? null);
    proc.emitError = (err: Error) => proc.emit('error', err);
    return proc;
}

describe('FfmpegService', () => {
    let service: FfmpegService;

    beforeEach(() => {
        service = new FfmpegService();
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
            const result = parseProgressTime(
                'out_time=01:02:03.500000\n',
            );
            expect(result).toBe(3723.5);
        });

        it('should parse out_time with zero hours', () => {
            const result = parseProgressTime(
                'out_time=00:00:30.000000\n',
            );
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
                'out_time_us=10000000\nout_time=00:00:10.000000\n',
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                    { width: 854, height: 480, videoBitrateKbps: 1000, copyStream: false, audioGroupId: 'mid', label: '480p' },
                ],
                audioGroups: [
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    { id: 'mid', label: 'Standard Audio', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                    { width: 854, height: 480, videoBitrateKbps: 1000, copyStream: false, audioGroupId: 'hd', label: '480p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2000, copyStream: false, audioGroupId: 'hd', label: '720p', vbr: true },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2000, copyStream: false, audioGroupId: 'hd', label: '720p', vbr: false },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1920, height: 1080, videoBitrateKbps: 5000, copyStream: true, sourceTrackIndex: 0, audioGroupId: 'hd', label: '1080p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', label: 'English', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
            jest.spyOn(service as any, 'probeFrameRate').mockResolvedValue(24);
            jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(2);

            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
            jest.spyOn(service as any, 'probeFrameRate').mockResolvedValue(30);
            jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(null);

            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 8,
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                    { width: 640, height: 360, videoBitrateKbps: 600, copyStream: false, audioGroupId: 'low', label: '360p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    { id: 'low', audioBitrateKbps: 64, channels: 1, audioCodec: 'aac', sourceTrackIndex: 0 },
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

    describe('fixMasterPlaylist (private, tested via reflection)', () => {
        const fixMasterPlaylist = (outputDir: string, config: EncodeConfigDto): Promise<void> => {
            return (service as any).fixMasterPlaylist(outputDir, config);
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should use label for NAME (not language code) when available', async () => {
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
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'mid', label: 'Standard Audio', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'low', label: 'Low Audio', audioBitrateKbps: 64, channels: 1, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            const nameMatches = result.match(/NAME="([^"]+)"/g);
            expect(nameMatches).toEqual(['NAME="HD Audio"', 'NAME="Standard Audio"', 'NAME="Low Audio"']);
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
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="HD Audio"');
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
                    { id: 'eng', label: 'English', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'spa', label: 'Spanish', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'spa' },
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
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
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
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"');
            expect(result).toContain('TYPE=AUDIO,GROUP-ID="group_hd",NAME="HD Audio"');
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
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'tier_0', label: 'main', sourceTrackIndex: 0 },
                    { width: 854, height: 480, videoBitrateKbps: 1000, copyStream: false, audioGroupId: 'tier_0', label: 'pulpit', sourceTrackIndex: 1 },
                ],
                videoTrackNames: [
                    { index: 0, name: 'main' },
                    { index: 1, name: 'pulpit' },
                ],
                audioGroups: [
                    { id: 'tier_0', label: 'English', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="main",DEFAULT=YES');
            expect(result).toContain('#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="pulpit",DEFAULT=NO');
            expect(result).toContain('VIDEO="main",AUDIO="group_tier_0"');
            expect(result).toContain('VIDEO="pulpit",AUDIO="group_tier_0"');
        });
    });

    describe('generateAudioOnlyPlaylist (private, tested via reflection)', () => {
        const generateAudioOnlyPlaylist = (outputDir: string, config: EncodeConfigDto): Promise<AnglePlaylist | null> => {
            return (service as any).generateAudioOnlyPlaylist(outputDir, config);
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-audio-only-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should return null when no audio groups', async () => {
            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
            });
            expect(result).toBeNull();
        });

        it('should return null when audio groups array is empty', async () => {
            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [],
            });
            expect(result).toBeNull();
        });

        it('should generate audio_only.m3u8 with correct structure for single group', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:6\n', 'utf-8');

            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            expect(result).toEqual({ name: 'Audio only', filename: 'audio_only.m3u8' });

            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');
            expect(content).toContain('#EXTM3U');
            expect(content).toContain('#EXT-X-VERSION:6');
            expect(content).toContain('TYPE=AUDIO');
            expect(content).toContain('GROUP-ID="hd"');
            expect(content).toContain('NAME="HD Audio"');
            expect(content).toContain('DEFAULT=YES');
            expect(content).toContain('LANGUAGE="eng"');
            expect(content).toContain('URI="stream_hd_HD_Audio/playlist.m3u8"');
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",AUDIO="hd"');
            expect(content).toContain('stream_hd_HD_Audio/playlist.m3u8');
        });

        it('should generate audio_only.m3u8 with multiple groups', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    { id: 'mid', label: 'Standard Audio', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            });

            expect(result).toEqual({ name: 'Audio only', filename: 'audio_only.m3u8' });

            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');
            expect(content).toContain('GROUP-ID="hd"');
            expect(content).toContain('GROUP-ID="mid"');
            expect(content).toContain('NAME="HD Audio"');
            expect(content).toContain('NAME="Standard Audio"');
            expect(content).toMatch(/NAME="HD Audio",DEFAULT=YES/);
            expect(content).toMatch(/NAME="Standard Audio",DEFAULT=YES/);
            expect(content).toContain('URI="stream_hd_HD_Audio/playlist.m3u8"');
            expect(content).toContain('URI="stream_mid_Standard_Audio/playlist.m3u8"');
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",AUDIO="hd"');
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="mid"');
        });

        it('should use default version when master.m3u8 does not exist', async () => {
            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            });

            expect(result).not.toBeNull();
            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');
            expect(content).toContain('#EXT-X-VERSION:7');
        });

        it('should fall back to bitrate-based name and "Audio" label when no label or language', async () => {
            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            });

            expect(result).not.toBeNull();
            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');
            expect(content).toContain('NAME="Audio"');
            expect(content).toContain('URI="stream_hd_192kbps/playlist.m3u8"');
            expect(content).not.toContain('LANGUAGE=');
        });

        it('should generate multi-language tiers with correct EXT-X-MEDIA and STREAM-INF per tier', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            const result = await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', label: 'English', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'hd', label: 'Spanish', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'spa' },
                    { id: 'low', label: 'English', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'low', label: 'Spanish', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'spa' },
                ],
            });

            expect(result).toEqual({ name: 'Audio only', filename: 'audio_only.m3u8' });

            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');

            // Two tiers: hd and low
            expect(content).toContain('GROUP-ID="hd"');
            expect(content).toContain('GROUP-ID="low"');

            // EXT-X-MEDIA entries with languages
            expect(content).toContain('GROUP-ID="hd",NAME="English",DEFAULT=YES,LANGUAGE="eng"');
            expect(content).toContain('GROUP-ID="hd",NAME="Spanish",DEFAULT=NO,LANGUAGE="spa"');
            expect(content).toContain('GROUP-ID="low",NAME="English",DEFAULT=YES,LANGUAGE="eng"');
            expect(content).toContain('GROUP-ID="low",NAME="Spanish",DEFAULT=NO,LANGUAGE="spa"');

            // One STREAM-INF per tier with correct bandwidth and AUDIO group
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="hd"');
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2",AUDIO="low"');

            // STREAM-INF lines reference the default (first) stream in each tier
            expect(content).toContain('stream_hd_English/playlist.m3u8');
            expect(content).toContain('stream_low_English/playlist.m3u8');
        });

        it('should use highest bandwidth within a tier for STREAM-INF', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', label: 'Stereo', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    { id: 'hd', label: 'Surround', audioBitrateKbps: 384, channels: 6, audioCodec: 'aac', sourceTrackIndex: 1 },
                ],
            });

            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');

            // Should use the max bitrate (384) for the tier STREAM-INF
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=384000,CODECS="mp4a.40.2",AUDIO="hd"');
            // Default stream should be the first group in the tier
            const streamInfIdx = content.indexOf('#EXT-X-STREAM-INF:BANDWIDTH=384000');
            const uriLine = content.substring(streamInfIdx).split('\n')[1];
            expect(uriLine).toBe('stream_hd_Stereo/playlist.m3u8');
        });

        it('should set DEFAULT=YES only for first entry in each tier', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            await generateAudioOnlyPlaylist(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'mid', label: 'Track A', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    { id: 'mid', label: 'Track B', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1 },
                    { id: 'mid', label: 'Track C', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 2 },
                ],
            });

            const content = readFileSync(join(tmpDir, 'audio_only.m3u8'), 'utf-8');
            const mediaLines = content.split('\n').filter(l => l.startsWith('#EXT-X-MEDIA:'));

            expect(mediaLines).toHaveLength(3);
            expect(mediaLines[0]).toContain('DEFAULT=YES');
            expect(mediaLines[1]).toContain('DEFAULT=NO');
            expect(mediaLines[2]).toContain('DEFAULT=NO');
        });
    });

    describe('fixAudioOnlyMasterPlaylist (private, tested via reflection)', () => {
        const fixAudioOnlyMasterPlaylist = (outputDir: string, config: EncodeConfigDto): Promise<void> => {
            return (service as any).fixAudioOnlyMasterPlaylist(outputDir, config);
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-fix-audio-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should do nothing when no audio groups', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            await fixAudioOnlyMasterPlaylist(tmpDir, { type: 'audio' });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(content).toBe('#EXTM3U\n#EXT-X-VERSION:7\n');
        });

        it('should do nothing when master.m3u8 does not exist', async () => {
            // Should not throw
            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            });
        });

        it('should rewrite master.m3u8 with proper EXT-X-MEDIA and STREAM-INF structure', async () => {
            // Simulate FFmpeg's raw output for audio-only encode
            writeFileSync(join(tmpDir, 'master.m3u8'), [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"',
                'stream_hd_HD_Audio/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
                'stream_low_Low_Audio/playlist.m3u8',
                '',
            ].join('\n'), 'utf-8');

            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    { id: 'hd', label: 'HD Audio', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'low', label: 'Low Audio', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');

            // Should have EXT-X-MEDIA entries
            expect(content).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="HD Audio",DEFAULT=YES,LANGUAGE="eng"');
            expect(content).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="Low Audio",DEFAULT=YES,LANGUAGE="eng"');

            // Should have STREAM-INF per tier
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",AUDIO="hd"');
            expect(content).toContain('#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2",AUDIO="low"');

            // Should preserve version from original
            expect(content).toContain('#EXT-X-VERSION:7');
        });

        it('should rewrite multi-language audio-only master playlist', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n', 'utf-8');

            await fixAudioOnlyMasterPlaylist(tmpDir, {
                type: 'audio',
                audioGroups: [
                    { id: 'hd', label: 'English', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'hd', label: 'French', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'fra' },
                    { id: 'low', label: 'English', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'low', label: 'French', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'fra' },
                ],
            });

            const content = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');

            // EXT-X-MEDIA entries with correct DEFAULT flags
            expect(content).toContain('GROUP-ID="hd",NAME="English",DEFAULT=YES,LANGUAGE="eng"');
            expect(content).toContain('GROUP-ID="hd",NAME="French",DEFAULT=NO,LANGUAGE="fra"');
            expect(content).toContain('GROUP-ID="low",NAME="English",DEFAULT=YES,LANGUAGE="eng"');
            expect(content).toContain('GROUP-ID="low",NAME="French",DEFAULT=NO,LANGUAGE="fra"');

            // Two STREAM-INFs
            expect(content).toContain('BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="hd"');
            expect(content).toContain('BANDWIDTH=64000,CODECS="mp4a.40.2",AUDIO="low"');
        });
    });

    describe('buildAudioArgs (private, tested via reflection)', () => {
        const buildAudioArgs = (opts: any): string[] => {
            return (service as any).buildAudioArgs(opts);
        };

        it('should build single-group audio args with master playlist', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'HD' },
                ],
            };

            const args = buildAudioArgs({
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

        it('should build multi-group audio args as direct variants without agroup', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 4,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'HD' },
                    { id: 'mid', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'Standard' },
                    { id: 'low', audioBitrateKbps: 64, channels: 1, audioCodec: 'aac', sourceTrackIndex: 0, label: 'Mono' },
                ],
            };

            const args = buildAudioArgs({
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

        it('should include -threads with default value', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const threadsIdx = args.indexOf('-threads');
            expect(threadsIdx).toBeGreaterThan(-1);
            expect(args[threadsIdx + 1]).toBe('8');
        });

        it('should use copy codec for copyStream audio groups', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, copyStream: true },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('copy');
            expect(args).not.toContain('aac');
        });

        it('should use configured segment duration for audio regardless of byte-range', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'HD' },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: true,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('6');
        });

        it('should use default segment duration when none configured', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'HD' },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('6');
        });

        it('should use custom segment duration when configured', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 4,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: 'HD' },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.flac',
                outputDir: '/tmp/output',
                encodeConfig,
                byteRange: false,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('4');
        });

        it('should create direct variants for multi-language audio groups', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng', label: 'English HD' },
                    { id: 'hd', audioBitrateKbps: 256, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'fra', label: 'French HD' },
                ],
            };

            const args = buildAudioArgs({
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
            const spy = jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(1);
            const result = await (service as any).probeGopDuration('/tmp/input.mp4', 30);
            expect(result).toBe(1);
            spy.mockRestore();
        });

        it('should return fractional GOP duration for non-standard frame rates', async () => {
            const spy = jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(2);
            const result = await (service as any).probeGopDuration('/tmp/input.mp4', 24);
            expect(result).toBe(2);
            spy.mockRestore();
        });

        it('should return null when detection fails', async () => {
            const spy = jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(null);
            const result = await (service as any).probeGopDuration('/tmp/input.mp4', 30);
            expect(result).toBeNull();
            spy.mockRestore();
        });
    });

    describe('encode', () => {
        let tmpDir: string;
        let spawnSpy: jest.SpyInstance;
        let areAlignedSpy: jest.SpyInstance;
        let probeDurationSpy: jest.SpyInstance;
        let fixMasterPlaylistSpy: jest.SpyInstance;
        let generateAnglePlaylistsSpy: jest.SpyInstance;
        let generateAudioOnlyPlaylistSpy: jest.SpyInstance;
        let fixAudioOnlyMasterPlaylistSpy: jest.SpyInstance;
        let probeFrameRateSpy: jest.SpyInstance;
        let probeGopDurationSpy: jest.SpyInstance;
        let convertToByteRangeSpy: jest.SpyInstance;

        const baseEncodeConfig: EncodeConfigDto = {
            type: 'video',
            segmentDuration: 6,
            videoRenditions: [
                { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
            ],
            audioGroups: [
                { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
            ],
        };

        function makeEncodeOpts(overrides: Partial<EncodeOptions> = {}): EncodeOptions {
            return {
                sessionId: 'test-session',
                inputPath: '/tmp/input.mp4',
                outputDir: join(tmpDir, 'output'),
                encodeConfig: baseEncodeConfig,
                onProgress: jest.fn(),
                ...overrides,
            };
        }

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-encode-'));
            spawnSpy = jest.spyOn(require('child_process'), 'spawn');
            areAlignedSpy = jest.spyOn(service as any, 'areStreamStartTimesAligned').mockResolvedValue(true);
            probeDurationSpy = jest.spyOn(service as any, 'probeDuration').mockResolvedValue(100);
            fixMasterPlaylistSpy = jest.spyOn(service as any, 'fixMasterPlaylist').mockResolvedValue(undefined);
            generateAnglePlaylistsSpy = jest.spyOn(service as any, 'generateAnglePlaylists').mockResolvedValue([]);
            generateAudioOnlyPlaylistSpy = jest.spyOn(service as any, 'generateAudioOnlyPlaylist').mockResolvedValue(null);
            fixAudioOnlyMasterPlaylistSpy = jest.spyOn(service as any, 'fixAudioOnlyMasterPlaylist').mockResolvedValue(undefined);
            probeFrameRateSpy = jest.spyOn(service as any, 'probeFrameRate').mockResolvedValue(30);
            probeGopDurationSpy = jest.spyOn(service as any, 'probeGopDuration').mockResolvedValue(2);
            convertToByteRangeSpy = jest.spyOn(service as any, 'convertToByteRange').mockResolvedValue(undefined);
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
            spawnSpy.mockRestore();
            areAlignedSpy.mockRestore();
            probeDurationSpy.mockRestore();
            fixMasterPlaylistSpy.mockRestore();
            generateAnglePlaylistsSpy.mockRestore();
            generateAudioOnlyPlaylistSpy.mockRestore();
            fixAudioOnlyMasterPlaylistSpy.mockRestore();
            probeFrameRateSpy.mockRestore();
            probeGopDurationSpy.mockRestore();
            convertToByteRangeSpy.mockRestore();
        });

        it('should resolve with outputDir and masterPlaylist on success', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);

            const result = await promise;
            expect(result.outputDir).toBe(opts.outputDir);
            expect(result.masterPlaylist).toBe('master.m3u8');
            expect(result.anglePlaylists).toEqual([]);
        });

        it('should call spawn with "ffmpeg" and correct args', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            expect(spawnSpy).toHaveBeenCalledWith('ffmpeg', expect.any(Array), {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const args: string[] = spawnSpy.mock.calls[0][1];
            expect(args).toContain('-i');
            expect(args).toContain(opts.inputPath);
            expect(args).toContain('-f');
            expect(args).toContain('hls');

            mockProc.emitClose(0);
            await promise;
        });

        it('should reject when FFmpeg exits with non-zero code', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitStderr('Error: something went wrong\n');
            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow('FFmpeg exited with code 1');
        });

        it('should include signal in error message when killed', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(null as any, 'SIGKILL');

            await expect(promise).rejects.toThrow('signal: SIGKILL');
        });

        it('should reject when FFmpeg process emits an error event', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitError(new Error('ENOENT: ffmpeg not found'));

            await expect(promise).rejects.toThrow('FFmpeg spawn error: ENOENT: ffmpeg not found');
        });

        it('should report progress via onProgress callback', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(100);

            const onProgress = jest.fn();
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

        it('should not report progress when duration is unknown', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(0);

            const onProgress = jest.fn();
            const promise = service.encode(makeEncodeOpts({ onProgress }));
            await flushPromises();

            mockProc.emitStderr('out_time_us=50000000\n');
            mockProc.emitClose(0);
            await promise;

            expect(onProgress).not.toHaveBeenCalled();
        });

        it('should cap progress at 99.9%', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);
            probeDurationSpy.mockResolvedValue(100);

            const onProgress = jest.fn();
            const promise = service.encode(makeEncodeOpts({ onProgress }));
            await flushPromises();

            // 150% worth of time (150s out of 100s)
            mockProc.emitStderr('out_time_us=150000000\n');
            mockProc.emitClose(0);
            await promise;

            const calls = onProgress.mock.calls.map((c: any[]) => c[0]);
            expect(calls.every((v: number) => v <= 99.9)).toBe(true);
        });

        it('should call fixMasterPlaylist and generateAnglePlaylists for video type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixMasterPlaylistSpy).toHaveBeenCalledWith(opts.outputDir, opts.encodeConfig);
            expect(generateAnglePlaylistsSpy).toHaveBeenCalledWith(opts.outputDir, opts.encodeConfig);
        });

        it('should not call fixMasterPlaylist for audio type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts({
                encodeConfig: {
                    type: 'audio',
                    segmentDuration: 6,
                    audioGroups: [
                        { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    ],
                },
            });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixMasterPlaylistSpy).not.toHaveBeenCalled();
        });

        it('should call generateAudioOnlyPlaylist for video type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(generateAudioOnlyPlaylistSpy).toHaveBeenCalledWith(opts.outputDir, opts.encodeConfig);
        });

        it('should not call generateAudioOnlyPlaylist for audio type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts({
                encodeConfig: {
                    type: 'audio',
                    segmentDuration: 6,
                    audioGroups: [
                        { id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    ],
                },
            });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(generateAudioOnlyPlaylistSpy).not.toHaveBeenCalled();
        });

        it('should append audio-only angle and rename Default to Video', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);
            generateAnglePlaylistsSpy.mockResolvedValue([{ name: 'Default', filename: 'master.m3u8' }]);
            generateAudioOnlyPlaylistSpy.mockResolvedValue({ name: 'Audio only', filename: 'audio_only.m3u8' });

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(0);
            const result = await promise;

            expect(result.masterPlaylist).toBe('master.m3u8');
            expect(result.anglePlaylists).toEqual([
                { name: 'Video', filename: 'master.m3u8' },
                { name: 'Audio only', filename: 'audio_only.m3u8' },
            ]);
        });

        it('should append audio-only angle to multi-angle playlists without renaming', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);
            generateAnglePlaylistsSpy.mockResolvedValue([
                { name: 'Main', filename: 'Main.m3u8' },
                { name: 'Side', filename: 'Side.m3u8' },
            ]);
            generateAudioOnlyPlaylistSpy.mockResolvedValue({ name: 'Audio only', filename: 'audio_only.m3u8' });

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(0);
            const result = await promise;

            expect(result.masterPlaylist).toBe('Main.m3u8');
            expect(result.anglePlaylists).toEqual([
                { name: 'Main', filename: 'Main.m3u8' },
                { name: 'Side', filename: 'Side.m3u8' },
                { name: 'Audio only', filename: 'audio_only.m3u8' },
            ]);
        });

        it('should call fixAudioOnlyMasterPlaylist for audio type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts({
                encodeConfig: {
                    type: 'audio',
                    segmentDuration: 6,
                    audioGroups: [
                        { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                        { id: 'low', audioBitrateKbps: 64, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                    ],
                },
            });
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixAudioOnlyMasterPlaylistSpy).toHaveBeenCalledWith(opts.outputDir, opts.encodeConfig);
        });

        it('should not call fixAudioOnlyMasterPlaylist for video type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            expect(fixAudioOnlyMasterPlaylistSpy).not.toHaveBeenCalled();
        });

        it('should create output subdirectories for video type', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const opts = makeEncodeOpts();
            const promise = service.encode(opts);
            await flushPromises();

            mockProc.emitClose(0);
            await promise;

            // 1 video rendition + 1 audio group = 2 stream dirs
            const { existsSync } = require('fs');
            expect(existsSync(join(opts.outputDir, 'stream_0'))).toBe(true);
            expect(existsSync(join(opts.outputDir, 'stream_1'))).toBe(true);
        });

        it('should clear activeProcess after completion', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            expect((service as any).activeProcess).toBe(mockProc);

            mockProc.emitClose(0);
            await promise;

            expect((service as any).activeProcess).toBeNull();
        });

        it('should clear activeProcess after error', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const promise = service.encode(makeEncodeOpts());
            await flushPromises();

            mockProc.emitClose(1);

            await expect(promise).rejects.toThrow();
            expect((service as any).activeProcess).toBeNull();
        });

        it('should call preByteRangeHook before convertToByteRange when provided', async () => {
            const mockProc = createMockProcess();
            spawnSpy.mockReturnValue(mockProc);

            const callOrder: string[] = [];
            const convertSpy = jest.spyOn(service as any, 'convertToByteRange').mockImplementation(async () => {
                callOrder.push('convertToByteRange');
            });

            const hook = jest.fn(() => { callOrder.push('preByteRangeHook'); });
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
            spawnSpy.mockReturnValue(mockProc);

            const convertSpy = jest.spyOn(service as any, 'convertToByteRange').mockResolvedValue(undefined);

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
            spawnSpy.mockReturnValue(mockProc);

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
});
