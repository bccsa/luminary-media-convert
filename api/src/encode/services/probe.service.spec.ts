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

    /**
     * ffprobe reports `und` for a stream with no language tag. Passed through, it
     * is a placeholder every reader downstream has to know about — and the guard
     * in `applySavedTrackLabels` did not, so a saved language was never restored
     * to a source that had none while saved track names came back fine.
     */
    describe('language normalisation', () => {
        async function languagesFor(tags: Record<string, unknown> | undefined) {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '25/1',
                            ...(tags ? { tags } : {}),
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                            ...(tags ? { tags } : {}),
                        },
                    ],
                })
            );
            const result = await service.probe('/tmp/test.mp4');
            return {
                video: result.videoTracks[0]?.language,
                audio: result.audioTracks[0]?.language,
            };
        }

        it('treats "und" as no language at all', async () => {
            expect(await languagesFor({ language: 'und' })).toEqual({
                video: undefined,
                audio: undefined,
            });
        });

        it("does not rely on ffprobe's casing", async () => {
            expect(await languagesFor({ language: 'UND' })).toEqual({
                video: undefined,
                audio: undefined,
            });
        });

        it.each([
            ['', 'empty'],
            ['   ', 'whitespace'],
        ])('treats an %s tag as no language (%s)', async (value) => {
            expect(await languagesFor({ language: value })).toEqual({
                video: undefined,
                audio: undefined,
            });
        });

        it('leaves a real language alone', async () => {
            expect(await languagesFor({ language: 'nor' })).toEqual({
                video: 'nor',
                audio: 'nor',
            });
        });

        it('trims a padded tag rather than carrying the spaces', async () => {
            expect(await languagesFor({ language: ' deu ' })).toEqual({
                video: 'deu',
                audio: 'deu',
            });
        });

        it('reports nothing when the stream carries no tags object', async () => {
            expect(await languagesFor(undefined)).toEqual({
                video: undefined,
                audio: undefined,
            });
        });
    });

    describe('track names', () => {
        async function namesFor(tags: Record<string, unknown>) {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1920,
                            height: 1080,
                            avg_frame_rate: '25/1',
                            tags,
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            channels: 2,
                            sample_rate: '48000',
                            tags,
                        },
                    ],
                })
            );
            const result = await service.probe('/tmp/test.mp4');
            return [result.videoTracks[0]?.name, result.audioTracks[0]?.name];
        }

        it('reads an MKV title', async () => {
            expect(await namesFor({ title: 'English' })).toEqual(['English', 'English']);
        });

        it('reads the name an MP4 carries', async () => {
            expect(await namesFor({ name: 'English', handler_name: 'SoundHandler' })).toEqual([
                'English',
                'English',
            ]);
        });

        it('reads a handler name that is a real title', async () => {
            expect(await namesFor({ handler_name: 'Commentary' })).toEqual(['Commentary', 'Commentary']);
        });

        it('ignores a handler name a muxer writes for every track', async () => {
            for (const generic of ['SoundHandler', 'VideoHandler', 'Core Media Audio', 'ISO Media file produced by Google Inc.', 'GPAC ISO Audio Handler', 'Mainconcept MP4 Sound Media Handler']) {
                expect(await namesFor({ handler_name: generic })).toEqual([undefined, undefined]);
            }
        });

        it('does not rely on ffprobe\'s casing, and trims', async () => {
            expect(await namesFor({ TITLE: '  Deutsch ' })).toEqual(['Deutsch', 'Deutsch']);
        });

        it('drops quotes and line breaks, which a playlist name cannot hold', async () => {
            expect(await namesFor({ title: 'The "main" one\nhere' })).toEqual(['The main one here', 'The main one here']);
        });
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
                'stream_index=0|size=100000\nstream_index=0|size=100000\nstream_index=0|size=100000\nstream_index=1|size=10000\nstream_index=1|size=10000\n',
            ]);

            const result = await service.probe('/tmp/test.mkv');

            // Initial probe, packet sampling, and one keyframe-cadence probe
            // for the single video track.
            expect(mockExecFile).toHaveBeenCalledTimes(3);
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
                'stream_index=0|size=500000\n',
            ]);

            await service.probe('/tmp/test.mkv');

            expect(mockExecFile).toHaveBeenCalledTimes(3);
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
                        'stream_index=1|pts_time=60.0|size=250', // opening: near silence
                        'stream_index=1|pts_time=61.0|size=250',
                        'stream_index=1|pts_time=300.0|size=160000', // middle: real audio
                        'stream_index=1|pts_time=301.0|size=160000',
                        'stream_index=1|pts_time=540.0|size=80000', // end: quieter again
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
                    [
                        'stream_index=1|pts_time=60.0|size=30000',
                        'stream_index=1|pts_time=300.0|size=160000',
                        'stream_index=1|pts_time=540.0|size=30000',
                    ].join('\n') + '\n',
                ]);

                const result = await service.probe('/tmp/quiet-open.mkv');

                // Loudest sample = 160000 bytes / 10s → 128 kbps.
                expect(result.audioTracks[0].bitrateKbps).toBe(128);
            });

            it('keeps streams independent of one another', async () => {
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    [
                        'stream_index=0|pts_time=60.0|size=600000', // video loud at the head
                        'stream_index=1|pts_time=60.0|size=250', // audio silent at the head
                        'stream_index=0|pts_time=300.0|size=600000',
                        'stream_index=1|pts_time=300.0|size=160000', // audio loud in the middle
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
                    'stream_index=0|pts_time=0.0|size=500000\n',
                ]);

                await service.probe('/tmp/short.mkv');

                const args = mockExecFile.mock.calls[1][1] as string[];
                expect(args).toContain('%+10');
            });

            it('still counts packets that carry no timestamp', async () => {
                // Rather than discarding them and under-reporting the stream.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    'stream_index=1|pts_time=N/A|size=160000\nstream_index=1|pts_time=N/A|size=160000\n',
                ]);

                const result = await service.probe('/tmp/nopts.mkv');

                expect(result.audioTracks[0].bitrateKbps).toBe(256);
            });

            it('reads fields by name, whatever order ffprobe prints them in', async () => {
                // ffprobe emits stream_index, pts_time, size no matter how the
                // entries were requested, and some builds add a trailing '|'.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    'stream_index=1|pts_time=0.000000|size=160000|\n' +
                        'stream_index=1|pts_time=1.000000|size=160000|\n',
                ]);

                const result = await service.probe('/tmp/order.mkv');

                expect(result.audioTracks[0].bitrateKbps).toBe(256);
            });

            const videoOnly = (duration: string) => ({
                streams: [oneVideoOneAudio.streams[0]],
                format: { ...oneVideoOneAudio.format, duration },
            });

            it('never asks for samples that overlap', async () => {
                // A file just over two samples long clamps 50% and 90% to the
                // same late start, which overlapped the first sample (#423).
                mockExecFileSequence([
                    makeFfprobeOutput(videoOnly('20.008')),
                    'stream_index=0|pts_time=2.0|size=1000\n',
                ]);

                await service.probe('/tmp/short.webm');

                const args = mockExecFile.mock.calls[1][1] as string[];
                expect(args).toContain('2.001%+10');
            });

            it('keeps the samples that fit one after another', async () => {
                mockExecFileSequence([
                    makeFfprobeOutput(videoOnly('25.0')),
                    'stream_index=0|pts_time=2.5|size=1000\n',
                ]);

                await service.probe('/tmp/medium.webm');

                const args = mockExecFile.mock.calls[1][1] as string[];
                expect(args).toContain('2.5%+10,12.5%+10');
            });

            it('counts a packet printed by two reads once', async () => {
                // The second read starts at the keyframe before 300 s, so it
                // prints packets the first sample already counted.
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    [
                        'stream_index=1|pts_time=298.0|size=100000',
                        'stream_index=1|pts_time=299.0|size=100000',
                        'stream_index=1|pts_time=298.0|size=100000',
                        'stream_index=1|pts_time=299.0|size=100000',
                        'stream_index=1|pts_time=300.0|size=10000',
                    ].join('\n') + '\n',
                ]);

                const result = await service.probe('/tmp/seek-back.mkv');

                // 200000 bytes over 10 s → 160 kbps, not 320.
                expect(result.audioTracks[0].bitrateKbps).toBe(160);
            });

            it('asks ffprobe for the timestamps it needs to separate samples', async () => {
                mockExecFileSequence([
                    makeFfprobeOutput(oneVideoOneAudio),
                    'stream_index=1|pts_time=300.0|size=160000\n',
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
                'stream_index=0|size=100000\nstream_index=0|size=100000\nstream_index=0|size=100000\nstream_index=1|size=10000\nstream_index=1|size=10000\n',
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
            // No packet sampling at all — there is no duration to price
            // against. The keyframe-cadence probe still runs; it is not asking
            // about duration.
            const sampledPackets = mockExecFile.mock.calls.some((call) =>
                (call[1] as string[]).includes(
                    'packet=stream_index,size,pts_time'
                )
            );
            expect(sampledPackets).toBe(false);
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

    /**
     * Two things the encoder has to know about a source before it will let a
     * rendition be copied rather than re-encoded: where each stream begins, and
     * whether the keyframes arrive on a cadence that segments can be cut on.
     * Both travel on the probe result, so the form can grey the option out
     * before anyone submits a config the API will refuse.
     */
    describe('start times', () => {
        it('reports where each stream begins', async () => {
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
                            start_time: '0.000000',
                        },
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '192000',
                            channels: 2,
                            sample_rate: '48000',
                            start_time: '0.083000',
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].startTime).toBe(0);
            expect(result.audioTracks[0].startTime).toBeCloseTo(0.083);
        });

        it('reads a missing or unusable start time as the top of the timeline', async () => {
            // Zero rather than undefined: everything downstream compares one
            // stream's start against another's, and a third case would have to
            // be answered somewhere.
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
                        {
                            index: 1,
                            codec_type: 'audio',
                            codec_name: 'aac',
                            bit_rate: '192000',
                            channels: 2,
                            sample_rate: '48000',
                            start_time: 'N/A',
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].startTime).toBe(0);
            expect(result.audioTracks[0].startTime).toBe(0);
        });
    });

    describe('codec parameters', () => {
        it('reports reorder depth, pixel format and level', async () => {
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
                            has_b_frames: 2,
                            pix_fmt: 'yuv420p',
                            level: 40,
                        },
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].hasBFrames).toBe(2);
            expect(result.videoTracks[0].pixFmt).toBe('yuv420p');
            expect(result.videoTracks[0].level).toBe(40);
        });

        it('leaves them absent when ffprobe does not report them', async () => {
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
                    ],
                })
            );

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].hasBFrames).toBeUndefined();
            expect(result.videoTracks[0].pixFmt).toBeUndefined();
            expect(result.videoTracks[0].level).toBeUndefined();
        });
    });

    describe('probeGopInfo', () => {
        function mockFrames(pictTypes: string[]) {
            mockExecFileResult(pictTypes.join('\n') + '\n');
        }

        it('reports a regular cadence measured across every interval', async () => {
            // I at 0, 60 and 120 — two intervals of sixty frames.
            mockFrames([
                'I',
                ...Array(59).fill('P'),
                'I',
                ...Array(59).fill('P'),
                'I',
                ...Array(20).fill('P'),
            ]);

            expect(await service.probeGopInfo('/tmp/test.mp4', 0, 30)).toEqual({
                gopFrames: 60,
                gopSeconds: 2,
                regular: true,
            });
        });

        it('counts a keyframe whose row carries side data', async () => {
            // ffprobe appends side data to the frame's own CSV row, so a
            // keyframe with an SEI message reads
            // "I,H.26[45] User Data Unregistered SEI message". Real H.264
            // sources carry these; matching the whole line missed every one.
            mockFrames([
                'I,H.26[45] User Data Unregistered SEI message',
                ...Array(59).fill('P'),
                'I,H.26[45] User Data Unregistered SEI message',
                ...Array(20).fill('P'),
            ]);

            expect(await service.probeGopInfo('/tmp/test.mp4', 0, 30)).toEqual({
                gopFrames: 60,
                gopSeconds: 2,
                regular: true,
            });
        });

        it('reports an irregular cadence rather than the first interval it saw', async () => {
            // The whole reason for measuring past the first pair: a source that
            // opens with a tidy GOP and then cuts keyframes wherever the
            // picture changes would otherwise be copied on the strength of it.
            mockFrames([
                'I',
                ...Array(59).fill('P'),
                'I',
                ...Array(19).fill('P'),
                'I',
                ...Array(20).fill('P'),
            ]);

            const result = await service.probeGopInfo('/tmp/test.mp4', 0, 30);
            expect(result).toEqual({
                gopFrames: 60,
                gopSeconds: 2,
                regular: false,
            });
        });

        it('asks only about the track it was given', async () => {
            mockFrames(['I', ...Array(59).fill('P'), 'I']);

            await service.probeGopInfo('/tmp/test.mp4', 1, 30);

            const args = mockExecFile.mock.calls[0][1] as string[];
            expect(args).toContain('-select_streams');
            expect(args[args.indexOf('-select_streams') + 1]).toBe('v:1');
            // A window, not the whole file — this runs at ingest.
            expect(args).toContain('%+#200');
        });

        it('returns null when the window holds fewer than two keyframes', async () => {
            mockFrames(['I', 'P', 'P', 'P']);

            expect(
                await service.probeGopInfo('/tmp/test.mp4', 0, 30)
            ).toBeNull();
        });

        it('returns null when ffprobe fails', async () => {
            mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
                cb(new Error('ffprobe failed'), { stdout: '', stderr: '' });
            });

            expect(
                await service.probeGopInfo('/tmp/test.mp4', 0, 30)
            ).toBeNull();
        });

        it('returns null without asking anything when the frame rate is unknown', async () => {
            expect(
                await service.probeGopInfo('/tmp/test.mp4', 0, 0)
            ).toBeNull();
            expect(mockExecFile).not.toHaveBeenCalled();
        });

        it('lands on the probe result, one track at a time', async () => {
            mockExecFileSequence([
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
                        {
                            index: 1,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: 1280,
                            height: 720,
                            bit_rate: '2500000',
                            avg_frame_rate: '30/1',
                        },
                    ],
                }),
                // Track 0: a clean 60-frame cadence.
                [
                    'I',
                    ...Array(59).fill('P'),
                    'I',
                    ...Array(59).fill('P'),
                    'I',
                ].join('\n') + '\n',
                // Track 1: keyframes wherever it likes.
                [
                    'I',
                    ...Array(29).fill('P'),
                    'I',
                    ...Array(9).fill('P'),
                    'I',
                ].join('\n') + '\n',
            ]);

            const result = await service.probe('/tmp/multi-angle.mp4');

            expect(result.videoTracks[0].gopFrames).toBe(60);
            expect(result.videoTracks[0].gopSeconds).toBe(2);
            expect(result.videoTracks[0].gopRegular).toBe(true);
            expect(result.videoTracks[1].gopRegular).toBe(false);
        });

        it('leaves the fields absent when the cadence cannot be established', async () => {
            mockExecFileSequence([
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
                    ],
                }),
                new Error('ffprobe failed'),
            ]);

            const result = await service.probe('/tmp/test.mp4');

            expect(result.videoTracks[0].gopFrames).toBeUndefined();
            expect(result.videoTracks[0].gopRegular).toBeUndefined();
        });
    });
    /**
     * The root of the anamorphic bug: ffprobe returns `sample_aspect_ratio` on
     * `-show_streams` and the mapping used to drop it, so nothing downstream
     * could know a 720x576 broadcast was a 16:9 picture. Every dimension
     * decision then treated the coded frame as if its pixels were square.
     */
    describe('display dimensions', () => {
        async function displayFor(
            sampleAspectRatio?: string,
            dims = [720, 576]
        ) {
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            width: dims[0],
                            height: dims[1],
                            avg_frame_rate: '25/1',
                            ...(sampleAspectRatio
                                ? { sample_aspect_ratio: sampleAspectRatio }
                                : {}),
                        },
                    ],
                })
            );
            const track = (await service.probe('/tmp/test.mp4')).videoTracks[0];
            return {
                displayWidth: track.displayWidth,
                displayHeight: track.displayHeight,
            };
        }

        it('widens PAL SD carrying 16:9 to its square-pixel size', async () => {
            // 720 at 64:45 is 1024 exactly. The height is untouched: the
            // correction never throws a source line away.
            expect(await displayFor('64:45')).toEqual({
                displayWidth: 1024,
                displayHeight: 576,
            });
        });

        it('heightens NTSC DV rather than narrowing it', async () => {
            // 720x480 at 8:9 is a 640x480 picture, but correcting on the width
            // would discard eighty columns of real detail. Scale the short axis
            // up instead: same shape, nothing lost.
            expect(await displayFor('8:9', [720, 480])).toEqual({
                displayWidth: 720,
                displayHeight: 540,
            });
        });

        it('leaves a square-pixel source exactly as coded', async () => {
            expect(await displayFor('1:1', [1920, 1080])).toEqual({
                displayWidth: 1920,
                displayHeight: 1080,
            });
        });

        it.each([
            ['an absent tag', undefined],
            ["ffprobe's unknown ratio", '0:1'],
            ['a literal N/A', 'N/A'],
            ['a malformed value', 'garbage'],
        ])('reads %s as square pixels', async (_label, sar) => {
            // Definite rather than undefined, for `parseStartTime`'s reason: a
            // container that does not say what shape its samples are is saying
            // they are square, and a third case would have to be answered at
            // every reader.
            expect(await displayFor(sar as string | undefined)).toEqual({
                displayWidth: 720,
                displayHeight: 576,
            });
        });

        it.each([
            ['90', 90, 270],
            ['-90', -90, 90],
            ['270', 270, 90],
        ])(
            'turns a phone video whose display matrix says %s',
            async (_label, matrix, clockwise) => {
                mockExecFileResult(
                    makeFfprobeOutput({
                        streams: [
                            {
                                index: 0,
                                codec_type: 'video',
                                codec_name: 'hevc',
                                width: 1920,
                                height: 1080,
                                avg_frame_rate: '30/1',
                                side_data_list: [
                                    {
                                        side_data_type: 'Display Matrix',
                                        rotation: matrix,
                                    },
                                ],
                            },
                        ],
                    })
                );
                const track = (await service.probe('/tmp/phone.mov'))
                    .videoTracks[0];
                // Stored landscape, shown portrait: the ladder plans the turn.
                expect(track).toMatchObject({
                    width: 1920,
                    height: 1080,
                    displayWidth: 1080,
                    displayHeight: 1920,
                    rotation: clockwise,
                });
            }
        );

        it('keeps the size of a picture turned upside down', async () => {
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
                            side_data_list: [
                                {
                                    side_data_type: 'Display Matrix',
                                    rotation: 180,
                                },
                            ],
                        },
                    ],
                })
            );
            const track = (await service.probe('/tmp/flip.mov')).videoTracks[0];
            expect(track).toMatchObject({
                displayWidth: 1920,
                displayHeight: 1080,
                rotation: 180,
            });
        });

        it('leaves rotation out when the picture is shown as stored', async () => {
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
                })
            );
            const track = (await service.probe('/tmp/test.mp4')).videoTracks[0];
            expect(track).not.toHaveProperty('rotation');
        });

        it('survives a video stream that reports no dimensions at all', async () => {
            // Nothing to correct and nothing to divide by. The track still has
            // to come back — `selectStoryboardTrack` and the ladder both filter
            // on dimensions themselves and would rather see a zero than a NaN.
            mockExecFileResult(
                makeFfprobeOutput({
                    streams: [
                        {
                            index: 0,
                            codec_type: 'video',
                            codec_name: 'h264',
                            avg_frame_rate: '25/1',
                            sample_aspect_ratio: '64:45',
                        },
                    ],
                })
            );

            const track = (await service.probe('/tmp/test.mp4')).videoTracks[0];
            expect(track.width).toBe(0);
            expect(track.height).toBe(0);
            expect(track.displayWidth).toBe(0);
            expect(track.displayHeight).toBe(0);
        });

        it('keeps both dimensions even for the encoders', async () => {
            // 4:3 on a 705-wide frame is 940 exactly; 703 at 4:3 is 937.33,
            // which yuv420p cannot take.
            const odd = await displayFor('4:3', [703, 575]);
            expect(odd.displayWidth! % 2).toBe(0);
            expect(odd.displayHeight! % 2).toBe(0);
        });
    });

    /**
     * Angle detection, run end to end against a fake source: every ffprobe and
     * ffmpeg call is answered from a model of the file, so what is asked for —
     * which frames, at which instants, read how — is what is checked.
     */
    describe('angle detection', () => {
        /** A 32x18 frame with plenty of contrast, a different one per seed. */
        function picture(seed: number): Uint8Array {
            const frame = new Uint8Array(32 * 18);
            let x = (seed * 2654435761) >>> 0 || 1;
            for (let i = 0; i < frame.length; i++) {
                x ^= x << 13;
                x >>>= 0;
                x ^= x >>> 17;
                x ^= x << 5;
                x >>>= 0;
                frame[i] = 40 + (x % 176);
            }
            return frame;
        }

        /** The same picture at half the contrast: a lower quality of it. */
        function lower(frame: Uint8Array): Uint8Array {
            return Uint8Array.from(frame, (v) => 64 + (v >> 1));
        }

        /** Two cameras, each cutting to a new shot every second. */
        const camA = (t: number) => picture(1000 + Math.floor(t));
        const camB = (t: number) => picture(5000 + Math.floor(t));

        interface FakeTrack {
            width: number;
            height: number;
            fps: string;
            /** What the track shows `t` seconds into the container's timeline. */
            show: (t: number) => Uint8Array | null;
        }

        interface Grab {
            track: number;
            /** Seconds on the container's timeline the frame was asked for. */
            at: number;
            /** Where the input was sought, or null when it was read from the top. */
            inputSeek: number | null;
        }

        /**
         * Answer every call `probe()` makes from `tracks`. `clock` stands in for
         * `Date.now()` and moves on by `perGrab` ms with every frame taken.
         */
        function fakeSource(
            tracks: FakeTrack[],
            options: {
                duration?: number;
                formatName?: string;
                startTime?: number;
                packets?: string;
                perGrab?: number;
            } = {}
        ) {
            const duration = options.duration ?? 60;
            const startTime = options.startTime ?? 0;
            const grabs: Grab[] = [];
            const reads: string[] = [];
            let clock = 1_700_000_000_000;
            vi.spyOn(Date, 'now').mockImplementation(() => clock);

            mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
                const reply = (stdout: any) => cb(null, { stdout, stderr: '' });
                if (args.includes('-show_streams')) {
                    return reply(
                        JSON.stringify({
                            streams: tracks.map((t, index) => ({
                                index,
                                codec_type: 'video',
                                codec_name: 'h264',
                                width: t.width,
                                height: t.height,
                                bit_rate: String(t.width * 2000),
                                r_frame_rate: t.fps,
                                avg_frame_rate: t.fps,
                                start_time: String(startTime),
                                duration: String(duration),
                            })),
                            format: {
                                duration: String(duration),
                                bit_rate: '9000000',
                                format_name:
                                    options.formatName ??
                                    'mov,mp4,m4a,3gp,3g2,mj2',
                                start_time: String(startTime),
                            },
                        })
                    );
                }
                if (args.includes('-show_frames')) {
                    // A regular two-second GOP at 25 fps.
                    const gop = ['I', ...Array(49).fill('P')];
                    return reply([...gop, ...gop, 'I'].join('\n') + '\n');
                }
                if (args.includes('packet=stream_index,pts_time,flags')) {
                    reads.push(args[args.indexOf('-read_intervals') + 1]);
                    return reply(options.packets ?? '');
                }
                if (args.includes('-frames:v')) {
                    const input = args.indexOf('-i');
                    const before = args.indexOf('-ss');
                    const after = args.indexOf('-ss', input);
                    const from =
                        before >= 0 && before < input
                            ? parseFloat(args[before + 1])
                            : null;
                    const discard =
                        after > input ? parseFloat(args[after + 1]) : 0;
                    const track = Number(
                        args[args.indexOf('-map') + 1].split(':')[2]
                    );
                    const at = startTime + (from ?? 0) + discard;
                    grabs.push({ track, at, inputSeek: from });
                    clock += options.perGrab ?? 0;
                    const frame = tracks[track].show(at);
                    return reply(frame ? Buffer.from(frame) : Buffer.alloc(0));
                }
                throw new Error(`unexpected call: ${args.join(' ')}`);
            });
            return { grabs, reads };
        }

        const hd = (show: FakeTrack['show'], fps = '25/1'): FakeTrack => ({
            width: 1920,
            height: 1080,
            fps,
            show,
        });
        const sd = (show: FakeTrack['show'], fps = '25/1'): FakeTrack => ({
            width: 640,
            height: 360,
            fps,
            show,
        });

        /** Keyframe packets as ffprobe prints them, one line each. */
        const keyframePackets = (entries: [number, number][]) =>
            entries
                .map(
                    ([stream, pts]) =>
                        `stream_index=${stream}|pts_time=${pts.toFixed(6)}|flags=K__`
                )
                .join('\n') + '\n';

        afterEach(() => {
            vi.restoreAllMocks();
        });

        // The case PR #422's rule got wrong: the programme sits on camera A at
        // seven of the eight first-look instants, and one disagreement was
        // forgiven. Looked at again half a second either side, the cutaway is
        // still there, and one lasting disagreement is proof of two pictures.
        it('keeps a programme feed apart from the camera it shows most of the time', async () => {
            const programme = (t: number) =>
                t >= 32 && t < 36 ? camB(t) : camA(t);
            fakeSource([hd(camA), hd(programme)]);

            const result = await service.probe('/tmp/iso.mp4');

            expect(result.anglesDetected).toBe(true);
            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                undefined,
                undefined,
            ]);
        });

        it('groups the qualities of one picture after verifying them at frames they share', async () => {
            const { grabs } = fakeSource([
                hd(camA, '50/1'),
                sd((t) => lower(camA(t)), '25/1'),
            ]);

            const result = await service.probe('/tmp/ladder.mp4');

            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                0, 0,
            ]);
            expect(result.videoTracks.map((t) => t.pictureMatches)).toEqual([
                48, 48,
            ]);
            expect(result.videoTracks.map((t) => t.pictureVerified)).toEqual([
                true,
                true,
            ]);
            expect(grabs).toHaveLength(2 * 48);
            // On the 25 fps track's frames, asked for half a 50 fps frame early.
            for (const grab of grabs) {
                const frames = (grab.at + 0.01) / 0.04;
                expect(Math.abs(frames - Math.round(frames))).toBeLessThan(
                    1e-6
                );
            }
        });

        it('excuses a disagreement the frames half a second either side agree on', async () => {
            // A flash on one track, caught by the first look at 11.24 s.
            const flashed = (t: number) =>
                t >= 11.2 && t < 11.25 ? picture(-1) : lower(camA(t));
            fakeSource([hd(camA), sd(flashed)]);

            const result = await service.probe('/tmp/flash.mp4');

            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                0, 0,
            ]);
            expect(result.videoTracks[0].pictureVerified).toBe(true);
        });

        it('marks a group unverified when time runs out while it is verified', async () => {
            // 16 frames for the first look take 24 s of the 45; the first
            // verifying batch runs past the deadline.
            fakeSource([hd(camA), sd((t) => lower(camA(t)))], {
                perGrab: 1500,
            });

            const result = await service.probe('/tmp/slow.mp4');

            expect(result.anglesDetected).toBe(true);
            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                0, 0,
            ]);
            expect(result.videoTracks.map((t) => t.pictureVerified)).toEqual([
                false,
                false,
            ]);
            expect(result.videoTracks[0].pictureMatches).toBeGreaterThanOrEqual(
                8
            );
            expect(result.videoTracks[0].pictureMatches).toBeLessThan(48);
        });

        // A disagreement nobody could excuse is what a programme feed and its
        // camera look like: grouping them would at worst drop a camera, so
        // they are kept apart, and each track names the other as undecided.
        it('keeps a pair apart, undecided, when time runs out before a disagreement is re-checked', async () => {
            const programme = (t: number) =>
                t >= 32 && t < 36 ? camB(t) : camA(t);
            // The 16 first-look frames end at 44.8 s; one re-check frame fits.
            const { grabs } = fakeSource([hd(camA), hd(programme)], {
                perGrab: 2800,
            });

            const result = await service.probe('/tmp/undecided.mp4');

            expect(result.anglesDetected).toBe(true);
            expect(grabs).toHaveLength(17);
            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                undefined,
                undefined,
            ]);
            expect(result.videoTracks.map((t) => t.pictureUndecided)).toEqual([
                [1],
                [0],
            ]);
        });

        it('abandons detection when the first look does not fit the time allowed', async () => {
            fakeSource([hd(camA), sd((t) => lower(camA(t)))], {
                perGrab: 4000,
            });

            const result = await service.probe('/tmp/too-slow.mp4');

            expect(result.anglesDetected).toBeUndefined();
            expect(
                result.videoTracks.every((t) => t.pictureGroup == null)
            ).toBe(true);
            expect(
                result.videoTracks.every((t) => t.keyframeGrid == null)
            ).toBe(true);
        });

        it('stops asking a track that gave no frame at the first look', async () => {
            const { grabs } = fakeSource([
                hd(camA),
                sd((t) => lower(camA(t))),
                sd(() => null),
            ]);

            const result = await service.probe('/tmp/dead.mp4');

            expect(grabs.filter((g) => g.track === 2)).toHaveLength(8);
            expect(result.videoTracks.map((t) => t.pictureGroup)).toEqual([
                0,
                0,
                undefined,
            ]);
            expect(result.videoTracks[0].pictureVerified).toBe(true);
        });

        describe('keyframe grids', () => {
            const ladder = () => [hd(camA), sd((t) => lower(camA(t)))];
            const every2s = (from: number, to: number) =>
                Array.from(
                    { length: (to - from) / 2 + 1 },
                    (_, i) => from + i * 2
                );

            // What ffprobe printed for a 60 s two-track MP4: its windows
            // overlap, so 40-46 s comes twice for both streams, and a seek
            // that lands the second stream a keyframe early repeats 38 s for
            // it alone.
            it('counts a keyframe the overlapping windows read twice only once', async () => {
                const packets = keyframePackets([
                    [1, 4],
                    ...every2s(6, 22).flatMap((pts): [number, number][] => [
                        [0, pts],
                        [1, pts],
                    ]),
                    [1, 28],
                    ...every2s(30, 46).flatMap((pts): [number, number][] => [
                        [0, pts],
                        [1, pts],
                    ]),
                    [1, 38],
                    ...every2s(40, 56).flatMap((pts): [number, number][] => [
                        [0, pts],
                        [1, pts],
                    ]),
                ]);
                fakeSource(ladder(), { packets });

                const result = await service.probe('/tmp/overlap.mp4');

                expect(result.videoTracks.map((t) => t.keyframeGrid)).toEqual([
                    0, 0,
                ]);
            });

            // A 287 s MP4: each later read starts at the keyframe before its
            // window, and a keyframe earlier still for the second stream.
            it('leaves out the keyframes a read runs in with before its window', async () => {
                const window = (from: number, to: number, runIn: number[]) => [
                    ...runIn.map((pts): [number, number] => [1, pts]),
                    ...runIn.slice(-1).map((pts): [number, number] => [0, pts]),
                    ...every2s(from, to).flatMap((pts): [number, number][] => [
                        [0, pts],
                        [1, pts],
                    ]),
                ];
                const packets = keyframePackets([
                    ...window(30, 48, [26, 28]),
                    ...window(144, 162, [140, 142]),
                    ...window(260, 278, [256, 258]),
                ]);
                const { reads } = fakeSource(ladder(), {
                    duration: 287,
                    packets,
                });

                const result = await service.probe('/tmp/long.mp4');

                expect(reads).toEqual(['28.7%+20,143.5%+20,258.3%+20']);
                expect(result.videoTracks.map((t) => t.keyframeGrid)).toEqual([
                    0, 0,
                ]);
            });

            // An MPEG-TS from a recorder can start an hour in: its packets and
            // ffprobe's read intervals are both on that timeline.
            it('reads the windows on the container’s timeline when it starts late', async () => {
                const packets = keyframePackets(
                    [30, 144, 260].flatMap((from) =>
                        every2s(3600 + from, 3600 + from + 18).flatMap(
                            (pts): [number, number][] => [
                                [0, pts],
                                [1, pts],
                            ]
                        )
                    )
                );
                const { reads } = fakeSource(ladder(), {
                    duration: 287,
                    startTime: 3600,
                    formatName: 'mpegts',
                    packets,
                });

                const result = await service.probe('/tmp/recorder.ts');

                expect(reads).toEqual(['3628.7%+20,3743.5%+20,3858.3%+20']);
                expect(result.videoTracks.map((t) => t.keyframeGrid)).toEqual([
                    0, 0,
                ]);
            });

            it('reads a short source from its top without seeking, wherever it starts', async () => {
                const packets = keyframePackets(
                    every2s(2, 20).flatMap((pts): [number, number][] => [
                        [0, 1.4 + pts],
                        [1, 1.4 + pts],
                    ])
                );
                const { reads } = fakeSource(ladder(), {
                    duration: 30,
                    startTime: 1.4,
                    formatName: 'mpegts',
                    packets,
                });

                const result = await service.probe('/tmp/short.ts');

                expect(reads).toEqual(['%+20']);
                expect(result.videoTracks.map((t) => t.keyframeGrid)).toEqual([
                    0, 0,
                ]);
            });
        });

        // In Matroska the file is positioned by its first video stream: a
        // second one whose only earlier keyframe is the very first waits for
        // its next, so seeking to 0 is not the same as not seeking.
        it('decodes from the top, without seeking, when a frame’s lead reaches the start', async () => {
            const { grabs } = fakeSource(
                [hd(camA), sd((t) => lower(camA(t)))],
                {
                    formatName: 'matroska,webm',
                }
            );

            await service.probe('/tmp/proxy.mkv');

            // A two-second GOP is sought 2.5 s early.
            const early = grabs.filter((g) => g.at < 2.5);
            const later = grabs.filter((g) => g.at > 2.5);
            expect(early.length).toBeGreaterThan(0);
            expect(early.every((g) => g.inputSeek === null)).toBe(true);
            for (const grab of later)
                expect(grab.inputSeek).toBeCloseTo(grab.at - 2.5, 2);
        });
    });
});
