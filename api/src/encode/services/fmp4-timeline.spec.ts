/**
 * Box surgery is byte work, so it is tested as byte work: synthetic buffers for
 * the edge cases a real muxer will not produce on demand (multiple moofs, a
 * version 0 tfdt on the edge of overflow, malformed headers), and — wherever
 * ffmpeg is installed — a real fMP4 pair built at test time, patched, and read
 * back with ffprobe so the claims about `tfdt` and `elst` are checked against
 * the thing that writes them rather than against this file's idea of it.
 */

import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import {
    Fmp4BoxError,
    neutralizeEditList,
    readTrackTimescale,
    shiftBaseMediaDecodeTime,
} from './fmp4-timeline.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Synthetic boxes
// ---------------------------------------------------------------------------

function box(type: string, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8, 0);
    header.write(type, 4, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function fullBox(type: string, version: number, ...content: Buffer[]): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt8(version, 0);
    return box(type, head, ...content);
}

function u32(...values: number[]): Buffer {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
    return buffer;
}

function u64(value: bigint): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(value);
    return buffer;
}

function mdhd(timescale: number, version = 0): Buffer {
    return version === 1
        ? fullBox('mdhd', 1, u64(0n), u64(0n), u32(timescale), u64(0n), u32(0))
        : fullBox('mdhd', 0, u32(0, 0, timescale, 0), u32(0));
}

function elst(): Buffer {
    // Two entries, the shape ffmpeg writes for a mid-file fragmented run: an
    // empty edit carrying the run's absolute start, then the composition-delay
    // edit.
    return fullBox('elst', 0, u32(2), u32(19620, 0xffffffff), u32(0, 5400));
}

function syntheticInit(
    options: {
        timescale?: number;
        mdhdVersion?: number;
        withEdts?: boolean;
        traks?: number;
    } = {}
): Buffer {
    const {
        timescale = 90000,
        mdhdVersion = 0,
        withEdts = true,
        traks = 1,
    } = options;
    const trak = (): Buffer =>
        box(
            'trak',
            box('tkhd', u32(0, 0, 1)),
            ...(withEdts ? [box('edts', elst())] : []),
            box('mdia', mdhd(timescale, mdhdVersion), box('hdlr', u32(0)))
        );
    return Buffer.concat([
        box('ftyp', Buffer.from('iso6', 'latin1')),
        box(
            'moov',
            box('mvhd', u32(0, 0, 1000, 0)),
            ...Array.from({ length: traks }, () => trak())
        ),
    ]);
}

function tfdt(value: bigint | number, version: 0 | 1): Buffer {
    return version === 1
        ? fullBox('tfdt', 1, u64(BigInt(value)))
        : fullBox('tfdt', 0, u32(Number(value)));
}

function fragment(values: (bigint | number)[], version: 0 | 1): Buffer {
    return box(
        'moof',
        box('mfhd', u32(0, 1)),
        ...values.map((value) =>
            box(
                'traf',
                box('tfhd', u32(0, 1)),
                tfdt(value, version),
                box('trun', u32(0, 1))
            )
        )
    );
}

function syntheticSegment(
    fragments: (bigint | number)[][],
    version: 0 | 1 = 1
): Buffer {
    return Buffer.concat([
        box('styp', Buffer.from('msdh', 'latin1')),
        ...fragments.flatMap((values) => [
            fragment(values, version),
            box('mdat', Buffer.from('payload-bytes')),
        ]),
    ]);
}

/** Every `tfdt` value in a segment, in file order. */
function readAllTfdt(segment: Buffer): number[] {
    const values: number[] = [];
    for (let i = 0; i + 8 <= segment.length; i++) {
        if (segment.toString('latin1', i + 4, i + 8) !== 'tfdt') continue;
        const version = segment.readUInt8(i + 8);
        values.push(
            version === 1
                ? Number(segment.readBigUInt64BE(i + 12))
                : segment.readUInt32BE(i + 12)
        );
    }
    return values;
}

/** Indexes at which two equal-length buffers differ. */
function differingBytes(a: Buffer, b: Buffer): number[] {
    expect(a.length).toBe(b.length);
    const differences: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences.push(i);
    return differences;
}

// ---------------------------------------------------------------------------

describe('readTrackTimescale', () => {
    it('reads a version 0 mdhd', () => {
        expect(readTrackTimescale(syntheticInit({ timescale: 90000 }))).toBe(
            90000
        );
    });

    it('reads a version 1 mdhd, whose fields sit eight bytes later', () => {
        expect(
            readTrackTimescale(
                syntheticInit({ timescale: 48000, mdhdVersion: 1 })
            )
        ).toBe(48000);
    });

    it('refuses an init that is not one stream', () => {
        expect(() => readTrackTimescale(syntheticInit({ traks: 2 }))).toThrow(
            /2 moov > trak boxes/
        );
    });

    it('refuses a buffer with no moov at all', () => {
        expect(() => readTrackTimescale(box('ftyp', u32(0)))).toThrow(
            Fmp4BoxError
        );
    });
});

