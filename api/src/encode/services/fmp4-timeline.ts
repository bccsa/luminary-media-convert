/**
 * fMP4 timeline surgery — pure functions over ISO-BMFF buffers, no I/O.
 *
 * A quick trim produces its output as several independent ffmpeg runs per
 * stream, and the HLS fMP4 muxer gives every run the *same* timeline: each
 * fragment's `tfdt` (`baseMediaDecodeTime`) is written zero-based, and where the
 * run actually started in the source is recorded only in the init segment's
 * edit list (`moov > trak > edts > elst`, an empty edit whose duration is the
 * run's start in the movie timescale). Measured on the reference source: a copy
 * part cut at 19.62 s has `elst` `[[19620, -1], [0, 5400]]` and its first
 * fragment's `tfdt` is 0.
 *
 * That convention is fatal here, because the players this pipeline targets read
 * the fragment timeline and **ignore the edit list**. hls.js's passthrough
 * remuxer takes each discontinuity domain's anchor from the first `tfdt` it sees
 * (`getSampleData` in `hls.js`), and the audio track borrows the main track's
 * anchor for the same domain — so if video and audio parts of one domain start
 * at different places in the source (they do: every stream splices on its own
 * keyframe / frame grid, by design), the difference lands directly on the
 * audio's placement. Measured result: audio fully out of sync, the wrong
 * duration reported, an unplayable tail.
 *
 * The answer is to make the fragments say what they mean. Before a stream's
 * playlist is assembled, every part's segments are shifted so their `tfdt`
 * carries the **continuous output timeline** — the part's position in the
 * playlist plus its own intra-run offset — and the init's edit list is
 * neutralised so nothing applies the source-relative shift a second time. Every
 * stream then shares one honest zero-based clock and where a part boundary fell
 * stops mattering.
 *
 * Two deliberate limits:
 *
 * - **Only the boxes on the path are parsed.** No box is rebuilt and no box
 *   changes size, so `trun` data offsets, `sidx` reference sizes and every
 *   enclosing box length stay valid without being touched. `edts` is
 *   neutralised by overwriting its *type* with `free` (a box every reader
 *   skips), not by removing it.
 * - **Anything unexpected throws** ({@link Fmp4BoxError}) rather than writing a
 *   plausible-looking segment. The caller's answer to a throw is the precise
 *   (full re-encode) path, which is always available; a silently mistimed
 *   output is not recoverable at all.
 */

/** A box this pipeline cannot patch. Always the end of the quick-trim attempt. */
export class Fmp4BoxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Fmp4BoxError';
    }
}

/** `size` (4) + `type` (4). 64-bit `largesize` headers are refused below. */
const HEADER_BYTES = 8;

const UINT32_MAX = 0xffffffff;

interface Box {
    type: string;
    /** Offset of the box header. */
    start: number;
    /** Offset of the first content byte, i.e. `start + 8`. */
    contentStart: number;
    /** Offset one past the last content byte. */
    end: number;
}

/**
 * The boxes laid out end to end in `[from, to)`.
 *
 * Minimal by intent: 32-bit sizes only. A `size` of 1 means a 64-bit
 * `largesize` follows, which this muxer never writes at any level we walk — and
 * guessing at one is exactly the kind of silent misread this module exists to
 * avoid, so it is refused.
 */
function readBoxes(buffer: Buffer, from: number, to: number): Box[] {
    const boxes: Box[] = [];
    let offset = from;

    while (offset < to) {
        if (offset + HEADER_BYTES > to) {
            throw new Fmp4BoxError(
                `Truncated box header at offset ${offset} (${to - offset} ` +
                    `byte(s) left)`
            );
        }
        const size = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (!/^[\x20-\x7e]{4}$/.test(type)) {
            throw new Fmp4BoxError(
                `Unreadable box type at offset ${offset}: ` +
                    `${JSON.stringify(type)}`
            );
        }
        if (size === 1) {
            throw new Fmp4BoxError(
                `Box ${type} at offset ${offset} uses a 64-bit largesize, ` +
                    `which this patcher does not read`
            );
        }
        // Size 0 means "to the end of the enclosing extent" (ISO 14496-12) and
        // is legal for the last box — `mdat` is the one that uses it.
        const end = size === 0 ? to : offset + size;
        if (size !== 0 && size < HEADER_BYTES) {
            throw new Fmp4BoxError(
                `Box ${type} at offset ${offset} declares an impossible ` +
                    `size of ${size}`
            );
        }
        if (end > to) {
            throw new Fmp4BoxError(
                `Box ${type} at offset ${offset} runs ${end - to} byte(s) ` +
                    `past its container`
            );
        }
        boxes.push({ type, start: offset, contentStart: offset + 8, end });
        offset = end;
    }

    return boxes;
}

function childrenOf(buffer: Buffer, box: Box, type: string): Box[] {
    return readBoxes(buffer, box.contentStart, box.end).filter(
        (child) => child.type === type
    );
}

/** The one box of `type` inside `box`, or a throw naming what was missing. */
function onlyChild(
    buffer: Buffer,
    box: Box | null,
    type: string,
    path: string
): Box {
    const scope = box
        ? readBoxes(buffer, box.contentStart, box.end)
        : readBoxes(buffer, 0, buffer.length);
    const matches = scope.filter((child) => child.type === type);
    if (matches.length === 0) {
        throw new Fmp4BoxError(`No ${path} box`);
    }
    if (matches.length > 1) {
        throw new Fmp4BoxError(
            `${matches.length} ${path} boxes where one was expected`
        );
    }
    return matches[0];
}

function requireContent(box: Box, bytes: number, what: string): void {
    if (box.end - box.contentStart < bytes) {
        throw new Fmp4BoxError(
            `${what} holds ${box.end - box.contentStart} content byte(s), ` +
                `too few to read`
        );
    }
}

