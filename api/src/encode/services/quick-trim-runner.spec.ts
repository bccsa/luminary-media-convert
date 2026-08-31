import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { parseMediaPlaylist } from '@luminary-media-converter/hls-core';

const { mockSpawn, mockExecFile } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockExecFile: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, spawn: mockSpawn, execFile: mockExecFile };
});

import {
    buildBridgeArgs,
    buildCopyPartArgs,
    buildQuickTrimJobs,
    buildQuickTrimMasterContent,
    runQuickTrim,
    QuickTrimCancelledError,
    QuickTrimRunError,
    type QuickTrimRunnerDeps,
    type QuickTrimStreamTarget,
} from './quick-trim-runner.js';
import {
    planQuickTrim,
    isQuickTrimRejection,
    type QuickTrimPart,
    type QuickTrimPlan,
} from './quick-trim-plan.js';
import { FfmpegService, type EncodeOptions } from './ffmpeg.service.js';

const SOURCE = '/media/source.mp4';

/** Keyframes every second at 0.62 in, the reference file's video grid. */
function grid(count = 80): number[] {
    return Array.from(
        { length: count },
        (_, i) => Math.round((0.62 + i) * 1e6) / 1e6
    );
}

const VIDEO_DIR = 'stream_v';
const AUDIO_DIR = 'stream_a';

function makePlanFor(
    ranges: { inSec: number; outSec: number }[],
    videoDir = VIDEO_DIR,
    audioDir = AUDIO_DIR
): QuickTrimPlan {
    const result = planQuickTrim({
        streams: [
            { streamDir: videoDir, kind: 'video', keyframes: grid() },
            { streamDir: audioDir, kind: 'audio', keyframes: null },
        ],
        trimSegments: ranges,
        segmentDuration: 6,
    });
    if (isQuickTrimRejection(result)) throw new Error(result.reason);
    return result;
}

function makePlan(
    videoDir = VIDEO_DIR,
    audioDir = AUDIO_DIR,
    range = { inSec: 20, outSec: 40 }
): QuickTrimPlan {
    return makePlanFor([range], videoDir, audioDir);
}

const RENDITION = {
    width: 854,
    height: 480,
    videoBitrateKbps: 2000,
    copyStream: true,
    sourceTrackIndex: 6,
    audioGroupId: 'hd',
    label: '480p',
};

const GROUP = {
    id: 'hd',
    label: 'HD Audio',
    audioBitrateKbps: 128,
    channels: 2,
    audioCodec: 'aac' as const,
    sourceTrackIndex: 0,
    language: 'eng',
    copyStream: true,
};

function targets(): QuickTrimStreamTarget[] {
    return [
        {
            streamDir: VIDEO_DIR,
            kind: 'video',
            sourceTrackIndex: 6,
            rendition: RENDITION,
        },
        {
            streamDir: AUDIO_DIR,
            kind: 'audio',
            sourceTrackIndex: 0,
            group: GROUP,
        },
    ];
}

function encodeConfig(
    ranges: { inSec: number; outSec: number }[] = [{ inSec: 20, outSec: 40 }]
): EncodeConfigDto {
    return {
        type: 'video',
        segmentDuration: 6,
        videoRenditions: [RENDITION],
        audioGroups: [GROUP],
        trimSegments: ranges,
    } as EncodeConfigDto;
}

interface JobCall {
    args: string[];
    label: string;
}

// --- the least fMP4 the runner's retiming pass will accept ----------------
//
// The runner reads the timescale out of every init and rewrites the `tfdt` of
// every segment, so the fake muxer below has to write boxes rather than
// placeholder strings. Only the path those two functions walk is built:
// `moov > trak > {edts > elst, mdia > mdhd}` in the init, and
// `moof > traf > tfdt` in each segment.