describe('neutralizeEditList', () => {
    it('renames edts to free and touches nothing else', () => {
        const init = syntheticInit();
        const before = Buffer.from(init);
        const at = before.indexOf(Buffer.from('edts', 'latin1'));
        expect(at).toBeGreaterThan(0);

        const after = neutralizeEditList(init);

        expect(after).toBe(init);
        expect(differingBytes(before, after)).toEqual([
            at,
            at + 1,
            at + 2,
            at + 3,
        ]);
        expect(after.toString('latin1', at, at + 4)).toBe('free');
        // The elst content survives inside the now-skipped box: nothing was
        // removed, so no enclosing size had to change.
        expect(after.indexOf(Buffer.from('elst', 'latin1'))).toBeGreaterThan(
            at
        );
    });

    it('is a no-op on an init with no edit list', () => {
        const init = syntheticInit({ withEdts: false });
        const before = Buffer.from(init);
        expect(differingBytes(before, neutralizeEditList(init))).toEqual([]);
    });
});

describe('shiftBaseMediaDecodeTime', () => {
    it('shifts every tfdt of every moof in the segment', () => {
        const segment = syntheticSegment([[0], [540000], [1080000]]);
        shiftBaseMediaDecodeTime(segment, 55800);
        expect(readAllTfdt(segment)).toEqual([55800, 595800, 1135800]);
    });

    it('shifts every traf of a multi-track fragment by the same amount', () => {
        const segment = syntheticSegment([[100, 200, 300]]);
        shiftBaseMediaDecodeTime(segment, 7);
        expect(readAllTfdt(segment)).toEqual([107, 207, 307]);
    });

    it('changes nothing outside the tfdt value fields', () => {
        const segment = syntheticSegment([[0], [540000]]);
        const before = Buffer.from(segment);
        shiftBaseMediaDecodeTime(segment, 90000);

        expect(segment.length).toBe(before.length);
        // Every version 1 tfdt is header(8) + version/flags(4) + value(8), so
        // its value occupies [start + 12, start + 20).
        const valueBytes = new Set<number>();
        for (let i = 0; i + 8 <= segment.length; i++) {
            if (segment.toString('latin1', i + 4, i + 8) !== 'tfdt') continue;
            for (let v = i + 12; v < i + 20; v++) valueBytes.add(v);
        }
        expect(valueBytes.size).toBe(16);
        for (const index of differingBytes(before, segment)) {
            expect(valueBytes.has(index)).toBe(true);
        }
    });

    it('leaves the segment untouched when the offset is zero', () => {
        const segment = syntheticSegment([[0], [540000]]);
        const before = Buffer.from(segment);
        expect(shiftBaseMediaDecodeTime(segment, 0)).toBe(segment);
        expect(differingBytes(before, segment)).toEqual([]);
    });

    it('patches a version 0 tfdt in place while the sum fits', () => {
        const segment = syntheticSegment([[0xfffffffe - 1]], 0);
        shiftBaseMediaDecodeTime(segment, 1);
        expect(readAllTfdt(segment)).toEqual([0xfffffffe]);
    });

    it('refuses to upgrade a version 0 tfdt that overflows 32 bits', () => {
        const segment = syntheticSegment([[0xfffffffe]], 0);
        const before = Buffer.from(segment);
        expect(() => shiftBaseMediaDecodeTime(segment, 2)).toThrow(
            /overflows 32 bits/
        );
        // Nothing half-written: an overflow is the end of the quick trim, not a
        // partly patched segment.
        expect(differingBytes(before, segment)).toEqual([]);
    });

    it('refuses an offset that would make a tfdt negative', () => {
        expect(() =>
            shiftBaseMediaDecodeTime(syntheticSegment([[100]]), -101)
        ).toThrow(/negative/);
        expect(() =>
            shiftBaseMediaDecodeTime(syntheticSegment([[100]], 0), -101)
        ).toThrow(/negative/);
    });

    it('refuses a fractional offset', () => {
        expect(() =>
            shiftBaseMediaDecodeTime(syntheticSegment([[0]]), 1.5)
        ).toThrow(/whole number of ticks/);
    });
});

describe('malformed input', () => {
    it('refuses a 64-bit largesize header', () => {
        const segment = syntheticSegment([[0]]);
        segment.writeUInt32BE(1, 0);
        expect(() => shiftBaseMediaDecodeTime(segment, 1)).toThrow(/largesize/);
    });

    it('refuses a box that runs past its container', () => {
        const segment = syntheticSegment([[0]]);
        const moofAt = segment.indexOf(Buffer.from('moof', 'latin1')) - 4;
        segment.writeUInt32BE(segment.length + 16, moofAt);
        expect(() => shiftBaseMediaDecodeTime(segment, 1)).toThrow(
            /past its container/
        );
    });

    it('refuses a segment with no moof', () => {
        expect(() => shiftBaseMediaDecodeTime(box('styp', u32(0)), 1)).toThrow(
            /no moof/
        );
    });

    it('refuses a traf with no tfdt', () => {
        const segment = Buffer.concat([
            box('moof', box('traf', box('tfhd', u32(0, 1)))),
            box('mdat', Buffer.from('x')),
        ]);
        expect(() => shiftBaseMediaDecodeTime(segment, 1)).toThrow(
            /0 tfdt boxes/
        );
    });

    it('refuses an unreadable box type', () => {
        const segment = syntheticSegment([[0]]);
        segment.write(' ', 4, 4, 'latin1');
        expect(() => shiftBaseMediaDecodeTime(segment, 1)).toThrow(
            /Unreadable box type/
        );
    });
});

