import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    ResumeStore,
    restorePlaylist,
    resumePlan,
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

describe('resumePlan', () => {
    const waves = [
        {
            videoStreams: ['stream_1080p', 'stream_720p', 'stream_480p'],
            audioStreams: ['stream_a'],
        },
        { videoStreams: ['stream_360p', 'stream_240p'], audioStreams: [] },
    ];
    const waveDone = (
        wave: number,
        count: number,
        streams: string[]
    ): ResumeRecord => ({
        kind: 'waveDone',
        wave,
        counts: Object.fromEntries(streams.map((s) => [s, count])),
    });
    const firstWave = [...waves[0].videoStreams, ...waves[0].audioStreams];

    it('skips a finished wave that is wholly in storage and continues the next one', () => {
        const records = [
            ...firstWave.flatMap((s) => both(s, 10, 10)),
            waveDone(0, 10, firstWave),
            ...both('stream_360p', 6, 4),
            ...both('stream_240p', 6, 5),
        ];

        const plan = resumePlan(waves, records);

        expect(plan?.skip).toBe(1);
        expect(plan?.point?.startIndex).toBe(4);
    });

    it('does not skip a finished wave whose last chunk never reached storage', () => {
        // Chunks are shared across waves, so the first wave's tail can still be
        // waiting in a chunk the second wave was filling.
        const records = [
            ...firstWave.flatMap((s) => both(s, 10, 8)),
            waveDone(0, 10, firstWave),
            ...both('stream_360p', 6, 4),
            ...both('stream_240p', 6, 4),
        ];

        const plan = resumePlan(waves, records);

        expect(plan?.skip).toBe(0);
        expect(plan?.point?.startIndex).toBe(8);
    });

    it('runs the next wave from its start when nothing of it is stored', () => {
        const records = [
            ...firstWave.flatMap((s) => both(s, 10, 10)),
            waveDone(0, 10, firstWave),
        ];
        expect(resumePlan(waves, records)).toEqual({ skip: 1, point: null });
    });

    it('runs nothing again when every wave finished and is stored', () => {
        const secondWave = waves[1].videoStreams;
        const records = [
            ...firstWave.flatMap((s) => both(s, 10, 10)),
            waveDone(0, 10, firstWave),
            ...secondWave.flatMap((s) => both(s, 10, 10)),
            waveDone(1, 10, secondWave),
        ];
        expect(resumePlan(waves, records)).toEqual({ skip: 2, point: null });
    });

    it('has nothing to continue when the first wave stored nothing', () => {
        expect(
            resumePlan(
                waves,
                firstWave.flatMap((s) => both(s, 3, 0))
            )
        ).toBeNull();
    });

    it('restarts an audio-only encode from its audio streams', () => {
        const plan = resumePlan(
            [{ videoStreams: [], audioStreams: ['stream_a'] }],
            [...both('stream_a', 6, 4)]
        );
        expect(plan?.point?.startIndex).toBe(4);
    });

    it('treats a single run as a ladder of one wave', () => {
        const plan = resumePlan(
            [waves[1]],
            [...both('stream_360p', 6, 3), ...both('stream_240p', 6, 4)]
        );
        expect(plan).toEqual(
            expect.objectContaining({
                skip: 0,
                point: expect.objectContaining({ startIndex: 3 }),
            })
        );
    });
});

describe('restorePlaylist', () => {
    const ffmpegPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MAP:URI="init_3.mp4"',
        '#EXTINF:6.000000,',
        'segment_00000.m4s',
        '#EXTINF:4.200000,',
        'segment_00001.m4s',
        '#EXT-X-ENDLIST',
        '',
    ].join('\n');

    it('points each segment at where it is in storage, keeping its duration', () => {
        const text = restorePlaylist(
            ffmpegPlaylist,
            'stream_720p',
            both('stream_720p', 2, 2),
            true
        );

        expect(text).toContain('#EXTINF:4.200000,');
        expect(text).toContain('#EXT-X-BYTERANGE:100@100');
        expect(
            text.split('\n').filter((l) => l.startsWith('../media/'))
        ).toHaveLength(2);
        expect(text).toContain('#EXT-X-MAP:URI="init_3.mp4"');
    });

    it('refuses a segment that is not in storage', () => {
        expect(() =>
            restorePlaylist(
                ffmpegPlaylist,
                'stream_720p',
                both('stream_720p', 2, 1),
                true
            )
        ).toThrow(/segment_00001.m4s is not in storage/);
    });

    it('leaves a playlist without byte ranges pointing at the segments by name', () => {
        const text = restorePlaylist(ffmpegPlaylist, 'stream_720p', [], false);
        expect(text).toContain('segment_00001.m4s');
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

    it('lists only the kept files still there at the size their record says', async () => {
        const store = new ResumeStore(dir);
        await store.reset(state(0));
        mkdirSync(store.pendingDir, { recursive: true });
        writeFileSync(join(store.pendingDir, 'v0_1.m4s'), Buffer.alloc(200));
        writeFileSync(join(store.pendingDir, 'v0_2.m4s'), Buffer.alloc(50));
        const pending = (name: string, size: number): ResumeRecord => ({
            kind: 'pending',
            name,
            objectKey: `p/media/${name}`,
            size,
            segments: [],
        });
        store.append([
            pending('v0_1.m4s', 200),
            pending('v0_2.m4s', 99),
            pending('v0_3.m4s', 10),
        ]);

        expect(store.pending(store.readRecords()).map((p) => p.name)).toEqual([
            'v0_1.m4s',
        ]);
    });

    it('skips the half-written line a crash leaves', async () => {
        const store = new ResumeStore(dir);
        await store.reset(state(0));
        store.append([seen('stream_720p', 0)]);
        appendFileSync(join(store.dir, 'segments.jsonl'), '{"kind":"dur');

        expect(store.readRecords()).toEqual([seen('stream_720p', 0)]);
    });
});