function box(type: string, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8, 0);
    header.write(type, 4, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function u32(...values: number[]): Buffer {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
    return buffer;
}

/** An init whose track counts in `timescale`, with an edit list to neutralise. */
function fakeInit(timescale: number, sourceStartMs: number): Buffer {
    return Buffer.concat([
        box('ftyp', Buffer.from('iso6', 'latin1')),
        box(
            'moov',
            box('mvhd', u32(0, 0, 1000, 0)),
            box(
                'trak',
                box(
                    'edts',
                    box(
                        'elst',
                        u32(0, 2),
                        u32(sourceStartMs, 0xffffffff),
                        u32(0, 0)
                    )
                ),
                box('mdia', box('mdhd', u32(0, 0, 0, timescale, 0)))
            )
        ),
    ]);
}

/** A one-fragment segment whose `tfdt` is `ticks`, version 1 as ffmpeg writes. */
function fakeSegment(ticks: number): Buffer {
    const value = Buffer.alloc(8);
    value.writeBigUInt64BE(BigInt(ticks));
    return Buffer.concat([
        box('styp', Buffer.from('msdh', 'latin1')),
        box(
            'moof',
            box('mfhd', u32(0, 1)),
            box(
                'traf',
                box('tfhd', u32(0, 1)),
                box('tfdt', Buffer.from([1, 0, 0, 0]), value),
                box('trun', u32(0, 1))
            )
        ),
        box('mdat', Buffer.from('payload')),
    ]);
}

/** The `baseMediaDecodeTime` of a written segment. */
function readTfdt(path: string): number {
    const buffer = readFileSync(path);
    const at = buffer.indexOf(Buffer.from('tfdt', 'latin1'));
    expect(at).toBeGreaterThan(0);
    return Number(buffer.readBigUInt64BE(at + 8));
}

function initHasEditList(path: string): boolean {
    return readFileSync(path).includes(Buffer.from('edts', 'latin1'));
}

/**
 * Stands in for the muxer: writes the init, the segments and the part playlist
 * the real job would have produced, reading the filenames out of the arguments
 * exactly as ffmpeg does. Segment durations are deliberately a flat 6s so the
 * assembly's final-segment clamp has something to correct, and each segment's
 * `tfdt` counts from zero within the run — the convention that makes the
 * runner's retiming pass necessary.
 */
function fakeMuxer(calls: JobCall[]) {
    return async (
        args: string[],
        onTime: (seconds: number) => void,
        label: string
    ): Promise<void> => {
        calls.push({ args, label });
        const value = (flag: string): string => args[args.indexOf(flag) + 1];
        const playlistPath = args[args.length - 1];
        const dir = playlistPath.slice(0, playlistPath.lastIndexOf('/'));
        const init = value('-hls_fmp4_init_filename');
        const start = parseInt(value('-start_number'), 10);
        const to = parseFloat(value('-to'));
        const from = parseFloat(args[args.indexOf('-ss') + 1]);
        const span = Number.isFinite(to) ? Math.max(to - from, 1) : 1;
        // How many segments the target duration buys — the durations written
        // below stay a flat 6 s regardless, so the assembly's clamp has
        // something to correct.
        const target = parseFloat(value('-hls_time')) || 6;
        const count = Math.max(1, Math.ceil(span / target));
        // The audio recipe is the one carrying `-c:a`; 48 kHz against the
        // video's 90 kHz, so a wrong timescale cannot pass unnoticed.
        const timescale = args.includes('-c:a') ? 48000 : 90000;

        await mkdir(dir, { recursive: true });
        await writeFile(
            join(dir, init),
            fakeInit(timescale, Math.round(from * 1000))
        );
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:6',
            `#EXT-X-MEDIA-SEQUENCE:${start}`,
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-INDEPENDENT-SEGMENTS',
            `#EXT-X-MAP:URI="${init}"`,
        ];
        for (let i = 0; i < count; i++) {
            const name = `segment_${String(start + i).padStart(7, '0')}.m4s`;
            await writeFile(
                join(dir, name),
                fakeSegment(Math.round(i * 6 * timescale))
            );
            lines.push('#EXTINF:6.000000,', name);
        }
        lines.push('#EXT-X-ENDLIST', '');
        await writeFile(playlistPath, lines.join('\n'));

        onTime(0);
        onTime(1e9);
    };
}

function deps(
    overrides: Partial<QuickTrimRunnerDeps> &
        Pick<QuickTrimRunnerDeps, 'runJob'>
): QuickTrimRunnerDeps {
    return {
        accelMode: 'cpu',
        targets: targets(),
        isCancelled: () => false,
        logger: {
            log: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        },
        ...overrides,
    };
}

function options(
    outputDir: string,
    ranges?: { inSec: number; outSec: number }[]
): EncodeOptions {
    return {
        sessionId: 'sess-1',
        inputPath: SOURCE,
        outputDir,
        encodeConfig: encodeConfig(ranges),
        onProgress: vi.fn(),
    };
}

/** First PTS values the measurement probe returns, consumed in call order. */
let ptsAnswers: number[] = [];