// ---------------------------------------------------------------------------
// The same claims, against a real muxer
// ---------------------------------------------------------------------------

async function hasFfmpeg(): Promise<boolean> {
    try {
        await execFileAsync('ffmpeg', ['-version']);
        await execFileAsync('ffprobe', ['-version']);
        return true;
    } catch {
        return false;
    }
}

const ffmpegAvailable = await hasFfmpeg();

describe.skipIf(!ffmpegAvailable)('against a real fMP4 part', () => {
    let dir: string;
    let init: Buffer;
    let segments: string[];

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'fmp4-timeline-'));
        // A real source file first: the recipe under test is an *input* seek
        // into a container, which a filter source cannot stand in for.
        await execFileAsync(
            'ffmpeg',
            [
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc=size=160x120:rate=25:duration=20',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-g',
                '25',
                '-y',
                join(dir, 'source.mp4'),
            ],
            { timeout: 120_000 }
        );
        // A part cut out of the middle of it, muxed exactly as the quick-trim
        // runner muxes a copy part: the edit list then carries 10 s and the
        // fragments count from zero.
        await execFileAsync(
            'ffmpeg',
            [
                '-v',
                'error',
                '-ss',
                '10',
                '-i',
                join(dir, 'source.mp4'),
                '-c:v',
                'copy',
                '-copyts',
                '-f',
                'hls',
                '-hls_time',
                '2',
                '-hls_playlist_type',
                'vod',
                '-hls_segment_type',
                'fmp4',
                '-movflags',
                '+negative_cts_offsets+default_base_moof',
                '-hls_fmp4_init_filename',
                'init.mp4',
                '-hls_segment_filename',
                join(dir, 'segment_%03d.m4s'),
                '-y',
                join(dir, 'part.m3u8'),
            ],
            { timeout: 120_000 }
        );
        init = readFileSync(join(dir, 'init.mp4'));
        segments = readFileSync(join(dir, 'part.m3u8'), 'utf8')
            .split('\n')
            .filter((line) => line.endsWith('.m4s'));
        expect(segments.length).toBeGreaterThan(1);
    }, 180_000);

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function firstTimes(
        initBuffer: Buffer,
        segment: Buffer
    ): Promise<{ pts: number; dts: number }> {
        const path = join(dir, 'probe.mp4');
        writeFileSync(path, Buffer.concat([initBuffer, segment]));
        const { stdout } = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'packet=pts_time,dts_time',
            '-of',
            'csv=p=0',
            '-read_intervals',
            '%+#1',
            path,
        ]);
        const [pts, dts] = String(stdout).trim().split('\n')[0].split(',');
        return { pts: parseFloat(pts), dts: parseFloat(dts) };
    }

    it('reads the timescale the muxer wrote', () => {
        const timescale = readTrackTimescale(init);
        expect(timescale).toBeGreaterThan(0);
        // Whatever it is, the fragments are counted in it.
        expect(Number.isInteger(timescale)).toBe(true);
    });

    it('is what makes a bare part read as starting at zero', async () => {
        // The premise of the whole exercise: before the patch the part claims
        // the source's clock, and only because of the edit list.
        const before = await firstTimes(
            init,
            readFileSync(join(dir, segments[0]))
        );
        expect(before.dts).toBeGreaterThan(9);

        const after = await firstTimes(
            neutralizeEditList(Buffer.from(init)),
            readFileSync(join(dir, segments[0]))
        );
        expect(after.dts).toBeCloseTo(0, 3);
    });

    it('places a neutralised part wherever the shift says', async () => {
        const timescale = readTrackTimescale(init);
        const patchedInit = neutralizeEditList(Buffer.from(init));
        const offsetTicks = Math.round(31.5 * timescale);

        let previous = -Infinity;
        for (const name of segments) {
            const raw = readFileSync(join(dir, name));
            const untouched = await firstTimes(patchedInit, raw);
            const shifted = await firstTimes(
                patchedInit,
                shiftBaseMediaDecodeTime(Buffer.from(raw), offsetTicks)
            );
            // Every segment moves by exactly the offset, and the relative
            // spacing inside the run is untouched.
            expect(shifted.dts - untouched.dts).toBeCloseTo(31.5, 3);
            expect(shifted.pts - untouched.pts).toBeCloseTo(31.5, 3);
            expect(shifted.dts).toBeGreaterThan(previous);
            previous = shifted.dts;
        }
    });
});
