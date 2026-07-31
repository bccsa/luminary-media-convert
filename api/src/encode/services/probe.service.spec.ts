import { type MockedFunction } from 'vitest';
import { execFile } from 'child_process';
import { ProbeService } from './probe.service.js';

vi.mock('child_process', () => ({
    execFile: vi.fn(),
}));

const mockExecFile = execFile as unknown as MockedFunction<
    (
        cmd: string,
        args: string[],
        opts: any,
        cb: (
            err: Error | null,
            result: { stdout: string; stderr: string }
        ) => void
    ) => void
>;

function mockExecFileResult(stdout: string) {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        cb(null, { stdout, stderr: '' });
    });
}

function mockExecFileSequence(results: Array<string | Error>) {
    let callIndex = 0;
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        const result = results[callIndex++];
        if (result instanceof Error) {
            cb(result, { stdout: '', stderr: '' });
        } else {
            cb(null, { stdout: result, stderr: '' });
        }
    });
}

function makeFfprobeOutput(
    overrides: {
        streams?: any[];
        format?: Record<string, any>;
    } = {}
): string {
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
        mockExecFile.mockReset();
    });

    describe('probe', () => {
        it('should parse a standard MP4 with 1 video + 1 audio track', async () => {
            mockExecFileResult(makeFfprobeOutput());

            const result = await service.probe('/tmp/test.mp4');

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

        it('should handle multiple video and audio tracks', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            bit_rate: '5000000',
                            avg_frame_rate: '24/1',
                        },
                        {
                            index: 1,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1280,
                            height: 720,
                            bit_rate: '2500000',
                            avg_frame_rate: '24/1',
                        },
                        {
                            index: 2,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '192000',
                            channels: 2,
                            sample_rate: '48000',
                            tags: { language: 'eng' },
                        },
                        {
                            index: 3,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '192000',
                            channels: 2,
                            sample_rate: '48000',
                            tags: { language: 'fra' },
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/multi.mp4');

            expect(result.videoTracks).toHaveLength(2);
            expect(result.videoTracks[0].index).toBe(0);
            expect(result.videoTracks[1].index).toBe(1);
            expect(result.videoTracks[1].width).toBe(1280);

            expect(result.audioTracks).toHaveLength(2);
            expect(result.audioTracks[0].language).toBe('eng');
            expect(result.audioTracks[1].language).toBe('fra');
        });

        it('should fall back to BPS tag when bit_rate is missing', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                            tags: { BPS: '4500000' },
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                            tags: { BPS: '128000' },
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/mkv.mkv');

            expect(result.videoTracks[0].bitrateKbps).toBe(4500);
            expect(result.audioTracks[0].bitrateKbps).toBe(128);
        });

        it('should fall back to NUMBER_OF_BYTES / DURATION tags for bitrate', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                            tags: {
                                NUMBER_OF_BYTES: '50000000',
                                DURATION: '00:01:00.000',
                            },
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                            tags: {
                                NUMBER_OF_BYTES: '1200000',
                                DURATION: '00:01:00.000',
                            },
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mkv');

            // 50000000 bytes * 8 bits / 60s / 1000 = 6667 kbps
            expect(result.videoTracks[0].bitrateKbps).toBe(6667);
            // 1200000 * 8 / 60 / 1000 = 160
            expect(result.audioTracks[0].bitrateKbps).toBe(160);
        });

        it('should trigger packet-based bitrate computation when stream bitrates are 0', async () => {
            mockExecFileSequence([
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                        },
                    ],
                    format: {
                        duration: '60.0',
                        bit_rate: '5000000',
                        format_name: 'matroska,webm',
                    },
                }),
                '0,100000\n0,100000\n0,100000\n1,10000\n1,10000\n',
            ]);

            const result = await service.probe('/tmp/test.mkv');

            expect(mockExecFile).toHaveBeenCalledTimes(2);
            // sampleDuration = Math.min(10, 60) = 10
            // 300000 bytes * 8 / 10s / 1000 = 240 kbps for video
            expect(result.videoTracks[0].bitrateKbps).toBe(240);
            // 20000 bytes * 8 / 10s / 1000 = 16 kbps for audio
            expect(result.audioTracks[0].bitrateKbps).toBe(16);
        });

        it('should pass -read_intervals flag to ffprobe for packet-based computation', async () => {
            mockExecFileSequence([
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                        },
                    ],
                    format: {
                        duration: '60.0',
                        bit_rate: '5000000',
                        format_name: 'matroska,webm',
                    },
                }),
                '0,500000\n',
            ]);

            await service.probe('/tmp/test.mkv');

            expect(mockExecFile).toHaveBeenCalledTimes(2);
            const secondCallArgs = mockExecFile.mock.calls[1][1] as string[];
            expect(secondCallArgs).toContain('-read_intervals');
            // Spread through the file: 10%, 50%, and 90% clamped to the last
            // start that still fits a whole sample.
            expect(secondCallArgs).toContain('6%+10,30%+10,50%+10');
        });

        /**
         * Sampling only the opening prices the programme by its introduction.
         * A broadcast that starts quietly reported four of five audio tracks at
         * 2 kbps, and the audio-group suggestions built on those numbers then
         * gave near-silent tracks full-bitrate tiers.
         */
        describe('sampling across the file', () => {
            const oneVideoOneAudio = {
                streams: [
                    {
                        index: 0,
                        codec_type: 'video',
                        codec_name: 'h264',
                        width: 1920,
                        height: 1080,
                        avg_frame_rate: '30/1',
                    },
                    {
                        index: 1,
                        codec_type: 'audio',
                        codec_name: 'aac',
                        channels: 2,
                        sample_rate: '48000',
                    },
                ],
                format: {
                    duration: '600.0',
                    bit_rate: '5000000',
                    format_name: 'matroska,webm',
                },
            };

            it('prices a stream by its loudest sample, not its quietest', async () => {
                // Silence at the head, real content later. 600s file → samples
                // at 60s, 300s and 540s.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    [
                        '1,250,60.0', // opening: near silence
                        '1,250,61.0',
                        '1,160000,300.0', // middle: real audio
                        '1,160000,301.0',
                        '1,80000,540.0', // end: quieter again
                    ].join('\n') + '\n',
                ]);

                const result = await service.probe('/tmp/quiet-open.mkv');

                // Loudest sample is 320000 bytes over 10s → 256 kbps.
                expect(result.audioTracks[0].bitrateKbps).toBe(256);
            });

            it('reports a rate some sample actually observed', async () => {
                // Adding the samples together and dividing by one sample length
                // invents a rate the stream never had — here 176 kbps, which is
                // neither the quiet stretches nor the loud one.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    ['1,30000,60.0', '1,160000,300.0', '1,30000,540.0'].join(
                        '\n'
                    ) + '\n',
                ]);

                const result = await service.probe('/tmp/quiet-open.mkv');

                // Loudest sample = 160000 bytes / 10s → 128 kbps.
                expect(result.audioTracks[0].bitrateKbps).toBe(128);
            });

            it('keeps streams independent of one another', async () => {
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    [
                        '0,600000,60.0', // video loud at the head
                        '1,250,60.0', // audio silent at the head
                        '0,600000,300.0',
                        '1,160000,300.0', // audio loud in the middle
                    ].join('\n') + '\n',
                ]);

                const result = await service.probe('/tmp/mixed.mkv');

                expect(result.videoTracks[0].bitrateKbps).toBe(480);
                expect(result.audioTracks[0].bitrateKbps).toBe(128);
            });

            it('reads only the head of a file too short to spread over', async () => {
                // Nowhere else to look — and the request stays exactly what it
                // has always been for these.
                mockExecFileSequence([
                    makeFfprobeOutput({
                        streams: [
                            {
                                index: 0,
                                codec_type: 'video',
                                codec_name: 'h264',
                                width: 1920,
                                height: 1080,
                                avg_frame_rate: '30/1',
                            },
                        ],
                        format: {
                            duration: '15.0',
                            bit_rate: '5000000',
                            format_name: 'matroska,webm',
                        },
                    }),
                    '0,500000,0.0\n',
                ]);

                await service.probe('/tmp/short.mkv');

                const args = mockExecFile.mock.calls[1][1] as string[];
                expect(args).toContain('%+10');
            });

            it('still counts packets that carry no timestamp', async () => {
                // Rather than discarding them and under-reporting the stream.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    '1,160000,N/A\n1,160000,N/A\n',
                ]);

                const result = await service.probe('/tmp/nopts.mkv');

                expect(result.audioTracks[0].bitrateKbps).toBe(256);
            });

            it('asks ffprobe for the timestamps it needs to separate samples', async () => {
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    '1,160000,300.0\n',
                ]);

                await service.probe('/tmp/test.mkv');

                const args = mockExecFile.mock.calls[1][1] as string[];
                expect(args).toContain('packet=stream_index,size,pts_time');
            });
        });

        it('should use actual duration as sampleDuration when duration < 10', async () => {
            mockExecFileSequence([
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                        },
                    ],
                    format: {
                        duration: '5.0',
                        bit_rate: '5000000',
                        format_name: 'matroska,webm',
                    },
                }),
                '0,100000\n0,100000\n0,100000\n1,10000\n1,10000\n',
            ]);

            const result = await service.probe('/tmp/short.mkv');

            // sampleDuration = Math.min(10, 5) = 5
            const secondCallArgs = mockExecFile.mock.calls[1][1] as string[];
            expect(secondCallArgs).toContain('-read_intervals');
            expect(secondCallArgs).toContain('%+5');
            // 300000 bytes * 8 / 5s / 1000 = 480 kbps for video
            expect(result.videoTracks[0].bitrateKbps).toBe(480);
            // 20000 bytes * 8 / 5s / 1000 = 32 kbps for audio
            expect(result.audioTracks[0].bitrateKbps).toBe(32);
        });

        it('should skip packet computation when duration is zero', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                        },
                    ],
                    format: {
                        duration: '0',
                        bit_rate: '0',
                        format_name: 'mp4',
                    },
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].bitrateKbps).toBe(0);
            // execFile should only be called once (for the initial probe, not for packets)
            expect(mockExecFile).toHaveBeenCalledTimes(1);
        });

        it('should return "unknown" codec when codec_name is absent', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            width: 640,
                            height: 480,
                            bit_rate: '1000000',
                            avg_frame_rate: '25/1',
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            bit_rate: '64000',
                            channels: 1,
                            sample_rate: '22050',
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].codec).toBe('unknown');
            expect(result.audioTracks[0].codec).toBe('unknown');
        });

        it('should default channels to 2 and sampleRate to 44100 when absent', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '128000',
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.audioTracks[0].channels).toBe(2);
            expect(result.audioTracks[0].sampleRate).toBe(44100);
        });

        it('should return unknown format name when absent', async () => {
            mockExecFileResult(
                JSON.stringify({
                    streams: [],
                    format: { duration: '10.0', bit_rate: '1000' },
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.format.formatName).toBe('unknown');
        });

        it('should return zero duration and bitrate when format fields are missing', async () => {
            mockExecFileResult(
                JSON.stringify({
                    streams: [],
                    format: {},
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.format.duration).toBe(0);
            expect(result.format.bitrateKbps).toBe(0);
        });

        it('should skip non-audio/video streams', async () => {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            bit_rate: '5000000',
                            avg_frame_rate: '30/1',
                        },
                        { index: 1, codec_type: 'subtitle', codec_name: 'srt' },
                        { index: 2, codec_type: 'data', codec_name: 'unknown' },
                        {
                            index: 3,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '128000',
                            channels: 2,
                            sample_rate: '44100',
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks).toHaveLength(1);
            expect(result.audioTracks).toHaveLength(1);
        });

        it('should throw when ffprobe command fails', async () => {
            mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
                cb(new Error('ffprobe not found'), { stdout: '', stderr: '' });
            });

            await expect(service.probe('/tmp/test.mp4')).rejects.toThrow(
                'ffprobe not found'
            );
        });

        it('should handle packet computation failure gracefully', async () => {
            mockExecFileSequence([
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '30/1',
                        },
                    ],
                    format: {
                        duration: '60.0',
                        bit_rate: '5000000',
                        format_name: 'matroska',
                    },
                }),
                new Error('packet probe failed'),
            ]);

            const result = await service.probe('/tmp/test.mkv');

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
            expect(
                extractBitrateKbps({
                    tags: {
                        NUMBER_OF_BYTES: '7500000',
                        DURATION: '00:01:00.000',
                    },
                })
            ).toBe(1000);
        });

        it('should return 0 when no bitrate info is available', () => {
            expect(extractBitrateKbps({})).toBe(0);
            expect(extractBitrateKbps({ tags: {} })).toBe(0);
        });

        it('should return 0 when DURATION tag cannot be parsed', () => {
            expect(
                extractBitrateKbps({
                    tags: { NUMBER_OF_BYTES: '7500000', DURATION: 'invalid' },
                })
            ).toBe(0);
        });
    });
});
