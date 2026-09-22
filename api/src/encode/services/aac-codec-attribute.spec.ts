/**
 * The codec attribute is read from bytes, so it is tested against bytes: one
 * init segment from a real encode — the bandwidth-saving audio group of the
 * session whose renditions this fix brought back — and synthetic ones for the
 * configurations ffmpeg's own `aac` encoder will never produce on demand
 * (HE-AAC in both of its signalling forms, MPEG-2 AAC, QuickTime sample
 * entries, an `esds` behind unreadable size fields).
 */

import { describe, expect, it } from 'vitest';
import { aacCodecAttribute } from './aac-codec-attribute';

// ---------------------------------------------------------------------------
// A real init segment
// ---------------------------------------------------------------------------

/**
 * `stream_low_Bandwidth_Saving/init_4.mp4` from a real two-wave encode: AAC-LC,
 * 48 kHz, mono, written by ffmpeg with the four-byte descriptor sizes it always
 * uses (`03 80 80 80 25 …`). The variants on this group were the ones VHS
 * refused for a missing audio codec.
 */
const REAL_INIT = Buffer.from(
    'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAtltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAA' +
        'AAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB23Ry' +
        'YWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA' +
        'AAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAAAAAAAAAAEAAAAAAVNtZGlhAAAAIG1kaGQAAAAA' +
        'AAAAAAAAAAAAALuAAAAAAFXEAAAAAAAlaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAE1vbm8AAAABBm1pbmYAAAAQc21oZAAA' +
        'AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAAynN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEA' +
        'AAAAAAAAAQAAAAAAAAAAAAEAEAAAAAC7gAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAENiAABDYgFgICABRGIVuUA' +
        'BoCAgAECAAAAFGJ0cnQAAAAAAAENiAABDYgAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAA' +
        'AAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRh' +
        'AAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYy' +
        'LjEyLjEwMA==',
    'base64'
);

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

/**
 * An MPEG-4 descriptor: tag, expandable size, body. The size is one byte unless
 * `longSize`, which writes the four-byte continuation form ffmpeg uses.
 */
function descriptor(tag: number, body: Buffer, longSize = false): Buffer {
    const length = body.length;
    const size = longSize
        ? Buffer.from([
              0x80 | ((length >> 21) & 0x7f),
              0x80 | ((length >> 14) & 0x7f),
              0x80 | ((length >> 7) & 0x7f),
              length & 0x7f,
          ])
        : Buffer.from([length]);
    return Buffer.concat([Buffer.from([tag]), size, body]);
}