/**
 * The media timescale of the init segment's track, in ticks per second — what
 * a `tfdt` is counted in.
 *
 * Read from `moov > trak > mdia > mdhd`. A quick-trim part is always one
 * stream, so exactly one `trak` is expected; more than one means the caller is
 * holding something other than the init it thinks it is.
 */
export function readTrackTimescale(init: Buffer): number {
    const moov = onlyChild(init, null, 'moov', 'moov');
    const trak = onlyChild(init, moov, 'trak', 'moov > trak');
    const mdia = onlyChild(init, trak, 'mdia', 'moov > trak > mdia');
    const mdhd = onlyChild(init, mdia, 'mdhd', 'moov > trak > mdia > mdhd');

    const version = init.readUInt8(mdhd.contentStart);
    // version(1) + flags(3), then creation / modification (4 or 8 each).
    const timescaleAt = mdhd.contentStart + (version === 1 ? 20 : 12);
    requireContent(mdhd, version === 1 ? 24 : 16, 'mdhd');

    const timescale = init.readUInt32BE(timescaleAt);
    if (!(timescale > 0)) {
        throw new Fmp4BoxError(`mdhd reports a timescale of ${timescale}`);
    }
    return timescale;
}

/**
 * Take the edit list out of play, in place.
 *
 * The `edts` box's *type* is overwritten with `free`, which every reader skips
 * and no reader parses — the content is left exactly as it was, so nothing
 * changes size and every enclosing box length stays correct. A no-op when the
 * init carries no edit list.
 *
 * Returns the same buffer it was handed, for call-site readability.
 */
export function neutralizeEditList(init: Buffer): Buffer {
    const moov = onlyChild(init, null, 'moov', 'moov');
    for (const trak of childrenOf(init, moov, 'trak')) {
        for (const edts of childrenOf(init, trak, 'edts')) {
            init.write('free', edts.start + 4, 4, 'latin1');
        }
    }
    return init;
}

/**
 * Add `offsetTicks` to every `baseMediaDecodeTime` in the segment, in place.
 *
 * A segment may hold more than one `moof`, and a `moof` more than one `traf`;
 * every `tfdt` in it is moved by the same amount, which is what keeps the
 * fragments' relative timing intact while the run as a whole lands where the
 * playlist puts it.
 *
 * Version 0 (32-bit) boxes are patched in place while the sum fits. They are
 * *not* upgraded to version 1 on overflow: a version 1 `tfdt` is four bytes
 * longer, which moves `mdat` relative to its `moof` and so invalidates every
 * `trun` data offset and `sidx` reference size in the segment — a rewrite this
 * module deliberately does not do. It cannot arise from this pipeline anyway
 * (the muxer writes version 1 boxes, and 2^32 ticks is 13 hours at the 90 kHz
 * video timescale), so an overflow is reported rather than papered over.
 *
 * Returns the same buffer it was handed.
 */
export function shiftBaseMediaDecodeTime(
    segment: Buffer,
    offsetTicks: number
): Buffer {
    if (!Number.isSafeInteger(offsetTicks)) {
        throw new Fmp4BoxError(
            `Offset ${offsetTicks} is not a whole number of ticks`
        );
    }

    const moofs = readBoxes(segment, 0, segment.length).filter(
        (box) => box.type === 'moof'
    );
    if (moofs.length === 0) {
        throw new Fmp4BoxError('Segment holds no moof box');
    }

    for (const moof of moofs) {
        const trafs = childrenOf(segment, moof, 'traf');
        if (trafs.length === 0) {
            throw new Fmp4BoxError(
                `moof at offset ${moof.start} holds no traf box`
            );
        }
        for (const traf of trafs) {
            const tfdts = childrenOf(segment, traf, 'tfdt');
            if (tfdts.length !== 1) {
                throw new Fmp4BoxError(
                    `traf at offset ${traf.start} holds ${tfdts.length} ` +
                        `tfdt boxes where one was expected`
                );
            }
            shiftOneTfdt(segment, tfdts[0], offsetTicks);
        }
    }

    return segment;
}

function shiftOneTfdt(segment: Buffer, tfdt: Box, offsetTicks: number): void {
    const version = segment.readUInt8(tfdt.contentStart);
    const valueAt = tfdt.contentStart + 4;

    if (version === 1) {
        requireContent(tfdt, 12, 'tfdt (version 1)');
        const shifted = segment.readBigUInt64BE(valueAt) + BigInt(offsetTicks);
        if (shifted < 0n) {
            throw new Fmp4BoxError(
                `Shifting the tfdt at offset ${tfdt.start} by ` +
                    `${offsetTicks} would make it negative`
            );
        }
        segment.writeBigUInt64BE(shifted, valueAt);
        return;
    }

    if (version !== 0) {
        throw new Fmp4BoxError(
            `tfdt at offset ${tfdt.start} declares version ${version}`
        );
    }

    requireContent(tfdt, 8, 'tfdt (version 0)');
    const shifted = segment.readUInt32BE(valueAt) + offsetTicks;
    if (shifted < 0) {
        throw new Fmp4BoxError(
            `Shifting the tfdt at offset ${tfdt.start} by ${offsetTicks} ` +
                `would make it negative`
        );
    }
    if (shifted > UINT32_MAX) {
        throw new Fmp4BoxError(
            `Shifting the version 0 tfdt at offset ${tfdt.start} by ` +
                `${offsetTicks} overflows 32 bits (${shifted}); upgrading it ` +
                `to version 1 would resize the moof and invalidate the ` +
                `segment's trun offsets`
        );
    }
    segment.writeUInt32BE(shifted, valueAt);
}
