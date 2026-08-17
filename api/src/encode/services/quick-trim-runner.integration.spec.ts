/**
 * Quick trim against a real file with a real ffmpeg — the only place the
 * measured recipes are actually measured. Skipped wherever the reference source
 * is not present, which is everywhere but the machine it was captured on.
 *
 * Separate from `quick-trim-runner.spec.ts` because that file mocks
 * `child_process`, and this one must not.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';
import {
    parseMasterPlaylist,
    parseMediaPlaylist,
} from '@luminary-media-converter/hls';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { FfmpegService } from './ffmpeg.service.js';
import {
    planQuickTrim,
    isQuickTrimRejection,
    PART_NUMBER_STRIDE,
    type QuickTrimPlan,
} from './quick-trim-plan.js';

const execFileAsync = promisify(execFile);

const REFERENCE =
    '/Users/ivanslabbert/Downloads/20260705_1045_VOD-00.03.37.439-00.06.22.437.mp4';

/** Video track 6 and audio track 0 of the reference file (854x480, AAC 48k). */
const VIDEO_TRACK = 6;
const AUDIO_TRACK = 0;
const FRAME_RATE = 50;
const RANGES = [
    { inSec: 20, outSec: 40 },
    { inSec: 80, outSec: 100 },
];

const VIDEO_DIR = 'stream_480p_854x480';
const AUDIO_DIR = 'stream_hd_HD_Audio';

function encodeConfig(): EncodeConfigDto {
    return {
        type: 'video',
        segmentDuration: 6,
        videoRenditions: [
            {
                width: 854,
                height: 480,
                videoBitrateKbps: 2000,
                copyStream: true,
                sourceTrackIndex: VIDEO_TRACK,
                audioGroupId: 'hd',
                label: '480p',
            },
        ],
        audioGroups: [
            {
                id: 'hd',
                label: 'HD Audio',
                audioBitrateKbps: 128,
                channels: 2,
                audioCodec: 'aac',
                sourceTrackIndex: AUDIO_TRACK,
                language: 'eng',
                copyStream: true,
            },
        ],
        trimSegments: RANGES,
    } as EncodeConfigDto;
}

/**
 * The track's keyframe times in the source's own clock.
 *
 * `FfmpegService.scanKeyframeGrid` is deliberately not used: it runs the same
 * `-f segment` scan without `-copyts`, so every time it reports is short by the
 * container's start time (0.06 s on this file) and none of them is a keyframe
 * the seek can land on. Reported to the phase that owns that scanner.
 */