/** Pack `[value, bitCount]` fields most-significant-bit first, zero-padded. */
function bits(...fields: [number, number][]): Buffer {
    let string = '';
    for (const [value, count] of fields) {
        string += value.toString(2).padStart(count, '0');
    }
    while (string.length % 8) string += '0';
    return Buffer.from(string.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
}

const OTI_MPEG4_AUDIO = 0x40;

/** AudioSpecificConfig: object type, 48 kHz (index 3), mono, GASpecificConfig zeros. */
const AAC_LC = bits([2, 5], [3, 4], [1, 4], [0, 1], [0, 1], [0, 1]);

/** Explicit hierarchical HE-AAC: SBR as the outer type, LC named inside it. */
const HE_AAC_EXPLICIT = bits(
    [5, 5],
    [3, 4],
    [1, 4],
    [3, 4],
    [2, 5],
    [0, 1],
    [0, 1],
    [0, 1]
);

/** Backwards-compatible HE-AAC: AAC-LC, then a sync extension declaring SBR. */
const HE_AAC_COMPAT = bits(
    ...([
        [2, 5],
        [3, 4],
        [1, 4],
        [0, 1],
        [0, 1],
        [0, 1],
    ] as [number, number][]),
    [0x2b7, 11],
    [5, 5],
    [1, 1],
    [3, 4]
);

/** …and a second extension declaring parametric stereo on top. */
const HE_AAC_V2_COMPAT = bits(
    ...([
        [2, 5],
        [3, 4],
        [1, 4],
        [0, 1],
        [0, 1],
        [0, 1],
    ] as [number, number][]),
    [0x2b7, 11],
    [5, 5],
    [1, 1],
    [3, 4],
    [0x548, 11],
    [1, 1]
);

function esds(
    config: Buffer,
    options: { oti?: number; esFlags?: number; longSizes?: boolean } = {}
): Buffer {
    const { oti = OTI_MPEG4_AUDIO, esFlags = 0, longSizes = false } = options;
    // ES_ID, then the flags and the optional fields they announce.
    const esHead: number[] = [0, 1, esFlags];
    if (esFlags & 0x80) esHead.push(0, 2); // dependsOn_ES_ID
    if (esFlags & 0x40) esHead.push(3, 0x75, 0x72, 0x6c); // URLlength + "url"
    if (esFlags & 0x20) esHead.push(0, 3); // OCR_ES_Id
    // objectTypeIndication, streamType + bufferSizeDB, maxBitrate, avgBitrate.
    const decoderHead = Buffer.from([
        oti,
        0x15,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ]);
    const decoderConfig = descriptor(
        0x04,
        Buffer.concat([decoderHead, descriptor(0x05, config, longSizes)]),
        longSizes
    );
    return box(
        'esds',
        Buffer.alloc(4),
        descriptor(
            0x03,
            Buffer.concat([Buffer.from(esHead), decoderConfig]),
            longSizes
        )
    );
}

/**
 * A sample entry: reserved + data_reference_index (8), the AudioSampleEntry
 * fields (20), sixteen more for a QuickTime version-1 entry, then children.
 */
function sampleEntry(
    type: string,
    options: { version?: number; children?: Buffer[]; prelude?: Buffer } = {}
): Buffer {
    const { version = 0, children = [], prelude } = options;
    const fields = Buffer.alloc(version === 1 ? 44 : 28);
    fields.writeUInt16BE(version, 8);
    return box(type, prelude ?? fields, ...children);
}

function trak(...entries: Buffer[]): Buffer {
    const count = Buffer.alloc(8);
    count.writeUInt32BE(entries.length, 4);
    return box(
        'trak',
        box('mdia', box('minf', box('stbl', box('stsd', count, ...entries))))
    );
}

function init(...traks: Buffer[]): Buffer {
    return Buffer.concat([
        box('ftyp', Buffer.from('iso5', 'latin1')),
        box('moov', ...traks),
    ]);
}

const audioInit = (config: Buffer, esdsOptions = {}): Buffer =>
    init(trak(sampleEntry('mp4a', { children: [esds(config, esdsOptions)] })));

// ---------------------------------------------------------------------------

describe('aacCodecAttribute', () => {
    it('reads AAC-LC off the init segment of a real encode', () => {
        expect(aacCodecAttribute(REAL_INIT)).toBe('mp4a.40.2');
    });

    it('names the object type the AudioSpecificConfig declares', () => {
        expect(aacCodecAttribute(audioInit(AAC_LC))).toBe('mp4a.40.2');
        expect(aacCodecAttribute(audioInit(HE_AAC_EXPLICIT))).toBe('mp4a.40.5');
    });

    it('reads an escaped object type', () => {
        // Types past 31 are written as 31 plus a six-bit remainder.
        const escaped = bits([31, 5], [10, 6], [3, 4], [1, 4]);
        expect(aacCodecAttribute(audioInit(escaped))).toBe('mp4a.40.42');
    });

    it('resolves backwards-compatible HE-AAC signalling to the type it is', () => {
        // AAC-LC on the face of it; the sync extension says otherwise, and so
        // would ffmpeg's `profile` — the attribute has to agree with the stream.
        expect(aacCodecAttribute(audioInit(HE_AAC_COMPAT))).toBe('mp4a.40.5');
        expect(aacCodecAttribute(audioInit(HE_AAC_V2_COMPAT))).toBe(
            'mp4a.40.29'
        );
    });

    it('keeps AAC-LC when a sync extension says SBR is absent', () => {
        const sbrAbsent = bits(
            ...([
                [2, 5],
                [3, 4],
                [1, 4],
                [0, 1],
                [0, 1],
                [0, 1],
            ] as [number, number][]),
            [0x2b7, 11],
            [5, 5],
            [0, 1]
        );
        expect(aacCodecAttribute(audioInit(sbrAbsent))).toBe('mp4a.40.2');
    });

    it('ignores trailing bits that are not a sync extension', () => {
        const trailing = bits(
            ...([
                [2, 5],
                [3, 4],
                [1, 4],
                [0, 1],
                [0, 1],
                [0, 1],
            ] as [number, number][]),
            [0x123, 11],
            [5, 5],
            [1, 1]
        );
        expect(aacCodecAttribute(audioInit(trailing))).toBe('mp4a.40.2');
    });

    it('reads the four-byte descriptor sizes ffmpeg writes', () => {
        expect(aacCodecAttribute(audioInit(AAC_LC, { longSizes: true }))).toBe(
            'mp4a.40.2'
        );
    });

    it('steps over the optional ES descriptor fields', () => {
        // dependsOn_ES_ID, a URL and an OCR stream all present.
        expect(aacCodecAttribute(audioInit(AAC_LC, { esFlags: 0xe0 }))).toBe(
            'mp4a.40.2'
        );
    });

    it('accepts a QuickTime version-1 sample entry', () => {
        const qt = init(
            trak(sampleEntry('mp4a', { version: 1, children: [esds(AAC_LC)] }))
        );
        expect(aacCodecAttribute(qt)).toBe('mp4a.40.2');
    });

    it('accepts an encrypted sample entry', () => {
        const encrypted = init(
            trak(sampleEntry('enca', { children: [esds(AAC_LC)] }))
        );
        expect(aacCodecAttribute(encrypted)).toBe('mp4a.40.2');
    });

    it('finds the esds by scanning when the size fields ahead of it are unreadable', () => {
        // An impossible size where the version-0 children start, a size that
        // overruns the entry where version-1 children would, then the box.
        const prelude = Buffer.concat([
            Buffer.alloc(28),
            Buffer.from([0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x72, 0x65, 0x65]),
        ]);
        const scanned = init(
            trak(sampleEntry('mp4a', { prelude, children: [esds(AAC_LC)] }))
        );
        expect(aacCodecAttribute(scanned)).toBe('mp4a.40.2');
    });

    it('picks the audio track when a video track comes first', () => {
        const video = trak(sampleEntry('avc1'));
        const audio = trak(sampleEntry('mp4a', { children: [esds(AAC_LC)] }));
        expect(aacCodecAttribute(init(video, audio))).toBe('mp4a.40.2');
    });

    it('names MPEG-2 AAC by its object type indication alone', () => {
        expect(aacCodecAttribute(audioInit(AAC_LC, { oti: 0x67 }))).toBe(
            'mp4a.67'
        );
    });

    it('says nothing for audio that is not AAC', () => {
        // An AC-3 entry carries no esds; an MP3 one carries an esds naming MP3.
        expect(
            aacCodecAttribute(init(trak(sampleEntry('ac-3'))))
        ).toBeUndefined();
        expect(
            aacCodecAttribute(audioInit(AAC_LC, { oti: 0x69 }))
        ).toBeUndefined();
    });

    it('says nothing for an init with no audio track', () => {
        expect(
            aacCodecAttribute(init(trak(sampleEntry('avc1'))))
        ).toBeUndefined();
    });

    it('never throws — garbage, nothing, and a descriptor cut short all read as unknown', () => {
        expect(
            aacCodecAttribute(Buffer.from('not an mp4 at all'))
        ).toBeUndefined();
        expect(aacCodecAttribute(Buffer.alloc(0))).toBeUndefined();

        const whole = audioInit(AAC_LC);
        // Everything up to and including the DecoderSpecificInfo tag and size,
        // but none of the AudioSpecificConfig it promises.
        const cut = whole.subarray(
            0,
            whole.indexOf(Buffer.from([0x05, AAC_LC.length])) + 2
        );
        expect(aacCodecAttribute(cut)).toBeUndefined();
    });
});
