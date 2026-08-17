import { describe, it, expect } from 'vitest';
import {
    planQuickTrim,
    isQuickTrimRejection,
    estimateSegmentsForPart,
    MAX_PARTS_PER_STREAM,
    PART_NUMBER_STRIDE,
    type QuickTrimPlan,
    type QuickTrimRejection,
    type StreamGrid,
} from './quick-trim-plan.js';

/**
 * Grids modelled on the reference multi-stream file: a 1-second GOP on every
 * video stream, but each stream's keyframes offset from the others' — 0.06,
 * 0.62 and 1.06 seconds in. That mutual offset is the whole reason a stream is
 * planned against its own grid.
 */
function grid(offset: number, count = 20): number[] {
    return Array.from(
        { length: count },
        (_, i) => Math.round((offset + i) * 1e6) / 1e6
    );
}

function videoStream(
    streamDir: string,
    offset: number,
    count = 20
): StreamGrid {
    return { streamDir, kind: 'video', keyframes: grid(offset, count) };
}

const audioStream: StreamGrid = {
    streamDir: 'stream_a0',
    kind: 'audio',
    keyframes: null,
};

function referenceStreams(): StreamGrid[] {
    return [
        videoStream('stream_v0', 0.06),
        videoStream('stream_v1', 0.62),
        videoStream('stream_v2', 1.06),
        audioStream,
    ];
}

function plan(
    streams: StreamGrid[],
    trimSegments: { inSec: number; outSec: number }[],
    segmentDuration = 6
): QuickTrimPlan {
    const result = planQuickTrim({ streams, trimSegments, segmentDuration });
    if (isQuickTrimRejection(result))
        throw new Error(`unexpected rejection: ${result.reason}`);
    return result;
}

function rejection(
    streams: StreamGrid[],
    trimSegments: { inSec: number; outSec: number }[],
    segmentDuration = 6
): QuickTrimRejection {
    const result = planQuickTrim({ streams, trimSegments, segmentDuration });
    if (!isQuickTrimRejection(result))
        throw new Error('expected a rejection, got a plan');
    return result;
}

