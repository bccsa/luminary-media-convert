import { FfmpegService } from './ffmpeg.service.js';

describe('FfmpegService', () => {
    let service: FfmpegService;

    beforeEach(() => {
        service = new FfmpegService();
    });

    describe('GPU detection', () => {
        it('should default to GPU not available', () => {
            expect(service.isGpuAvailable()).toBe(false);
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
                'out_time=01:02:03.500000\n'
            );
            expect(result).toBe(3723.5);
        });

        it('should parse out_time with zero hours', () => {
            const result = parseProgressTime(
                'out_time=00:00:30.000000\n'
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
                'out_time_us=10000000\nout_time=00:00:10.000000\n'
            );
            expect(result).toBe(10);
        });
    });

    describe('buildVideoArgs (private, tested via reflection)', () => {
        const buildVideoArgs = (opts: any): string[] => {
            return (service as any).buildVideoArgs(opts);
        };

        it('should build CPU video args with correct structure', () => {
            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                renditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        audioBitrateKbps: 128,
                    },
                    {
                        width: 854,
                        height: 480,
                        videoBitrateKbps: 1000,
                        audioBitrateKbps: 96,
                    },
                ],
                segmentDuration: 6,
            });

            expect(args).toContain('-i');
            expect(args).toContain('/tmp/input.mp4');
            expect(args).toContain('-filter_complex');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');

            // CPU encoder
            expect(args).toContain('libx264');
            expect(args).not.toContain('h264_nvenc');

            // Filter should use regular scale, not scale_cuda
            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale=');
            expect(filterVal).not.toContain('scale_cuda');
            expect(filterVal).toContain('split=2');
        });

        it('should include -hwaccel cuda when GPU is available', () => {
            (service as any).gpuAvailable = true;

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                renditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        audioBitrateKbps: 128,
                    },
                ],
                segmentDuration: 6,
            });

            expect(args).toContain('-hwaccel');
            expect(args).toContain('cuda');
            expect(args).toContain('h264_nvenc');

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale_cuda');
        });

        it('should set correct audio codec and bitrate', () => {
            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                renditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        audioBitrateKbps: 192,
                        audioCodec: 'mp3',
                    },
                ],
                segmentDuration: 6,
            });

            expect(args).toContain('libmp3lame');
            expect(args).toContain('192k');
        });

        it('should default audio codec to aac', () => {
            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                renditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        audioBitrateKbps: 128,
                    },
                ],
                segmentDuration: 6,
            });

            expect(args).toContain('aac');
        });

        it('should set segment duration', () => {
            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                renditions: [
                    {
                        width: 1280,
                        height: 720,
                        videoBitrateKbps: 2500,
                        audioBitrateKbps: 128,
                    },
                ],
                segmentDuration: 10,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('10');
        });
    });

    describe('buildAudioArgs (private, tested via reflection)', () => {
        const buildAudioArgs = (opts: any): string[] => {
            return (service as any).buildAudioArgs(opts);
        };

        it('should build single-rendition audio args', () => {
            const args = buildAudioArgs({
                inputPath: '/tmp/audio.mp3',
                outputDir: '/tmp/output',
                renditions: [{ audioBitrateKbps: 128 }],
                segmentDuration: 6,
            });

            expect(args).toContain('-vn');
            expect(args).toContain('-i');
            expect(args).toContain('/tmp/audio.mp3');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('aac');
            expect(args).toContain('128k');
            // Single rendition should NOT have master playlist or var_stream_map
            expect(args).not.toContain('-master_pl_name');
            expect(args).not.toContain('-var_stream_map');
        });

        it('should build multi-rendition audio args with master playlist', () => {
            const args = buildAudioArgs({
                inputPath: '/tmp/audio.mp3',
                outputDir: '/tmp/output',
                renditions: [
                    { audioBitrateKbps: 192 },
                    { audioBitrateKbps: 96 },
                ],
                segmentDuration: 4,
            });

            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');
            expect(args).toContain('a:0 a:1');
        });

        it('should use mp3 codec when specified', () => {
            const args = buildAudioArgs({
                inputPath: '/tmp/audio.wav',
                outputDir: '/tmp/output',
                renditions: [{ audioBitrateKbps: 320, audioCodec: 'mp3' }],
                segmentDuration: 6,
            });

            expect(args).toContain('libmp3lame');
        });
    });
});