describe('quick trim runner', () => {
    let outputDir: string;

    beforeEach(() => {
        outputDir = mkdtempSync(join(tmpdir(), 'quick-trim-'));
        ptsAnswers = [];
        mockExecFile.mockReset();
        mockSpawn.mockReset();
        mockExecFile.mockImplementation((...args: any[]) => {
            const argv: string[] = args[1] ?? [];
            const cb = args[args.length - 1];
            let stdout = '';
            if (argv.includes('stream=pix_fmt,profile,r_frame_rate')) {
                stdout = JSON.stringify({
                    streams: [
                        {
                            pix_fmt: 'yuv420p',
                            profile: 'Main',
                            r_frame_rate: '50/1',
                        },
                    ],
                });
            } else if (argv.includes('packet=pts_time')) {
                const next = ptsAnswers.shift();
                stdout = next === undefined ? '' : `${next}\n`;
            }
            if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
        });
    });

    afterEach(() => {
        rmSync(outputDir, { recursive: true, force: true });
    });

    describe('command construction', () => {
        const part: QuickTrimPart = {
            kind: 'copy',
            partIndex: 1,
            startNumber: 100000,
            start: 20.62,
            end: 39.62,
            ownInit: true,
        };

        it('copies a video part with an input seek and -copyts', () => {
            expect(
                buildCopyPartArgs({
                    inputPath: SOURCE,
                    streamDirPath: '/out/stream_v',
                    kind: 'video',
                    sourceTrackIndex: 6,
                    part,
                    seekStart: part.start,
                    segmentDuration: 6,
                })
            ).toEqual([
                '-ss',
                '20.62',
                '-i',
                SOURCE,
                '-progress',
                'pipe:2',
                '-stats_period',
                '1',
                '-map',
                '0:v:6',
                '-c:v',
                'copy',
                '-copyts',
                '-to',
                '39.62',
                '-f',
                'hls',
                '-hls_time',
                '6',
                '-hls_playlist_type',
                'vod',
                '-hls_flags',
                'independent_segments',
                '-hls_segment_type',
                'fmp4',
                '-movflags',
                '+negative_cts_offsets+default_base_moof',
                '-hls_fmp4_init_filename',
                'init_1.mp4',
                '-start_number',
                '100000',
                '-hls_segment_filename',
                '/out/stream_v/segment_%07d.m4s',
                '-y',
                '/out/stream_v/part_1.m3u8',
            ]);
        });

        it('cuts an audio part on the output side with a restored clock', () => {
            const args = buildCopyPartArgs({
                inputPath: SOURCE,
                streamDirPath: '/out/stream_a',
                kind: 'audio',
                sourceTrackIndex: 0,
                part,
                seekStart: part.start,
                segmentDuration: 6,
            });
            expect(args.slice(0, 16)).toEqual([
                '-ss',
                '18.62',
                '-i',
                SOURCE,
                '-progress',
                'pipe:2',
                '-stats_period',
                '1',
                '-map',
                '0:a:0',
                '-c:a',
                'copy',
                '-copyts',
                '-ss',
                '20.62',
                '-to',
            ]);
            expect(args).toContain('-output_ts_offset');
            expect(args[args.indexOf('-output_ts_offset') + 1]).toBe('20.62');
            expect(args[args.indexOf('-start_number') + 1]).toBe('100000');
            expect(args[args.length - 1]).toBe('/out/stream_a/part_1.m3u8');
        });

        it('bridges with a pre-roll seek and a trim filter on the CPU', () => {
            const bridge: QuickTrimPart = {
                kind: 'bridge',
                partIndex: 0,
                startNumber: 0,
                start: 20,
                end: 20.62,
                ownInit: true,
            };
            const args = buildBridgeArgs({
                inputPath: SOURCE,
                streamDirPath: '/out/stream_v',
                sourceTrackIndex: 6,
                part: bridge,
                rendition: RENDITION,
                params: {
                    pixFmt: 'yuv420p',
                    profile: 'Main',
                    frameRate: 50,
                },
                accelMode: 'cpu',
                useGpu: false,
            });
            expect(args).toEqual([
                '-ss',
                '18',
                '-copyts',
                '-i',
                SOURCE,
                '-progress',
                'pipe:2',
                '-stats_period',
                '1',
                '-map',
                '0:v:6',
                '-vf',
                'trim=start=20:end=20.62',
                // Stops the decode at the bridge: the trim filter only
                // discards, and without -to a head bridge reads to EOF.
                '-to',
                '20.62',
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-pix_fmt',
                'yuv420p',
                '-profile:v',
                'main',
                '-b:v',
                '2000k',
                '-maxrate',
                '2140k',
                '-bufsize',
                '3000k',
                '-g',
                '9999',
                '-keyint_min',
                '9999',
                '-sc_threshold',
                '0',
                '-f',
                'hls',
                '-hls_time',
                '3600',
                '-hls_playlist_type',
                'vod',
                '-hls_flags',
                'independent_segments',
                '-hls_segment_type',
                'fmp4',
                '-movflags',
                '+negative_cts_offsets+default_base_moof',
                '-hls_fmp4_init_filename',
                'init_0.mp4',
                '-start_number',
                '0',
                '-hls_segment_filename',
                '/out/stream_v/segment_%07d.m4s',
                '-y',
                '/out/stream_v/part_0.m3u8',
            ]);
        });

        it('decodes hardware bridges without a hardware output format', () => {
            const args = buildBridgeArgs({
                inputPath: SOURCE,
                streamDirPath: '/out/stream_v',
                sourceTrackIndex: 0,
                part: {
                    kind: 'bridge',
                    partIndex: 0,
                    startNumber: 0,
                    start: 1,
                    end: 1.5,
                    ownInit: true,
                },
                rendition: RENDITION,
                params: null,
                accelMode: 'apple',
                useGpu: true,
            });
            expect(args.slice(0, 2)).toEqual(['-hwaccel', 'videotoolbox']);
            expect(args).not.toContain('-hwaccel_output_format');
            expect(args).toContain('h264_videotoolbox');
            // Pixel format is the CPU encoder's pin alone.
            expect(args).not.toContain('-pix_fmt');
        });
    });

    describe('measure-retry', () => {
        it('retries once from a bumped seek when the copy lands early', async () => {
            const calls: JobCall[] = [];
            const plan = makePlan();
            // Video part 1 is the only copy part measured; it lands a GOP early
            // on the first attempt and on the mark on the second.
            ptsAnswers = [19.62, 20.62];

            await runQuickTrim(
                deps({ runJob: fakeMuxer(calls) }),
                options(outputDir),
                plan
            );

            const copyCalls = calls.filter(
                (c) => c.label === `${VIDEO_DIR} copy 1`
            );
            expect(copyCalls).toHaveLength(2);
            // First attempt aims one keyframe interval past the intended
            // start (the measured landing rule: largest keyframe at or
            // before target minus one GOP).
            expect(parseFloat(copyCalls[0].args[1])).toBeCloseTo(21.621, 3);
            // Retry re-aims by the observed hop: 20.62 + (21.621 - 19.62)
            expect(parseFloat(copyCalls[1].args[1])).toBeCloseTo(22.621, 3);

            // The retry's shorter seek means three segments where the first
            // attempt wrote four — so four left behind would show here.
            const files = readdirSync(join(outputDir, VIDEO_DIR));
            expect(files.filter((f) => f.startsWith('segment_01')).length).toBe(
                3
            );
        });

        it('throws a QuickTrimRunError naming the part after two misses', async () => {
            const calls: JobCall[] = [];
            ptsAnswers = [19.62, 18.62];

            const error = await runQuickTrim(
                deps({ runJob: fakeMuxer(calls) }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect(error).toBeInstanceOf(QuickTrimRunError);
            expect((error as QuickTrimRunError).streamDir).toBe(VIDEO_DIR);
            expect((error as QuickTrimRunError).partIndex).toBe(1);
            expect((error as Error).message).toContain('19.620');
        });

        it('does not measure audio parts at all', async () => {
            const calls: JobCall[] = [];
            ptsAnswers = [20.62];

            await runQuickTrim(
                deps({ runJob: fakeMuxer(calls) }),
                options(outputDir),
                makePlan()
            );

            // The audio stream's three copy parts are one job.
            expect(
                calls.filter((c) => c.label.startsWith(AUDIO_DIR))
            ).toHaveLength(1);
            // One measurement, for the single video copy job.
            expect(ptsAnswers).toHaveLength(0);
        });
    });

    describe('assembly', () => {
        async function run(): Promise<void> {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                options(outputDir),
                makePlan()
            );
        }

        it('maps only the parts the plan gave their own init', async () => {
            await run();

            const video = parseMediaPlaylist(
                readFileSync(
                    join(outputDir, VIDEO_DIR, 'playlist.m3u8'),
                    'utf8'
                )
            );
            // Bridge, copy after a bridge, bridge — every part introduces a new
            // decoder configuration.
            expect(video.maps.map((m) => m.uri)).toEqual([
                'init_0.mp4',
                'init_1.mp4',
                'init_2.mp4',
            ]);

            const audio = readFileSync(
                join(outputDir, AUDIO_DIR, 'playlist.m3u8'),
                'utf8'
            );
            expect(parseMediaPlaylist(audio).maps.map((m) => m.uri)).toEqual([
                'init_0.mp4',
            ]);
        });

        it('puts a discontinuity between every pair of parts', async () => {
            await run();

            for (const dir of [VIDEO_DIR, AUDIO_DIR]) {
                const text = readFileSync(
                    join(outputDir, dir, 'playlist.m3u8'),
                    'utf8'
                );
                expect(text.match(/#EXT-X-DISCONTINUITY/g) ?? []).toHaveLength(
                    2
                );
            }
        });

        it('clamps each part to its planned duration', async () => {
            await run();

            const video = parseMediaPlaylist(
                readFileSync(
                    join(outputDir, VIDEO_DIR, 'playlist.m3u8'),
                    'utf8'
                )
            );
            const total = video.segments.reduce(
                (sum, s) => sum + s.duration,
                0
            );
            // The fake muxer writes 6s segments regardless; 0.62 + 19 + 0.38.
            expect(total).toBeCloseTo(20, 6);
            expect(video.segments[0].duration).toBeCloseTo(0.62, 6);
            expect(
                video.segments[video.segments.length - 1].duration
            ).toBeCloseTo(0.38, 6);
        });

        it('deletes the part playlists and every unreferenced init', async () => {
            await run();

            const video = readdirSync(join(outputDir, VIDEO_DIR));
            expect(video.filter((f) => f.startsWith('part_'))).toEqual([]);
            expect(video.filter((f) => f.startsWith('init_')).sort()).toEqual([
                'init_0.mp4',
                'init_1.mp4',
                'init_2.mp4',
            ]);

            const audio = readdirSync(join(outputDir, AUDIO_DIR));
            expect(audio.filter((f) => f.startsWith('part_'))).toEqual([]);
            // Parts 1 and 2 continue part 0's init, so theirs would never be
            // fetched — and would still be uploaded if left behind.
            expect(audio.filter((f) => f.startsWith('init_'))).toEqual([
                'init_0.mp4',
            ]);
        });

        it('maps every part at the init its job wrote when forced to', async () => {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]), mapEveryPart: true }),
                options(outputDir),
                makePlan()
            );

            const audio = parseMediaPlaylist(
                readFileSync(
                    join(outputDir, AUDIO_DIR, 'playlist.m3u8'),
                    'utf8'
                )
            );
            // One job produced all three parts, so there is one init to point
            // at — the map is repeated, not multiplied.
            expect(audio.maps.map((m) => m.uri)).toEqual([
                'init_0.mp4',
                'init_0.mp4',
                'init_0.mp4',
            ]);
            expect(
                readdirSync(join(outputDir, AUDIO_DIR)).filter((f) =>
                    f.startsWith('init_')
                )
            ).toEqual(['init_0.mp4']);
        });
    });

    describe('the output timeline', () => {
        /**
         * Every job is muxed on its own and so counts its fragments from zero.
         * A player reading `tfdt` and ignoring the edit list — which is what
         * the players this output is for do — would then stack every part at
         * the same instant, and since video and audio parts end on different
         * grids, the difference lands on the audio as desync. So the runner
         * rewrites each segment onto the finished playlist's clock.
         */
        it('puts each part where the playlist puts it', async () => {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                options(outputDir),
                makePlan()
            );

            const dir = join(outputDir, VIDEO_DIR);
            const at = (name: string): number => readTfdt(join(dir, name));
            const ticks = (seconds: number): number =>
                Math.round(seconds * 90000);

            // The head bridge is the output's own zero.
            expect(at('segment_0000000.m4s')).toBe(0);
            // The copy job starts after it, and its segments keep the 6 s
            // spacing the muxer gave them.
            expect(at('segment_0100000.m4s')).toBe(ticks(0.62));
            expect(at('segment_0100001.m4s')).toBe(ticks(6.62));
            expect(at('segment_0100002.m4s')).toBe(ticks(12.62));
            // The tail bridge follows the copy span's *planned* 19 s, not the
            // 24 s of segments the muxer happened to write.
            expect(at('segment_0200000.m4s')).toBe(ticks(19.62));
        });

        it('counts in each stream’s own timescale', async () => {
            ptsAnswers = [20.62, 60.62];
            const ranges = [
                { inSec: 20, outSec: 40 },
                { inSec: 60, outSec: 80 },
            ];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]), concurrency: 1 }),
                options(outputDir, ranges),
                makePlanFor(ranges)
            );

            const audio = join(outputDir, AUDIO_DIR);
            // One job per kept range. The second starts 20 s into the output,
            // and audio counts at 48 kHz where video counts at 90 kHz.
            expect(readTfdt(join(audio, 'segment_0000000.m4s'))).toBe(0);
            expect(readTfdt(join(audio, 'segment_0300000.m4s'))).toBe(
                20 * 48000
            );
            expect(readTfdt(join(audio, 'segment_0300001.m4s'))).toBe(
                26 * 48000
            );

            // The video stream's second range starts at the same instant.
            const video = join(outputDir, VIDEO_DIR);
            expect(readTfdt(join(video, 'segment_0300000.m4s'))).toBe(
                Math.round(20 * 90000)
            );
        });

        it('neutralises the edit list of every init it keeps', async () => {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                options(outputDir),
                makePlan()
            );

            for (const dir of [VIDEO_DIR, AUDIO_DIR]) {
                const streamDir = join(outputDir, dir);
                for (const name of readdirSync(streamDir).filter((f) =>
                    f.startsWith('init_')
                )) {
                    expect(
                        initHasEditList(join(streamDir, name)),
                        `${dir}/${name} still carries an edit list`
                    ).toBe(false);
                }
            }
        });

        it('fails the run rather than ship an unreadable segment', async () => {
            const muxer = fakeMuxer([]);
            ptsAnswers = [20.62];

            const error = await runQuickTrim(
                deps({
                    concurrency: 1,
                    runJob: async (args, onTime, label) => {
                        await muxer(args, onTime, label);
                        if (!label.startsWith(AUDIO_DIR)) return;
                        // What a truncated write leaves behind.
                        const playlist = args[args.length - 1];
                        const dir = playlist.slice(
                            0,
                            playlist.lastIndexOf('/')
                        );
                        await writeFile(
                            join(dir, 'segment_0000000.m4s'),
                            'not an fmp4 segment'
                        );
                    },
                }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect(error).toBeInstanceOf(QuickTrimRunError);
            expect((error as Error).message).toContain(
                'moved onto the output timeline'
            );
        });
    });

    describe('job grouping', () => {
        function parts(
            spec: [QuickTrimPart['kind'], number, number, number][]
        ): QuickTrimPart[] {
            return spec.map(([kind, rangeIndex, start, end], index) => ({
                kind,
                partIndex: index,
                rangeIndex,
                startNumber: index * 100000,
                start,
                end,
                ownInit: true,
            }));
        }

        it('collapses a range into one copy job and leaves bridges alone', () => {
            const jobs = buildQuickTrimJobs(
                parts([
                    ['bridge', 0, 20, 20.62],
                    ['copy', 0, 20.62, 39.62],
                    ['copy', 0, 39.62, 40],
                ]),
                6
            );

            expect(
                jobs.map((j) => [j.kind, j.start, j.end, j.parts.length])
            ).toEqual([
                ['bridge', 20, 20.62, 1],
                ['copy', 20.62, 40, 2],
            ]);
        });

        it('does not join one range to the next across a shared instant', () => {
            const jobs = buildQuickTrimJobs(
                parts([
                    ['copy', 0, 20, 40],
                    ['copy', 1, 40, 60],
                ]),
                6
            );

            expect(jobs.map((j) => [j.start, j.end])).toEqual([
                [20, 40],
                [40, 60],
            ]);
        });

        it('runs the parts separately when one job cannot fill them all', () => {
            // 10 s at a 6 s target duration is two segments, and three parts
            // cannot be cut out of two segments.
            const jobs = buildQuickTrimJobs(
                parts([
                    ['copy', 0, 0, 2],
                    ['copy', 0, 2, 8],
                    ['copy', 0, 8, 10],
                ]),
                6
            );

            expect(jobs.map((j) => [j.start, j.end])).toEqual([
                [0, 2],
                [2, 8],
                [8, 10],
            ]);
        });
    });

    describe('collapsed copy jobs', () => {
        it('distributes one job’s segments across its parts', async () => {
            const calls: JobCall[] = [];
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer(calls) }),
                options(outputDir),
                makePlan()
            );

            // One job for the audio stream's whole 20 s range...
            const audioCalls = calls.filter((c) =>
                c.label.startsWith(AUDIO_DIR)
            );
            expect(audioCalls).toHaveLength(1);
            expect(
                audioCalls[0].args[audioCalls[0].args.indexOf('-to') + 1]
            ).toBe('40');

            // ...whose four 6 s segments still author three parts. The planned
            // junctions (0.62 s and 19.62 s into the range) snap to the nearest
            // segment boundary: after the first, and after the third.
            const text = readFileSync(
                join(outputDir, AUDIO_DIR, 'playlist.m3u8'),
                'utf8'
            );
            const counts = text
                .split('#EXT-X-DISCONTINUITY')
                .map((chunk) => (chunk.match(/#EXTINF/g) ?? []).length);
            expect(counts).toEqual([1, 2, 1]);

            const audio = parseMediaPlaylist(text);
            expect(
                audio.segments.reduce((sum, s) => sum + s.duration, 0)
            ).toBeCloseTo(20, 6);
            // Every segment is the job's own, numbered from its first part.
            expect(audio.segments.map((s) => s.uri)).toEqual([
                'segment_0000000.m4s',
                'segment_0000001.m4s',
                'segment_0000002.m4s',
                'segment_0000003.m4s',
            ]);
        });

        it('fails the run when a job wrote fewer segments than it has parts', async () => {
            const muxer = fakeMuxer([]);
            ptsAnswers = [20.62];

            const error = await runQuickTrim(
                deps({
                    concurrency: 1,
                    runJob: async (args, onTime, label) => {
                        if (!label.startsWith(AUDIO_DIR))
                            return muxer(args, onTime, label);
                        // One segment where the plan needs three parts split
                        // out of it.
                        const to = args[args.indexOf('-to') + 1];
                        const shortened = [...args];
                        shortened[shortened.indexOf('-hls_time') + 1] = to;
                        return muxer(shortened, onTime, label);
                    },
                }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect(error).toBeInstanceOf(QuickTrimRunError);
            expect((error as Error).message).toContain('1 segment(s)');
            expect((error as Error).message).toContain('3 planned part(s)');
        });
    });

    describe('cancellation', () => {
        it('stops before the next job once the active one was killed', async () => {
            const calls: JobCall[] = [];
            let cancelled = false;
            const muxer = fakeMuxer(calls);

            const error = await runQuickTrim(
                deps({
                    concurrency: 1,
                    isCancelled: () => cancelled,
                    runJob: async (args, onTime, label) => {
                        await muxer(args, onTime, label);
                        cancelled = true;
                    },
                }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect(error).toBeInstanceOf(QuickTrimCancelledError);
            expect(calls).toHaveLength(1);
            expect(
                existsSync(join(outputDir, VIDEO_DIR, 'playlist.m3u8'))
            ).toBe(false);
        });

        it('reports a cancel as a cancel even when the killed job errored', async () => {
            let cancelled = false;

            const error = await runQuickTrim(
                deps({
                    concurrency: 1,
                    isCancelled: () => cancelled,
                    runJob: async () => {
                        cancelled = true;
                        // What a SIGTERMed child looks like to the runner.
                        throw new Error('FFmpeg exited with code 255');
                    },
                }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect(error).toBeInstanceOf(QuickTrimCancelledError);
        });
    });

    describe('the job pool', () => {
        it('runs jobs from several streams at once', async () => {
            let running = 0;
            let peak = 0;
            const muxer = fakeMuxer([]);
            ptsAnswers = [20.62];

            await runQuickTrim(
                deps({
                    runJob: async (args, onTime, label) => {
                        running += 1;
                        peak = Math.max(peak, running);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        await muxer(args, onTime, label);
                        running -= 1;
                    },
                }),
                options(outputDir),
                makePlan()
            );

            // Three video jobs and one audio job, all four in flight together.
            expect(peak).toBe(4);
        });

        it('stops at the first failure, killing the jobs beside it', async () => {
            const started: string[] = [];
            const abort = new Set<(reason: Error) => void>();
            const killRunningJobs = vi.fn(() => {
                for (const reject of abort) reject(new Error('killed'));
                abort.clear();
            });

            const error = await runQuickTrim(
                deps({
                    killRunningJobs,
                    runJob: async (_args, _onTime, label) => {
                        started.push(label);
                        if (label === `${VIDEO_DIR} copy 1`) {
                            throw new Error('FFmpeg exited with code 1');
                        }
                        // The losers outlive the failure and end only because
                        // the pool killed them — and none of them may leave an
                        // unhandled rejection behind (vitest fails the run on
                        // one).
                        await new Promise<void>((_resolve, reject) =>
                            abort.add(reject)
                        );
                    },
                }),
                options(outputDir),
                makePlan()
            ).catch((e) => e);

            expect((error as Error).message).toContain('code 1');
            expect(killRunningJobs).toHaveBeenCalledTimes(1);
            expect(started).toHaveLength(4);
            // Nothing was authored from a run that was abandoned.
            expect(
                existsSync(join(outputDir, VIDEO_DIR, 'playlist.m3u8'))
            ).toBe(false);
        });
    });

    describe('outputs beside the segments', () => {
        it('writes the kept ranges as an ffconcat list', async () => {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                options(outputDir),
                makePlan()
            );

            expect(readFileSync(join(outputDir, 'concat.txt'), 'utf8')).toBe(
                [
                    'ffconcat version 1.0',
                    `file '${SOURCE}'`,
                    'inpoint 20',
                    'outpoint 40',
                ].join('\n')
            );
        });

        it('reports progress monotonically and finishes at 100', async () => {
            ptsAnswers = [20.62];
            const opts = options(outputDir);
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                opts,
                makePlan()
            );

            const reported = (opts.onProgress as any).mock.calls.map(
                (c: number[]) => c[0]
            );
            expect(reported.length).toBeGreaterThan(1);
            expect([...reported].sort((a, b) => a - b)).toEqual(reported);
            expect(reported[reported.length - 1]).toBe(100);
        });

        it('authors a master from the config, without CODECS', async () => {
            ptsAnswers = [20.62];
            await runQuickTrim(
                deps({ runJob: fakeMuxer([]) }),
                options(outputDir),
                makePlan()
            );

            expect(readFileSync(join(outputDir, 'master.m3u8'), 'utf8')).toBe(
                [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hd",NAME="eng",' +
                        'DEFAULT=YES,LANGUAGE="eng",URI="stream_a/playlist.m3u8"',
                    '',
                    '#EXT-X-STREAM-INF:BANDWIDTH=2128000,RESOLUTION=854x480,' +
                        'AUDIO="hd"',
                    'stream_v/playlist.m3u8',
                    '',
                ].join('\n')
            );
        });
    });

    describe('master authoring', () => {
        it('emits a VIDEO rendition group per angle on a multi-angle config', () => {
            const config = {
                type: 'video',
                videoRenditions: [
                    { ...RENDITION, sourceTrackIndex: 0 },
                    { ...RENDITION, sourceTrackIndex: 1 },
                ],
                audioGroups: [GROUP],
                videoTrackNames: [
                    { index: 0, name: 'Main angle' },
                    { index: 1, name: 'Side angle' },
                ],
            } as EncodeConfigDto;
            const master = buildQuickTrimMasterContent(config, [
                {
                    streamDir: 'stream_a0',
                    kind: 'video',
                    sourceTrackIndex: 0,
                    rendition: config.videoRenditions![0],
                },
                {
                    streamDir: 'stream_a1',
                    kind: 'video',
                    sourceTrackIndex: 1,
                    rendition: config.videoRenditions![1],
                },
                {
                    streamDir: AUDIO_DIR,
                    kind: 'audio',
                    sourceTrackIndex: 0,
                    group: GROUP,
                },
            ]);

            expect(master).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Main_angle",' +
                    'NAME="Main angle",DEFAULT=YES'
            );
            expect(master).toContain(
                '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Side_angle",' +
                    'NAME="Side angle",DEFAULT=NO'
            );
            expect(master).toContain('VIDEO="Main_angle",AUDIO="hd"');
            expect(master).toContain('VIDEO="Side_angle",AUDIO="hd"');
            expect(master).not.toContain('CODECS=');
        });

        it('authors an audio-only master when there is no video', () => {
            const master = buildQuickTrimMasterContent(
                { type: 'audio', audioGroups: [GROUP] } as EncodeConfigDto,
                [
                    {
                        streamDir: AUDIO_DIR,
                        kind: 'audio',
                        sourceTrackIndex: 0,
                        group: GROUP,
                    },
                ]
            );

            expect(master).toContain(
                '#EXT-X-STREAM-INF:BANDWIDTH=128000,AUDIO="hd"'
            );
            expect(master).toContain('stream_a/playlist.m3u8');
            expect(master).not.toContain('RESOLUTION');
        });
    });

    describe('FfmpegService.encodeQuickTrim', () => {
        function mockProcess(): ChildProcess & {
            emitClose: (code: number) => void;
        } {
            const proc = new EventEmitter() as any;
            proc.stderr = new EventEmitter();
            proc.stdout = { resume: vi.fn() };
            proc.kill = vi.fn();
            proc.killed = false;
            proc.emitClose = (code: number) => proc.emit('close', code, null);
            return proc;
        }

        it('runs every job as a child of its own', async () => {
            const service = new FfmpegService();
            // Detection has not run here; without a mode the encoder module
            // refuses to name one, which is the point of it.
            (service as any).accelMode = 'cpu';
            const spawned: string[][] = [];
            const muxer = fakeMuxer([]);

            mockSpawn.mockImplementation((_bin: string, args: string[]) => {
                spawned.push(args);
                const proc = mockProcess();
                void muxer(args, () => {}, 'job').then(() => {
                    proc.stderr!.emit(
                        'data',
                        Buffer.from('out_time_us=1000000\n')
                    );
                    proc.emitClose(0);
                });
                return proc;
            });
            ptsAnswers = [20.62];

            const opts = options(outputDir);
            const result = await service.encodeQuickTrim(
                opts,
                makePlan('stream_480p_854x480', 'stream_hd_HD_Audio')
            );

            expect(result).toEqual({
                outputDir,
                masterPlaylist: 'master.m3u8',
                segmentFormat: 'fmp4',
                alignmentOffset: 0,
            });
            // Two bridges and one copy job for the video stream, one collapsed
            // copy job for the audio stream, no retries.
            expect(spawned).toHaveLength(4);
            expect(spawned[0]).toContain('-copyts');
        });

        it('derives the stream directories the plan is keyed by', () => {
            const service = new FfmpegService();
            // Detection has not run here; without a mode the encoder module
            // refuses to name one, which is the point of it.
            (service as any).accelMode = 'cpu';
            expect(
                service
                    .quickTrimStreamTargets(encodeConfig())
                    .map((t) => t.streamDir)
            ).toEqual(['stream_480p_854x480', 'stream_hd_HD_Audio']);
        });
    });
});