describe('planQuickTrim', () => {
    describe('mid-GOP cuts', () => {
        it('emits head bridge, middle copy and tail bridge', () => {
            const result = plan(
                [videoStream('stream_v0', 0.06)],
                [{ inSec: 2.5, outSec: 7.5 }]
            );

            expect(result.streams[0].parts).toEqual([
                {
                    kind: 'bridge',
                    partIndex: 0,
                    rangeIndex: 0,
                    startNumber: 0,
                    start: 2.5,
                    end: 3.06,
                    ownInit: true,
                },
                {
                    kind: 'copy',
                    partIndex: 1,
                    rangeIndex: 0,
                    startNumber: 100000,
                    start: 3.06,
                    end: 7.06,
                    ownInit: true,
                },
                {
                    kind: 'bridge',
                    partIndex: 2,
                    rangeIndex: 0,
                    startNumber: 200000,
                    start: 7.06,
                    end: 7.5,
                    ownInit: true,
                },
            ]);
        });

        it('plans each stream against its own keyframe grid', () => {
            const result = plan(referenceStreams(), [
                { inSec: 2.5, outSec: 7.5 },
            ]);

            const bounds = result.streams.map((s) => [
                s.parts[1].start,
                s.parts[1].end,
            ]);
            expect(bounds).toEqual([
                [3.06, 7.06],
                [2.62, 6.62],
                [3.06, 7.06],
                [3.06, 7.06],
            ]);
        });
    });

    describe('uniform part structure', () => {
        it('degenerates to a copy split on the stream whose keyframe the cut lands on', () => {
            const result = plan(referenceStreams(), [
                { inSec: 3.06, outSec: 8.5 },
            ]);

            const [v0, v1] = result.streams;
            // The cut is v0's keyframe: no fragment to re-encode, so the head
            // copies the GOP the cut opens instead, and continues the init the
            // middle uses.
            expect(v0.parts[0]).toMatchObject({
                kind: 'copy',
                start: 3.06,
                end: 4.06,
                ownInit: true,
            });
            expect(v0.parts[1]).toMatchObject({
                kind: 'copy',
                start: 4.06,
                end: 8.06,
                ownInit: false,
            });
            // The same cut is mid-GOP on v1, which does bridge.
            expect(v1.parts[0]).toMatchObject({
                kind: 'bridge',
                start: 3.06,
                end: 3.62,
                ownInit: true,
            });
        });

        it('emits the same number of parts on every stream regardless', () => {
            const result = plan(referenceStreams(), [
                { inSec: 3.06, outSec: 8.5 },
            ]);

            const counts = result.streams.map((s) => s.parts.length);
            expect(counts).toEqual([3, 3, 3, 3]);
        });

        it('keeps discontinuity counts equal across streams over multiple ranges', () => {
            const result = plan(referenceStreams(), [
                { inSec: 0.5, outSec: 4.5 },
                { inSec: 6.62, outSec: 11.2 },
                { inSec: 13, outSec: 18 },
            ]);

            const counts = result.streams.map((s) => s.parts.length);
            expect(counts).toEqual([9, 9, 9, 9]);
        });
    });

    describe('range placement', () => {
        it('bridges the head of a range at t=0 when the grid does not start there', () => {
            const result = plan(
                [videoStream('stream_v0', 0.06)],
                [{ inSec: 0, outSec: 5 }]
            );

            expect(result.streams[0].parts[0]).toMatchObject({
                kind: 'bridge',
                start: 0,
                end: 0.06,
            });
        });

        it('copies the head of a range at t=0 when the grid starts there', () => {
            const result = plan(
                [videoStream('stream_v0', 0)],
                [{ inSec: 0, outSec: 5 }]
            );

            expect(result.streams[0].parts[0]).toMatchObject({
                kind: 'copy',
                start: 0,
                end: 1,
            });
        });

        it('bridges the tail of a range running to the end of the file', () => {
            // Grid ends at 9.06; the source runs to 10.
            const result = plan(
                [videoStream('stream_v0', 0.06, 10)],
                [{ inSec: 2, outSec: 10 }]
            );

            const parts = result.streams[0].parts;
            expect(parts[2]).toMatchObject({
                kind: 'bridge',
                start: 9.06,
                end: 10,
            });
        });
    });

    describe('init ownership', () => {
        it('gives each range its first init and lets its copy split share it', () => {
            const result = plan(
                [audioStream],
                [
                    { inSec: 2, outSec: 8 },
                    { inSec: 12, outSec: 18 },
                ]
            );

            // One ffmpeg run per range, so one init per range: the parts split
            // off inside a range come out of that same run.
            expect(result.streams[0].parts.map((p) => p.ownInit)).toEqual([
                true,
                false,
                false,
                true,
                false,
                false,
            ]);
        });

        it('re-maps the copy part that follows a bridge', () => {
            const result = plan(
                [videoStream('stream_v0', 0.06)],
                [
                    { inSec: 2.5, outSec: 7.5 },
                    { inSec: 9.5, outSec: 14.5 },
                ]
            );

            expect(result.streams[0].parts.map((p) => p.ownInit)).toEqual([
                true,
                true,
                true,
                true,
                true,
                true,
            ]);
        });
    });

    describe('audio streams', () => {
        it('splits into three copy parts at the reference stream junctions', () => {
            const result = plan(
                [videoStream('stream_v0', 0.06), audioStream],
                [{ inSec: 2.5, outSec: 7.5 }]
            );

            expect(result.streams[1].parts).toEqual([
                {
                    kind: 'copy',
                    partIndex: 0,
                    rangeIndex: 0,
                    startNumber: 0,
                    start: 2.5,
                    end: 3.06,
                    ownInit: true,
                },
                {
                    kind: 'copy',
                    partIndex: 1,
                    rangeIndex: 0,
                    startNumber: 100000,
                    start: 3.06,
                    end: 7.06,
                    ownInit: false,
                },
                {
                    kind: 'copy',
                    partIndex: 2,
                    rangeIndex: 0,
                    startNumber: 200000,
                    start: 7.06,
                    end: 7.5,
                    ownInit: false,
                },
            ]);
        });

        it('splits the range evenly when there is no video stream', () => {
            const result = plan([audioStream], [{ inSec: 0, outSec: 9 }]);

            expect(
                result.streams[0].parts.map((p) => [p.start, p.end])
            ).toEqual([
                [0, 3],
                [3, 6],
                [6, 9],
            ]);
        });
    });

    describe('range membership', () => {
        it('tags every part with the kept range it came from', () => {
            const result = plan(referenceStreams(), [
                { inSec: 2.5, outSec: 7.5 },
                { inSec: 9.5, outSec: 14.5 },
            ]);

            for (const stream of result.streams) {
                expect(stream.parts.map((p) => p.rangeIndex)).toEqual([
                    0, 0, 0, 1, 1, 1,
                ]);
            }
        });

        it('separates a range tail from the next range head that follows it', () => {
            // Two ranges meeting exactly, so the parts either side of the join
            // are contiguous in time: only rangeIndex says they are two
            // different seeks into the source.
            const result = plan(
                [audioStream],
                [
                    { inSec: 2, outSec: 8 },
                    { inSec: 8, outSec: 14 },
                ]
            );

            const parts = result.streams[0].parts;
            expect(parts[2].end).toBe(parts[3].start);
            expect(parts[2].rangeIndex).toBe(0);
            expect(parts[3].rangeIndex).toBe(1);
            expect(parts[3].ownInit).toBe(true);
        });
    });

    describe('numbering', () => {
        it('numbers parts in order with a stride per part', () => {
            const result = plan(referenceStreams(), [
                { inSec: 2.5, outSec: 7.5 },
                { inSec: 9.5, outSec: 14.5 },
            ]);

            for (const stream of result.streams) {
                expect(stream.parts.map((p) => p.partIndex)).toEqual([
                    0, 1, 2, 3, 4, 5,
                ]);
                expect(stream.parts.map((p) => p.startNumber)).toEqual(
                    stream.parts.map((p) => p.partIndex * PART_NUMBER_STRIDE)
                );
            }
            expect(PART_NUMBER_STRIDE).toBe(100000);
        });
    });

    describe('plannedTotalSegments', () => {
        it('counts one segment per bridge and a target-duration split per copy', () => {
            const result = plan(
                [videoStream('stream_v0', 0.06)],
                [{ inSec: 2.5, outSec: 7.5 }],
                2
            );

            // bridge (1) + copy 3.06→7.06 at 2s targets (2) + bridge (1)
            expect(result.plannedTotalSegments).toBe(4);
        });

        it('sums across every stream in the plan', () => {
            const streams = [
                videoStream('stream_v0', 0.06),
                videoStream('stream_v1', 0.62),
            ];
            const result = plan(streams, [{ inSec: 2.5, outSec: 7.5 }], 2);

            expect(result.plannedTotalSegments).toBe(8);
        });

        it('agrees with estimateSegmentsForPart on every part', () => {
            const result = plan(referenceStreams(), [
                { inSec: 2.5, outSec: 7.5 },
                { inSec: 9.5, outSec: 14.5 },
            ]);

            const summed = result.streams
                .flatMap((s) => s.parts)
                .reduce((total, p) => total + estimateSegmentsForPart(p, 6), 0);
            expect(result.plannedTotalSegments).toBe(summed);
        });

        it('prices a copy part shorter than one segment as one segment', () => {
            expect(
                estimateSegmentsForPart(
                    {
                        kind: 'copy',
                        partIndex: 0,
                        startNumber: 0,
                        start: 1,
                        end: 1.2,
                        ownInit: true,
                    },
                    6
                )
            ).toBe(1);
        });
    });

    describe('rejections', () => {
        it('rejects a kept range shorter than a GOP, naming the stream', () => {
            const result = rejection(referenceStreams(), [
                { inSec: 2.5, outSec: 3.4 },
            ]);

            expect(result.reason).toContain('stream_v0');
            expect(result.reason).toContain('2.500');
            expect(result.reason).toContain('3.400');
        });

        it('rejects a range that clears one grid but not another', () => {
            const result = rejection(
                [
                    videoStream('stream_v0', 0.06),
                    videoStream('stream_v1', 0.62),
                ],
                // 0.06-grid keeps 3.06→4.06; the 0.62 grid has only 3.62 inside.
                [{ inSec: 2.7, outSec: 4.4 }]
            );

            expect(result.reason).toContain('stream_v1');
        });

        it('rejects more parts than the segment numbering allows', () => {
            const ranges = Array.from({ length: 34 }, (_, i) => ({
                inSec: i * 10 + 0.5,
                outSec: i * 10 + 8.5,
            }));
            const result = rejection(
                [videoStream('stream_v0', 0.06, 400)],
                ranges
            );

            expect(result.reason).toContain('102');
            expect(result.reason).toContain(String(MAX_PARTS_PER_STREAM));
        });

        it('accepts exactly the part cap', () => {
            const ranges = Array.from({ length: 33 }, (_, i) => ({
                inSec: i * 10 + 0.5,
                outSec: i * 10 + 8.5,
            }));
            const result = plan([videoStream('stream_v0', 0.06, 400)], ranges);

            expect(result.streams[0].parts).toHaveLength(99);
        });

        it('rejects overlapping kept ranges', () => {
            const result = rejection(referenceStreams(), [
                { inSec: 2, outSec: 8 },
                { inSec: 7, outSec: 12 },
            ]);

            expect(result.reason).toContain('overlap');
        });

        it('rejects unsorted kept ranges', () => {
            const result = rejection(referenceStreams(), [
                { inSec: 10, outSec: 14 },
                { inSec: 2, outSec: 6 },
            ]);

            expect(result.reason).toContain('out of order');
        });

        it('rejects an empty range', () => {
            const result = rejection(referenceStreams(), [
                { inSec: 4, outSec: 4 },
            ]);

            expect(result.reason).toContain('empty');
        });

        it('rejects when there are no kept ranges', () => {
            expect(rejection(referenceStreams(), []).reason).toContain(
                'No kept ranges'
            );
        });

        it('rejects a video stream with fewer than two keyframes', () => {
            const result = rejection(
                [{ streamDir: 'stream_v0', kind: 'video', keyframes: [0.06] }],
                [{ inSec: 1, outSec: 5 }]
            );

            expect(result.reason).toContain('stream_v0');
            expect(result.reason).toContain('two');
        });

        it('rejects a plan with no streams', () => {
            expect(rejection([], [{ inSec: 1, outSec: 5 }]).reason).toContain(
                'No streams'
            );
        });
    });
});

