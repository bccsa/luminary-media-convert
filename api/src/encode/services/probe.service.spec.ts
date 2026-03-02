import { execSync } from 'child_process';
import { ProbeService } from './probe.service.js';

jest.mock('child_process', () => ({
    execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

function makeFfprobeOutput(overrides: {
    streams?: any[];
    format?: Record<string, any>;
} = {}): string {
    return JSON.stringify({
        streams: overrides.streams ?? [
            {
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                width: 1920,
                height: 1080,
                bit_rate: '5000000',
                avg_frame_rate: '30000/1001',
                profile: 'High',
                tags: { language: 'eng', title: 'Main' },
            },
            {
                index: 1,
                codec_type: 'audio',
                codec_name: 'aac',
                bit_rate: '192000',
                channels: 2,
                sample_rate: '48000',
                tags: { language: 'eng', title: 'Stereo' },
            },
        ],
        format: {
            duration: '120.5',
            bit_rate: '5200000',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            ...overrides.format,
        },
    });
}

describe('ProbeService', () => {
    let service: ProbeService;

    beforeEach(() => {
        service = new ProbeService();
        mockExecSync.mockReset();
    });

    describe('probe', () => {
        it('should parse a standard MP4 with 1 video + 1 audio track', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput());

            const result = service.probe('/tmp/test.mp4');

            expect(result.format.duration).toBe(120.5);
            expect(result.format.bitrateKbps).toBe(5200);
            expect(result.format.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2');

            expect(result.videoTracks).toHaveLength(1);
            expect(result.videoTracks[0]).toMatchObject({
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrateKbps: 5000,
                frameRate: 29.97,
                profile: 'High',
                language: 'eng',
                name: 'Main',
            });

            expect(result.audioTracks).toHaveLength(1);
            expect(result.audioTracks[0]).toMatchObject({
                index: 0,
                codec: 'aac',
                bitrateKbps: 192,
                channels: 2,
                sampleRate: 48000,
                language: 'eng',
                name: 'Stereo',
            });
        });

        it('should handle multiple video and audio tracks', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, bit_rate: '5000000', avg_frame_rate: '24/1' },
                    { index: 1, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, bit_rate: '2500000', avg_frame_rate: '24/1' },
                    { index: 2, codec_type: 'audio', codec_name: 'aac', bit_rate: '192000', channels: 2, sample_rate: '48000', tags: { language: 'eng' } },
                    { index: 3, codec_type: 'audio', codec_name: 'aac', bit_rate: '192000', channels: 2, sample_rate: '48000', tags: { language: 'fra' } },
                ],
            }));

            const result = service.probe('/tmp/multi.mp4');

            expect(result.videoTracks).toHaveLength(2);
            expect(result.videoTracks[0].index).toBe(0);
            expect(result.videoTracks[1].index).toBe(1);
            expect(result.videoTracks[1].width).toBe(1280);

            expect(result.audioTracks).toHaveLength(2);
            expect(result.audioTracks[0].language).toBe('eng');
            expect(result.audioTracks[1].language).toBe('fra');
        });

        it('should fall back to BPS tag when bit_rate is missing', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', tags: { BPS: '4500000' } },
                    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', tags: { BPS: '128000' } },
                ],
            }));

            const result = service.probe('/tmp/mkv.mkv');

            expect(result.videoTracks[0].bitrateKbps).toBe(4500);
            expect(result.audioTracks[0].bitrateKbps).toBe(128);
        });

        it('should fall back to NUMBER_OF_BYTES / DURATION tags for bitrate', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    {
                        index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1',
                        tags: { NUMBER_OF_BYTES: '50000000', DURATION: '00:01:00.000' },
                    },
                    {
                        index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000',
                        tags: { NUMBER_OF_BYTES: '1200000', DURATION: '00:01:00.000' },
                    },
                ],
            }));

            const result = service.probe('/tmp/test.mkv');

            // 50000000 bytes * 8 bits / 60s / 1000 = 6667 kbps
            expect(result.videoTracks[0].bitrateKbps).toBe(6667);
            // 1200000 * 8 / 60 / 1000 = 160
            expect(result.audioTracks[0].bitrateKbps).toBe(160);
        });

        it('should trigger packet-based bitrate computation when stream bitrates are 0', () => {
            const calls: string[] = [];
            mockExecSync.mockImplementation((cmd: any) => {
                const cmdStr = String(cmd);
                calls.push(cmdStr);
                if (cmdStr.includes('-show_format -show_streams')) {
                    return makeFfprobeOutput({
                        streams: [
                            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
                            { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
                        ],
                        format: { duration: '60.0', bit_rate: '5000000', format_name: 'matroska,webm' },
                    });
                }
                if (cmdStr.includes('-show_entries packet=stream_index,size')) {
                    return '0,100000\n0,100000\n0,100000\n1,10000\n1,10000\n';
                }
                return '';
            });

            const result = service.probe('/tmp/test.mkv');

            expect(calls.length).toBe(2);
            // 300000 bytes * 8 / 60s / 1000 = 40 kbps for video
            expect(result.videoTracks[0].bitrateKbps).toBe(40);
            // 20000 bytes * 8 / 60s / 1000 ≈ 3 kbps for audio
            expect(result.audioTracks[0].bitrateKbps).toBe(3);
        });

        it('should skip packet computation when duration is zero', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
                ],
                format: { duration: '0', bit_rate: '0', format_name: 'mp4' },
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].bitrateKbps).toBe(0);
            // execSync should only be called once (for the initial probe, not for packets)
            expect(mockExecSync).toHaveBeenCalledTimes(1);
        });

        it('should return "unknown" codec when codec_name is absent', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'video', width: 640, height: 480, bit_rate: '1000000', avg_frame_rate: '25/1' },
                    { index: 1, codec_type: 'audio', bit_rate: '64000', channels: 1, sample_rate: '22050' },
                ],
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].codec).toBe('unknown');
            expect(result.audioTracks[0].codec).toBe('unknown');
        });

        it('should default channels to 2 and sampleRate to 44100 when absent', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' },
                ],
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.audioTracks[0].channels).toBe(2);
            expect(result.audioTracks[0].sampleRate).toBe(44100);
        });

        it('should return unknown format name when absent', () => {
            mockExecSync.mockReturnValue(JSON.stringify({
                streams: [],
                format: { duration: '10.0', bit_rate: '1000' },
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.format.formatName).toBe('unknown');
        });

        it('should return zero duration and bitrate when format fields are missing', () => {
            mockExecSync.mockReturnValue(JSON.stringify({
                streams: [],
                format: {},
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.format.duration).toBe(0);
            expect(result.format.bitrateKbps).toBe(0);
        });

        it('should skip non-audio/video streams', () => {
            mockExecSync.mockReturnValue(makeFfprobeOutput({
                streams: [
                    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, bit_rate: '5000000', avg_frame_rate: '30/1' },
                    { index: 1, codec_type: 'subtitle', codec_name: 'srt' },
                    { index: 2, codec_type: 'data', codec_name: 'unknown' },
                    { index: 3, codec_type: 'audio', codec_name: 'aac', bit_rate: '128000', channels: 2, sample_rate: '44100' },
                ],
            }));

            const result = service.probe('/tmp/test.mp4');

            expect(result.videoTracks).toHaveLength(1);
            expect(result.audioTracks).toHaveLength(1);
        });

        it('should throw when ffprobe command fails', () => {
            mockExecSync.mockImplementation(() => {
                throw new Error('ffprobe not found');
            });

            expect(() => service.probe('/tmp/test.mp4')).toThrow('ffprobe not found');
        });

        it('should handle packet computation failure gracefully', () => {
            let callCount = 0;
            mockExecSync.mockImplementation((cmd: any) => {
                callCount++;
                if (callCount === 1) {
                    return makeFfprobeOutput({
                        streams: [
                            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
                        ],
                        format: { duration: '60.0', bit_rate: '5000000', format_name: 'matroska' },
                    });
                }
                throw new Error('packet probe failed');
            });

            const result = service.probe('/tmp/test.mkv');

            expect(result.videoTracks[0].bitrateKbps).toBe(0);
        });
    });

    describe('parseDurationTag (private)', () => {
        const parseDurationTag = (duration: string): number => {
            return (service as any).parseDurationTag(duration);
        };

        it('should parse HH:MM:SS.ms format', () => {
            expect(parseDurationTag('01:30:45.500')).toBe(5445.5);
        });

        it('should parse zero duration', () => {
            expect(parseDurationTag('00:00:00.000')).toBe(0);
        });

        it('should return 0 for invalid format', () => {
            expect(parseDurationTag('invalid')).toBe(0);
            expect(parseDurationTag('')).toBe(0);
        });
    });

    describe('parseFrameRate (private)', () => {
        const parseFrameRate = (rate: string): number => {
            return (service as any).parseFrameRate(rate);
        };

        it('should parse fractional frame rates', () => {
            expect(parseFrameRate('30000/1001')).toBe(29.97);
            expect(parseFrameRate('24000/1001')).toBe(23.98);
        });

        it('should parse integer frame rates', () => {
            expect(parseFrameRate('30/1')).toBe(30);
            expect(parseFrameRate('25/1')).toBe(25);
        });

        it('should return 0 for 0/0', () => {
            expect(parseFrameRate('0/0')).toBe(0);
        });

        it('should handle plain number string', () => {
            expect(parseFrameRate('29.97')).toBe(29.97);
        });

        it('should return 0 for non-parseable string', () => {
            expect(parseFrameRate('invalid')).toBe(0);
        });
    });

    describe('extractBitrateKbps (private)', () => {
        const extractBitrateKbps = (stream: any): number => {
            return (service as any).extractBitrateKbps(stream);
        };

        it('should prefer bit_rate field', () => {
            expect(extractBitrateKbps({ bit_rate: '5000000' })).toBe(5000);
        });

        it('should fall back to BPS tag', () => {
            expect(extractBitrateKbps({ tags: { BPS: '3000000' } })).toBe(3000);
        });

        it('should fall back to NUMBER_OF_BYTES / DURATION', () => {
            expect(extractBitrateKbps({
                tags: { NUMBER_OF_BYTES: '7500000', DURATION: '00:01:00.000' },
            })).toBe(1000);
        });

        it('should return 0 when no bitrate info is available', () => {
            expect(extractBitrateKbps({})).toBe(0);
            expect(extractBitrateKbps({ tags: {} })).toBe(0);
        });

        it('should return 0 when DURATION tag cannot be parsed', () => {
            expect(extractBitrateKbps({
                tags: { NUMBER_OF_BYTES: '7500000', DURATION: 'invalid' },
            })).toBe(0);
        });
    });
});
