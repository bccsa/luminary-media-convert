/**
 * The RFC 6381 codec attribute of an AAC track, read from its init segment.
 *
 * Every variant in a master playlist has to name the codecs of the audio group
 * it plays with, not only its own video codec: a player that finds two codecs on
 * one variant and one on another concludes the streams differ and refuses the
 * odd one out (Video.js's VHS marks it incompatible for good, "codec count 1
 * !== 2"). When a ladder is encoded in waves, ffmpeg writes the audio codec only
 * onto variants of the wave that carried the audio, and `ladder-waves.ts` has to
 * restore it on the rest — which means knowing, per audio group, what the codec
 * is.
 *
 * For a re-encoded group that is known by construction (`aacArgs` forces
 * AAC-LC). For a copy-mode group the source decides, so the answer is read from
 * the stream ffmpeg actually wrote: the init segment's sample entry carries the
 * `esds` box, and inside it the AudioSpecificConfig names the audio object type
 * — 2 for AAC-LC, 5 for HE-AAC, 29 for HE-AACv2 — which is the last field of
 * `mp4a.40.<type>`. ffmpeg derives its own `CODECS` from the same bytes, so this
 * is not a guess standing in for ffmpeg's answer; it is ffmpeg's answer, read
 * from where it left it.
 *
 * Pure: bytes in, string out. Anything unreadable yields `undefined` rather than
 * a throw, because a variant with an incomplete `CODECS` is a degraded master
 * and a failed encode is not the price of it.
 */

import { Fmp4BoxError, childrenOf, readBoxes, type Box } from './fmp4-timeline';

/** Sample-entry types that can carry an `esds` box. `enca` is an encrypted `mp4a`. */
const AUDIO_SAMPLE_ENTRIES = new Set(['mp4a', 'enca']);

/**
 * Reserved (6) + data_reference_index (2) + the AudioSampleEntry fields (20)
 * precede a version-0 sample entry's child boxes; a QuickTime version-1 entry
 * carries sixteen more.
 */
const SAMPLE_ENTRY_CHILD_OFFSETS = [28, 44];

/**
 * The codec attribute of the first audio track in `init`, or `undefined` when
 * there is no readable AAC decoder configuration to take it from.
 */
export function aacCodecAttribute(init: Buffer): string | undefined {
    let entry: Box | undefined;
    try {
        entry = firstAudioSampleEntry(init);
    } catch (error) {
        if (error instanceof Fmp4BoxError) return undefined;
        throw error;
    }
    if (!entry) return undefined;

    const esds = findEsds(init, entry);
    if (!esds) return undefined;
    return codecAttributeFromEsds(init.subarray(esds.contentStart, esds.end));
}

/** `moov > trak > mdia > minf > stbl > stsd > (mp4a | enca)`, the first found. */
function firstAudioSampleEntry(init: Buffer): Box | undefined {
    for (const moov of readBoxes(init, 0, init.length)) {
        if (moov.type !== 'moov') continue;
        for (const trak of childrenOf(init, moov, 'trak')) {
            for (const mdia of childrenOf(init, trak, 'mdia')) {
                for (const minf of childrenOf(init, mdia, 'minf')) {
                    for (const stbl of childrenOf(init, minf, 'stbl')) {
                        for (const stsd of childrenOf(init, stbl, 'stsd')) {
                            // version + flags (4), entry_count (4), then the entries.
                            const entries = readBoxes(
                                init,
                                stsd.contentStart + 8,
                                stsd.end
                            );
                            const audio = entries.find((e) =>
                                AUDIO_SAMPLE_ENTRIES.has(e.type)
                            );
                            if (audio) return audio;
                        }
                    }
                }
            }
        }
    }
    return undefined;
}

/**
 * The `esds` child of a sample entry. Tries the version-0 and version-1 child
 * offsets, then falls back to a scan — a malformed size field must not hide a
 * box that is plainly there.
 */
function findEsds(init: Buffer, entry: Box): Box | undefined {
    for (const offset of SAMPLE_ENTRY_CHILD_OFFSETS) {
        try {
            const esds = readBoxes(
                init,
                entry.contentStart + offset,
                entry.end
            ).find((b) => b.type === 'esds');
            if (esds) return esds;
        } catch (error) {
            if (!(error instanceof Fmp4BoxError)) throw error;
        }
    }
    const at = init.indexOf('esds', entry.contentStart, 'latin1');
    if (at < 4 || at + 4 > entry.end) return undefined;
    const size = init.readUInt32BE(at - 4);
    if (size < 8 || at - 4 + size > entry.end) return undefined;
    return {
        type: 'esds',
        start: at - 4,
        contentStart: at + 4,
        end: at - 4 + size,
    };
}

// ---------------------------------------------------------------------------
// MPEG-4 descriptors (ISO 14496-1 §7.2) and the AudioSpecificConfig (14496-3)
// ---------------------------------------------------------------------------

interface Descriptor {
    tag: number;
    size: number;
    contentStart: number;
}