describe('planQuickTrim — streams that reorder at start', () => {
    function plan(streams: StreamGrid[], ranges: { inSec: number; outSec: number }[]) {
        const result = planQuickTrim({
            streams,
            trimSegments: ranges,
            segmentDuration: 6,
        });
        if (isQuickTrimRejection(result)) throw new Error(result.reason);
        return result;
    }

    it('bridges through the first GOP when the trim starts at the first keyframe', () => {
        // Keyframes at 0,1,2,… and a cut at 0: without the flag the head is a
        // copy of [0,1) starting at the file head, whose decode time is
        // negative on a B-frame stream — the muxer would shift it and the
        // runner refuse it. With the flag the head is a bridge instead.
        const stream: StreamGrid = {
            streamDir: 'stream_v0',
            kind: 'video',
            keyframes: grid(0),
            reordersAtStart: true,
        };
        const parts = plan([stream], [{ inSec: 0, outSec: 12 }]).streams[0]
            .parts;
        expect(parts.map((p) => p.kind)).toEqual(['bridge', 'copy', 'copy']);
        expect(parts[0].start).toBe(0);
        expect(parts[0].end).toBe(1);
        expect(parts[1].start).toBe(1);
    });

    it('skips the first keyframe as an in-point when the cut precedes it', () => {
        const stream: StreamGrid = {
            streamDir: 'stream_v0',
            kind: 'video',
            keyframes: grid(0.62),
            reordersAtStart: true,
        };
        const parts = plan([stream], [{ inSec: 0, outSec: 12 }]).streams[0]
            .parts;
        expect(parts[0].kind).toBe('bridge');
        // The bridge runs through the whole first GOP: the copy span may not
        // begin at 0.62, the file's first keyframe.
        expect(parts[1].start).toBeCloseTo(1.62, 6);
    });

    it('changes nothing for a mid-file trim', () => {
        const flagged: StreamGrid = {
            streamDir: 'stream_v0',
            kind: 'video',
            keyframes: grid(0, 60),
            reordersAtStart: true,
        };
        const plain: StreamGrid = { ...flagged, reordersAtStart: false };
        const a = plan([flagged], [{ inSec: 20.4, outSec: 40 }]).streams[0];
        const b = plan([plain], [{ inSec: 20.4, outSec: 40 }]).streams[0];
        expect(a.parts).toEqual(b.parts);
    });
});
