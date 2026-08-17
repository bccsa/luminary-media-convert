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

/** First packet time of a part, measured from its init plus its first segment. */
async function firstPts(
    streamDirPath: string,
    partIndex: number,
    kind: 'video' | 'audio'
): Promise<number> {
    const first = partIndex * PART_NUMBER_STRIDE;
    const segment = readdirSync(streamDirPath)
        .filter((name) => /^segment_\d+\.m4s$/.test(name))
        .filter((name) => {
            const number = parseInt(name.slice('segment_'.length), 10);
            return number >= first && number < first + PART_NUMBER_STRIDE;
        })
        .sort()[0];
    expect(segment, `no segment for part ${partIndex}`).toBeDefined();

    const probePath = join(streamDirPath, `probe_${partIndex}.mp4`);
    await writeFile(
        probePath,
        Buffer.concat([
            await readFile(join(streamDirPath, `init_${partIndex}.mp4`)),
            await readFile(join(streamDirPath, segment)),
        ])
    );
    const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        kind === 'video' ? 'v:0' : 'a:0',
        '-show_entries',
        'packet=pts_time',
        '-of',
        'csv=p=0',
        '-read_intervals',
        '%+#1',
        probePath,
    ]);
    await unlink(probePath);
    return parseFloat(String(stdout).trim().split('\n')[0]);
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

    it('starts every video part where the plan says', async () => {
        const dir = join(outputDir, VIDEO_DIR);
        const tolerance = 0.5 / FRAME_RATE;
        for (const part of plan.streams[0].parts) {
            if (!part.ownInit) continue;
            const landed = await firstPts(dir, part.partIndex, 'video');
            console.log(
                `video part ${part.partIndex} (${part.kind}): planned ` +
                    `${part.start.toFixed(3)}s, landed ${landed.toFixed(3)}s`
            );
            expect(Math.abs(landed - part.start)).toBeLessThanOrEqual(
                tolerance
            );
        }
    });

    it('starts the audio stream where the plan says', async () => {
        const landed = await firstPts(join(outputDir, AUDIO_DIR), 0, 'audio');
        console.log(
            `audio part 0: planned ${plan.streams[1].parts[0].start.toFixed(3)}s, ` +
                `landed ${landed.toFixed(3)}s`
        );
        // One AAC frame at 48 kHz.
        expect(
            Math.abs(landed - plan.streams[1].parts[0].start)
        ).toBeLessThanOrEqual(1024 / 48000);
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