/** A tag byte, then a size in up to four 7-bit groups, high bit continuing. */
function readDescriptor(buf: Buffer, offset: number): Descriptor | undefined {
    if (offset >= buf.length) return undefined;
    const tag = buf[offset];
    let size = 0;
    let p = offset + 1;
    for (let i = 0; i < 4; i++) {
        if (p >= buf.length) return undefined;
        const byte = buf[p++];
        size = (size << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
    }
    if (p + size > buf.length) return undefined;
    return { tag, size, contentStart: p };
}

const ES_DESCRIPTOR = 0x03;
const DECODER_CONFIG_DESCRIPTOR = 0x04;
const DECODER_SPECIFIC_INFO = 0x05;
/** objectTypeIndication for MPEG-4 audio; the AudioSpecificConfig then names the type. */
const OTI_MPEG4_AUDIO = 0x40;
/** MPEG-2 AAC (main / LC / SSR): the indication alone is the attribute. */
const OTI_MPEG2_AAC = new Set([0x66, 0x67, 0x68]);

function codecAttributeFromEsds(esds: Buffer): string | undefined {
    // version + flags
    const es = readDescriptor(esds, 4);
    if (!es || es.tag !== ES_DESCRIPTOR) return undefined;

    let offset = es.contentStart + 2; // ES_ID
    if (offset >= esds.length) return undefined;
    const flags = esds[offset++];
    if (flags & 0x80) offset += 2; // dependsOn_ES_ID
    if (flags & 0x40) offset += 1 + (esds[offset] ?? 0); // URLlength + URL
    if (flags & 0x20) offset += 2; // OCR_ES_Id

    const decoder = readDescriptor(esds, offset);
    if (!decoder || decoder.tag !== DECODER_CONFIG_DESCRIPTOR) return undefined;
    const oti = esds[decoder.contentStart];
    if (oti !== OTI_MPEG4_AUDIO) {
        return OTI_MPEG2_AAC.has(oti) ? `mp4a.${oti.toString(16)}` : undefined;
    }

    // objectTypeIndication (1), streamType + bufferSizeDB (4), maxBitrate (4),
    // avgBitrate (4), then the DecoderSpecificInfo.
    const specific = readDescriptor(esds, decoder.contentStart + 13);
    if (!specific || specific.tag !== DECODER_SPECIFIC_INFO) return undefined;
    const type = audioObjectType(
        esds.subarray(
            specific.contentStart,
            specific.contentStart + specific.size
        )
    );
    return type === undefined ? undefined : `mp4a.40.${type}`;
}

/** Most-significant-bit-first reader over a byte buffer. */
class BitReader {
    private position = 0;

    constructor(private readonly bytes: Buffer) {}

    remaining(): number {
        return this.bytes.length * 8 - this.position;
    }

    peek(count: number): number {
        const at = this.position;
        const value = this.read(count);
        this.position = at;
        return value;
    }

    read(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byte = this.bytes[this.position >> 3] ?? 0;
            const bit = (byte >> (7 - (this.position & 7))) & 1;
            value = (value << 1) | bit;
            this.position++;
        }
        return value;
    }
}

const SYNC_EXTENSION_SBR = 0x2b7;
const SYNC_EXTENSION_PS = 0x548;
const AOT_AAC_LC = 2;
const AOT_SBR = 5;
const AOT_PS = 29;

/**
 * The audio object type an AudioSpecificConfig declares — with HE-AAC signalled
 * the backwards-compatible way (AAC-LC plus a sync extension) resolved to the
 * type it actually is, which is what ffmpeg's own `profile` does too.
 */
function audioObjectType(asc: Buffer): number | undefined {
    if (asc.length === 0) return undefined;
    const bits = new BitReader(asc);
    const readType = (): number => {
        const t = bits.read(5);
        return t === 31 ? 32 + bits.read(6) : t;
    };
    const skipFrequency = (): void => {
        if (bits.read(4) === 15) bits.read(24);
    };

    let type = readType();
    skipFrequency();
    bits.read(4); // channelConfiguration

    // Explicit hierarchical signalling names the extension type outright, and
    // any object type other than LC has no backwards-compatible extension worth
    // looking for: the base type is the answer.
    if (type !== AOT_AAC_LC) return type;

    // GASpecificConfig for AAC-LC.
    bits.read(1); // frameLengthFlag
    if (bits.read(1)) bits.read(14); // dependsOnCoreCoder → coreCoderDelay
    bits.read(1); // extensionFlag

    // Backwards-compatible SBR / PS signalling (ISO 14496-3 §1.6.6).
    if (bits.remaining() >= 16 && bits.peek(11) === SYNC_EXTENSION_SBR) {
        bits.read(11);
        if (readType() === AOT_SBR && bits.read(1)) {
            type = AOT_SBR;
            skipFrequency();
            if (bits.remaining() >= 12 && bits.peek(11) === SYNC_EXTENSION_PS) {
                bits.read(11);
                if (bits.read(1)) type = AOT_PS;
            }
        }
    }
    return type;
}
