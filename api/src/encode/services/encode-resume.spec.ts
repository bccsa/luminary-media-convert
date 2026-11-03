import { appendFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    ResumeStore,
    resumePoint,
    resumeRefusal,
    stableHash,
    type ResumeRecord,
    type ResumeState,
} from './encode-resume.js';

const TICKS = 540000; // one 6 s segment at 90 kHz

const seen = (stream: string, index: number): ResumeRecord => ({
    kind: 'seen',
    stream,
    index,
    tfdt: index * TICKS,
});
const durable = (stream: string, index: number): ResumeRecord => ({
    kind: 'durable',
    stream,
    file: `segment_${String(index).padStart(5, '0')}.m4s`,
    index,
    tfdt: index * TICKS,
    mediaFile: 'media/v0_0.m4s',
    offset: index * 100,
    length: 100,
});

const both = (stream: string, upTo: number, stored: number): ResumeRecord[] => [
    ...Array.from({ length: upTo }, (_, i) => seen(stream, i)),
    ...Array.from({ length: stored }, (_, i) => durable(stream, i)),
];

describe('resumePoint', () => {
    it('restarts after the segments every video stream has in storage', () => {
        const point = resumePoint(
            ['stream_720p', 'stream_360p'],
            [...both('stream_720p', 6, 5), ...both('stream_360p', 6, 3)]
        );

        expect(point?.startIndex).toBe(3);
        expect(point?.startTfdt).toEqual({
            stream_720p: 3 * TICKS,
            stream_360p: 3 * TICKS,
        });
        expect(
            point?.reused.stream_360p.map((s) => [s.index, s.tfdt, s.nextTfdt])
        ).toEqual([
            [0, 0, TICKS],
            [1, TICKS, 2 * TICKS],
            [2, 2 * TICKS, 3 * TICKS],
        ]);
    });

    it('stops at the first segment missing from storage', () => {
        const records = [
            ...both('stream_720p', 6, 0),
            durable('stream_720p', 0),
            durable('stream_720p', 1),
            durable('stream_720p', 3),
        ];
        expect(resumePoint(['stream_720p'], records)?.startIndex).toBe(2);
    });

    it("backs off until the restart segment's start is known", () => {
        // Segments 0-3 stored, but ffmpeg was stopped before segment 4 was seen.
        const records = both('stream_720p', 4, 4);
        expect(resumePoint(['stream_720p'], records)?.startIndex).toBe(3);
    });

    it('has nothing to continue from before a segment is stored', () => {
        expect(
            resumePoint(['stream_720p'], both('stream_720p', 3, 0))
        ).toBeNull();
        expect(resumePoint(['stream_720p'], [])).toBeNull();
        expect(resumePoint([], both('stream_720p', 3, 2))).toBeNull();
    });

    it('treats a stream with no records as having nothing stored', () => {
        expect(
            resumePoint(
                ['stream_720p', 'stream_360p'],
                both('stream_720p', 6, 5)
            )
        ).toBeNull();
    });
});

describe('resumeRefusal', () => {
    const state: ResumeState = {
        attempt: 0,
        configHash: 'c',
        ivHex: '00',
        keyFingerprint: 'k',
        source: { size: 10, mtimeMs: 1 },
        alignmentOffset: 0,
        videoStreams: ['stream_720p'],
        segmentDuration: 6,
    };
    const { attempt: _a, ivHex: _i, ...next } = state;

    it('lets the same encode continue', () => {
        expect(resumeRefusal(state, next)).toBeNull();
    });

    it.each([
        [{ configHash: 'other' }, 'the settings changed'],
        [{ keyFingerprint: 'other' }, 'the encryption key changed'],
        [{ source: { size: 11, mtimeMs: 1 } }, 'the source file changed'],
        [{ source: { size: 10, mtimeMs: 2 } }, 'the source file changed'],
        [{ alignmentOffset: 0.5 }, 'the source alignment changed'],
        [{ segmentDuration: 4 }, 'the segment length changed'],
        [{ videoStreams: ['stream_1080p'] }, 'the video renditions changed'],
    ])('starts over when %o', (change, reason) => {
        expect(resumeRefusal(state, { ...next, ...change })).toBe(reason);
    });

    it('starts over with no earlier run', () => {
        expect(resumeRefusal(null, next)).toBe('no earlier run to continue');
    });
});

describe('stableHash', () => {
    it('ignores property order', () => {
        expect(stableHash({ a: 1, b: { c: 2, d: [3] } })).toBe(
            stableHash({ b: { d: [3], c: 2 }, a: 1 })
        );
        expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    });
});

describe('ResumeStore', () => {
    let dir: string;
    beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'resume-'))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const state = (attempt: number): ResumeState => ({
        attempt,
        configHash: 'c',
        source: { size: 1, mtimeMs: 1 },
        alignmentOffset: 0,
        videoStreams: ['stream_720p'],
        segmentDuration: 6,
    });

    it('keeps records across a continue, and drops them on a reset', async () => {
        const store = new ResumeStore(dir);
        await store.reset(state(0));
        store.append([seen('stream_720p', 0), durable('stream_720p', 0)]);

        await store.continueWith(state(1));
        expect((await store.readState())?.attempt).toBe(1);
        expect(store.readRecords()).toHaveLength(2);

        await store.reset(state(2));
        expect(store.readRecords()).toEqual([]);
    });

    it('skips the half-written line a crash leaves', async () => {
        const store = new ResumeStore(dir);
        await store.reset(state(0));
        store.append([seen('stream_720p', 0)]);
        appendFileSync(join(store.dir, 'segments.jsonl'), '{"kind":"dur');

        expect(store.readRecords()).toEqual([seen('stream_720p', 0)]);
    });
});
