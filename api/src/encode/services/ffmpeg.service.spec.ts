import { FfmpegService } from './ffmpeg.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
        const buildVideoArgs = (opts: any): string[] => {
            return (service as any).buildVideoArgs(opts);
        };

        it('should build CPU video args with correct structure', () => {
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

            const args = buildVideoArgs({
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

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale=');
            expect(filterVal).not.toContain('scale_cuda');
            expect(filterVal).toContain('split=2');

            // 720p -> faster, 480p -> fast
            const preset0Idx = args.indexOf('-preset:v:0');
            expect(args[preset0Idx + 1]).toBe('faster');
            const preset1Idx = args.indexOf('-preset:v:1');
            expect(args[preset1Idx + 1]).toBe('fast');
        });

        it('should include -hwaccel cuda when GPU is available', () => {
            (service as any).gpuAvailable = true;

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

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-hwaccel');
            expect(args).toContain('cuda');
            expect(args).toContain('h264_nvenc');

            const filterIdx = args.indexOf('-filter_complex');
            const filterVal = args[filterIdx + 1];
            expect(filterVal).toContain('scale_cuda');

            // 720p -> p5
            const presetIdx = args.indexOf('-preset:v:0');
            expect(args[presetIdx + 1]).toBe('p5');
        });

        it('should set correct audio codec and bitrate', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'video',
                segmentDuration: 6,
                videoRenditions: [
                    { width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd', label: '720p' },
                ],
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'mp3', sourceTrackIndex: 0 },
                ],
            };

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('libmp3lame');
            expect(args).toContain('192k');
        });

        it('should use copy codec for copyStream renditions', () => {
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

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('copy');
            expect(args).not.toContain('-filter_complex');
        });

        it('should set segment duration', () => {
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

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const hlsTimeIdx = args.indexOf('-hls_time');
            expect(args[hlsTimeIdx + 1]).toBe('10');
        });

        it('should include audio group and language in var_stream_map', () => {
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

            const args = buildVideoArgs({
                inputPath: '/tmp/input.mp4',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            const vsmIdx = args.indexOf('-var_stream_map');
            const vsmVal = args[vsmIdx + 1];
            expect(vsmVal).toContain('agroup:hd');
            expect(vsmVal).toContain('language:eng');
        });

        it('should use -ac:a:N to target audio streams correctly', () => {
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

            const args = buildVideoArgs({
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

    describe('fixMasterPlaylistAudioNames (private, tested via reflection)', () => {
        const fixMasterPlaylistAudioNames = (outputDir: string, config: EncodeConfigDto): void => {
            return (service as any).fixMasterPlaylistAudioNames(outputDir, config);
        };

        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'ffmpeg-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should handle FFmpeg group_ prefix on GROUP-IDs', () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_6",DEFAULT=YES,LANGUAGE="eng",CHANNELS="2",URI="stream_HD_Audio/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_mid",NAME="audio_7",DEFAULT=NO,LANGUAGE="eng",CHANNELS="2",URI="stream_Standard_Audio/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_low",NAME="audio_8",DEFAULT=NO,LANGUAGE="eng",CHANNELS="1",URI="stream_Low_Audio/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            fixMasterPlaylistAudioNames(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'mid', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'low', audioBitrateKbps: 64, channels: 1, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            const nameMatches = result.match(/NAME="([^"]+)"/g);
            expect(nameMatches).toEqual(['NAME="eng"', 'NAME="eng"', 'NAME="eng"']);
        });

        it('should also work with GROUP-IDs without the group_ prefix', () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="audio_2",DEFAULT=YES,LANGUAGE="eng",URI="stream_HD_Audio/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            fixMasterPlaylistAudioNames(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="eng"');
        });

        it('should set different NAMEs for audio groups from different source tracks', () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_eng",NAME="audio_2",DEFAULT=YES,LANGUAGE="eng",URI="stream_eng/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_spa",NAME="audio_3",DEFAULT=NO,LANGUAGE="spa",URI="stream_spa/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            fixMasterPlaylistAudioNames(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'eng', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                    { id: 'spa', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 1, language: 'spa' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="eng"');
            expect(result).toContain('NAME="spa"');
        });

        it('should fall back to "Audio" when no language is set', () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_2",DEFAULT=YES,URI="stream_hd/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            fixMasterPlaylistAudioNames(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('NAME="Audio"');
        });

        it('should not modify non-audio EXT-X-MEDIA lines', () => {
            const masterContent = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_2",DEFAULT=YES,URI="stream_hd/playlist.m3u8"',
            ].join('\n');
            writeFileSync(join(tmpDir, 'master.m3u8'), masterContent, 'utf-8');

            fixMasterPlaylistAudioNames(tmpDir, {
                type: 'video',
                audioGroups: [
                    { id: 'hd', audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, language: 'eng' },
                ],
            });

            const result = readFileSync(join(tmpDir, 'master.m3u8'), 'utf-8');
            expect(result).toContain('TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"');
            expect(result).toContain('TYPE=AUDIO,GROUP-ID="group_hd",NAME="eng"');
        });
    });

    describe('buildAudioArgs (private, tested via reflection)', () => {
        const buildAudioArgs = (opts: any): string[] => {
            return (service as any).buildAudioArgs(opts);
        };

        it('should build single-rendition audio args', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioRenditions: [
                    { audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0 },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.mp3',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-vn');
            expect(args).toContain('-i');
            expect(args).toContain('/tmp/audio.mp3');
            expect(args).toContain('-f');
            expect(args).toContain('hls');
            expect(args).toContain('aac');
            expect(args).toContain('128k');
            expect(args).not.toContain('-master_pl_name');
            expect(args).not.toContain('-var_stream_map');
        });

        it('should build multi-rendition audio args with master playlist', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 4,
                audioRenditions: [
                    { audioBitrateKbps: 192, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: '192kbps' },
                    { audioBitrateKbps: 96, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, label: '96kbps' },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.mp3',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('-master_pl_name');
            expect(args).toContain('master.m3u8');
            expect(args).toContain('-var_stream_map');
        });

        it('should use mp3 codec when specified', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioRenditions: [
                    { audioBitrateKbps: 320, channels: 2, audioCodec: 'mp3', sourceTrackIndex: 0 },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.wav',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('libmp3lame');
        });

        it('should use copy codec for copyStream audio renditions', () => {
            const encodeConfig: EncodeConfigDto = {
                type: 'audio',
                segmentDuration: 6,
                audioRenditions: [
                    { audioBitrateKbps: 128, channels: 2, audioCodec: 'aac', sourceTrackIndex: 0, copyStream: true },
                ],
            };

            const args = buildAudioArgs({
                inputPath: '/tmp/audio.mp3',
                outputDir: '/tmp/output',
                encodeConfig,
            });

            expect(args).toContain('copy');
            expect(args).not.toContain('aac');
        });
    });
});