async function scanGrid(tmpDir: string): Promise<number[]> {
    await mkdir(tmpDir, { recursive: true });
    const csvPath = join(tmpDir, 'keyframes.csv');
    await execFileAsync(
        'ffmpeg',
        [
            '-v',
            'error',
            '-copyts',
            '-i',
            REFERENCE,
            '-map',
            `0:v:${VIDEO_TRACK}`,
            '-c:v',
            'copy',
            '-an',
            '-avoid_negative_ts',
            'disabled',
            '-f',
            'segment',
            '-segment_time',
            '0.000001',
            '-segment_list',
            csvPath,
            '-segment_list_type',
            'csv',
            '-y',
            join(tmpDir, 'seg%d.ts'),
        ],
        { timeout: 120_000 }
    );
    const grid = (await readFile(csvPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseFloat(line.split(',')[1]))
        .filter((value) => Number.isFinite(value));
    await rm(tmpDir, { recursive: true, force: true });
    return grid;
}

/**
 * One segment of an authored playlist, and where the playlist puts it.
 *
 * `partIndex` comes from the segment number rather than from the playlist's
 * maps: a job numbers every segment it writes from its *first* part's stride
 * (`partIndex * PART_NUMBER_STRIDE`), and that first part is exactly the one
 * whose init the job wrote — so the number names the init to probe against.
 */
interface PlaylistSegment {
    uri: string;
    duration: number;
    /** Cumulative position in the finished playlist, seconds. */
    start: number;
    partIndex: number;
}

function playlistSegments(streamDirPath: string): PlaylistSegment[] {
    const playlist = parseMediaPlaylist(
        readFileSync(join(streamDirPath, 'playlist.m3u8'), 'utf8')
    );
    let start = 0;
    return playlist.segments.map((segment) => {
        const entry: PlaylistSegment = {
            uri: segment.uri,
            duration: segment.duration,
            start,
            partIndex: Math.floor(
                parseInt(segment.uri.slice('segment_'.length), 10) /
                    PART_NUMBER_STRIDE
            ),
        };
        start += segment.duration;
        return entry;
    });
}

/**
 * Packet times of an init plus one or more of its segments.
 *
 * Both clocks are read: after the runner's retiming the edit lists are gone, so
 * `dts` is the `tfdt` the players actually place samples by, and `pts` is that
 * plus the stream's composition (B-frame reorder) delay.
 */
async function probeTimes(
    streamDirPath: string,
    partIndex: number,
    segmentUris: string[],
    kind: 'video' | 'audio'
): Promise<{ pts: number[]; dts: number[] }> {
    const probePath = join(streamDirPath, `probe_${partIndex}.mp4`);
    await writeFile(
        probePath,
        Buffer.concat([
            await readFile(join(streamDirPath, `init_${partIndex}.mp4`)),
            ...(await Promise.all(
                segmentUris.map((uri) => readFile(join(streamDirPath, uri)))
            )),
        ])
    );
    try {
        const { stdout } = await execFileAsync(
            'ffprobe',
            [
                '-v',
                'error',
                '-select_streams',
                kind === 'video' ? 'v:0' : 'a:0',
                '-show_entries',
                'packet=pts_time,dts_time',
                '-of',
                'csv=p=0',
                probePath,
            ],
            { maxBuffer: 64 * 1024 * 1024 }
        );
        const pts: number[] = [];
        const dts: number[] = [];
        for (const line of String(stdout).trim().split('\n')) {
            const [p, d] = line.split(',');
            if (Number.isFinite(parseFloat(p))) pts.push(parseFloat(p));
            if (Number.isFinite(parseFloat(d))) dts.push(parseFloat(d));
        }
        return { pts, dts };
    } finally {
        await unlink(probePath).catch(() => {});
    }
}

/** Every segment of a stream, probed against the init of its own part. */
async function probeStream(
    streamDirPath: string,
    kind: 'video' | 'audio'
): Promise<(PlaylistSegment & { firstPts: number; firstDts: number })[]> {
    const probed: (PlaylistSegment & {
        firstPts: number;
        firstDts: number;
    })[] = [];
    for (const segment of playlistSegments(streamDirPath)) {
        const times = await probeTimes(
            streamDirPath,
            segment.partIndex,
            [segment.uri],
            kind
        );
        probed.push({
            ...segment,
            firstPts: Math.min(...times.pts),
            firstDts: Math.min(...times.dts),
        });
    }
    return probed;
}

const available = existsSync(REFERENCE);

describe.skipIf(!available)('quick trim runner (reference file)', () => {
    let outputDir: string;
    let plan: QuickTrimPlan;
    let warnings: string[];
    let progress: number[];

    beforeAll(async () => {
        outputDir = mkdtempSync(join(tmpdir(), 'quick-trim-real-'));
        const keyframes = await scanGrid(join(outputDir, 'grid-scan'));

        const planned = planQuickTrim({
            streams: [
                { streamDir: VIDEO_DIR, kind: 'video', keyframes },
                { streamDir: AUDIO_DIR, kind: 'audio', keyframes: null },
            ],
            trimSegments: RANGES,
            segmentDuration: 6,
        });
        if (isQuickTrimRejection(planned)) throw new Error(planned.reason);
        plan = planned;

        warnings = [];
        vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => {
            warnings.push(String(args[0]));
        });
        progress = [];

        const service = new FfmpegService();
        await service.encodeQuickTrim(
            {
                sessionId: 'integration',
                inputPath: REFERENCE,
                outputDir,
                encodeConfig: encodeConfig(),
                onProgress: (percent) => progress.push(percent),
            },
            plan
        );

        console.log(
            `quick trim: ${plan.streams.length} streams, ` +
                `${plan.streams[0].parts.length} parts each, ` +
                `${warnings.filter((w) => w.includes('retrying')).length} seek retries`
        );
    }, 600_000);

    /**
     * The property the whole output rests on: every stream reads as one
     * continuous timeline starting at zero, whose instants are the playlist's
     * own — not the source's, and not each part's private zero.
     *
     * Measured on `tfdt` (the packet's decode time, which is what the fragment
     * carries and what a player anchors a discontinuity domain to) rather than
     * on `pts`: presentation leads decode by the stream's B-frame reorder
     * delay, which is a property of the bitstream and identical before and
     * after the retiming. It is reported alongside, and pinned as *constant*
     * below, because a delay that varied part to part would be A/V drift.
     */
    it.each([
        { dir: VIDEO_DIR, kind: 'video' as const, tolerance: 0.5 / FRAME_RATE },
        { dir: AUDIO_DIR, kind: 'audio' as const, tolerance: 1024 / 48000 },
    ])(
        'starts every $kind segment where the playlist says',
        async ({ dir, kind, tolerance }) => {
            const probed = await probeStream(join(outputDir, dir), kind);
            expect(probed.length).toBeGreaterThan(plan.streams[0].parts.length);

            console.log(`\n${dir} (${kind})`);
            console.log(
                '  part  segment              playlist      dts      pts'
            );
            for (const segment of probed) {
                console.log(
                    `  ${String(segment.partIndex).padStart(4)}  ${segment.uri}  ` +
                        `${segment.start.toFixed(3).padStart(8)} ` +
                        `${segment.firstDts.toFixed(3).padStart(8)} ` +
                        `${segment.firstPts.toFixed(3).padStart(8)}`
                );
            }

            for (const segment of probed) {
                expect(
                    Math.abs(segment.firstDts - segment.start),
                    `${dir}/${segment.uri} decodes at ${segment.firstDts}s where ` +
                        `the playlist puts it at ${segment.start}s`
                ).toBeLessThanOrEqual(tolerance);
            }

            // Presentation leads decode by the stream's reorder delay, and that
            // delay may only vary by the one frame a re-encoded bridge is allowed
            // to differ from the copied source by (measured: 0.060 s across the
            // copy parts of the reference file, 0.040 s across its bridges).
            // Anything larger would shift the picture against the sound at a part
            // boundary.
            const delays = probed.map((s) => s.firstPts - s.firstDts);
            expect(
                Math.max(...delays) - Math.min(...delays)
            ).toBeLessThanOrEqual(2 * tolerance + 1e-6);
        }
    );

    it('joins its parts without a hole in the timeline', async () => {
        for (const [index, streamPlan] of plan.streams.entries()) {
            const dir = join(outputDir, streamPlan.streamDir);
            const kind = index === 0 ? 'video' : 'audio';
            const tolerance = kind === 'video' ? 1 / FRAME_RATE : 1024 / 48000;
            const segments = playlistSegments(dir);

            // Each part probed whole, against its own init — parts do not
            // share a timescale (a copied part keeps the source's, a bridge
            // gets whatever its encoder chose), so one init cannot read them
            // all. Measured on the decode clock, which is the one `tfdt`
            // carries and the one this retiming sets.
            const spans: {
                partIndex: number;
                start: number;
                end: number;
                pts: number;
            }[] = [];
            for (const partIndex of new Set(segments.map((s) => s.partIndex))) {
                const own = segments.filter((s) => s.partIndex === partIndex);
                const times = await probeTimes(
                    dir,
                    partIndex,
                    own.map((s) => s.uri),
                    kind
                );
                spans.push({
                    partIndex,
                    start: Math.min(...times.dts),
                    end: Math.max(...times.dts),
                    pts: Math.min(...times.pts),
                });
            }
            spans.sort((a, b) => a.start - b.start);

            console.log(
                `\n${streamPlan.streamDir} parts (dts): ` +
                    spans
                        .map(
                            (s) =>
                                `${s.partIndex}:[${s.start.toFixed(3)},` +
                                `${s.end.toFixed(3)}]`
                        )
                        .join(' ')
            );

            // The output's own zero, not the source's.
            expect(spans[0].start).toBeLessThanOrEqual(tolerance);
            for (let i = 1; i < spans.length; i++) {
                // A part's `end` is its last frame's decode time, and that
                // frame occupies one frame duration — so a join one frame
                // along is contiguous, not a hole. Anything past that is one:
                // nothing would fill it. (An *overlap* is expected wherever a
                // copy job spilled past its planned end on a DTS stop; the
                // authored EXTINF clamps it and the player overwrites by
                // timeline.)
                const gap = spans[i].start - spans[i - 1].end;
                expect(
                    gap,
                    `${streamPlan.streamDir} has a ${gap.toFixed(3)}s hole ` +
                        `before part ${spans[i].partIndex}`
                ).toBeLessThanOrEqual(1.5 * tolerance);
            }
        }
    });

    it('authors one map per own-init part and a discontinuity between all', () => {
        for (const streamPlan of plan.streams) {
            const text = readFileSync(
                join(outputDir, streamPlan.streamDir, 'playlist.m3u8'),
                'utf8'
            );
            const playlist = parseMediaPlaylist(text);
            expect(playlist.maps).toHaveLength(
                streamPlan.parts.filter((p) => p.ownInit).length
            );
            expect(text.match(/#EXT-X-DISCONTINUITY/g) ?? []).toHaveLength(
                streamPlan.parts.length - 1
            );
            expect(playlist.endList).toBe(true);
        }
    });

    it('authors durations summing to the kept ranges', () => {
        const kept = RANGES.reduce((sum, r) => sum + (r.outSec - r.inSec), 0);
        for (const streamPlan of plan.streams) {
            const playlist = parseMediaPlaylist(
                readFileSync(
                    join(outputDir, streamPlan.streamDir, 'playlist.m3u8'),
                    'utf8'
                )
            );
            const total = playlist.segments.reduce(
                (sum, s) => sum + s.duration,
                0
            );
            expect(Math.abs(total - kept)).toBeLessThanOrEqual(0.05);
        }
    });

    it('leaves no intermediates behind and writes a parseable master', () => {
        for (const streamPlan of plan.streams) {
            const files = readdirSync(join(outputDir, streamPlan.streamDir));
            expect(files.filter((f) => f.startsWith('part_'))).toEqual([]);
            expect(files.filter((f) => f.startsWith('measure_'))).toEqual([]);
            expect(files.filter((f) => f.startsWith('init_'))).toHaveLength(
                streamPlan.parts.filter((p) => p.ownInit).length
            );
        }

        const master = parseMasterPlaylist(
            readFileSync(join(outputDir, 'master.m3u8'), 'utf8')
        );
        expect(master.variants).toHaveLength(1);
        expect(master.variants[0].uri).toBe(`${VIDEO_DIR}/playlist.m3u8`);
        expect(master.media.map((m) => m.uri)).toEqual([
            `${AUDIO_DIR}/playlist.m3u8`,
        ]);

        expect(readFileSync(join(outputDir, 'concat.txt'), 'utf8')).toContain(
            'inpoint 20'
        );
        expect(progress[progress.length - 1]).toBe(100);
    });
});
