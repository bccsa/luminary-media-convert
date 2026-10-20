import { decryptAes128Cbc, hexToBytes, type SubtleLike } from './decrypt.js';
import { fetchMaybeEncrypted } from './fetch.js';
import { absolutizeAgainst } from './playlist-text.js';

export interface MediaStartContext {
    fetchImpl: typeof fetch;
    keyHex?: string;
    subtle?: SubtleLike;
    signal?: AbortSignal;
}

/** A byte range as `#EXT-X-BYTERANGE` and `#EXT-X-MAP`'s `BYTERANGE` write it. */
interface Range {
    length: number;
    offset: number;
}

/** A resource the playlist names, with the key in effect where it is named. */
interface Part {
    uri: string;
    range?: Range;
    key?: { method: string; iv?: string };
}

/**
 * Where a stream's media clock starts, in seconds: the decode time of its first fragment, read from the
 * fMP4 initialisation section (each track's timescale) and the first segment (`tfdt`), decrypted where
 * the playlist's AES-128 key covers them. A player's timeline starts there, so a subtitle timestamp map is
 * read against it.
 *
 * Null when it cannot be told: a playlist that is not fMP4, a read or a decryption that fails.
 */
export async function readMediaStart(playlistUrl: string, ctx: MediaStartContext): Promise<number | null> {
    try {
        const playlist = await fetchMaybeEncrypted(playlistUrl, { ...ctx, expect: 'playlist' });
        const { init, first, sequence } = firstParts(playlist.text);
        if (!init || !first) return null;
        const resolve = absolutizeAgainst(playlistUrl);
        const [initBytes, firstBytes] = await Promise.all([
            readPart({ ...init, uri: resolve(init.uri) }, sequence, ctx),
            readPart({ ...first, uri: resolve(first.uri) }, sequence, ctx),
        ]);
        return firstDecodeTime(initBytes, firstBytes);
    } catch {
        return null;
    }
}

/** The initialisation section and the first segment, each with the key in effect where it is named. */
function firstParts(text: string): { init?: Part; first?: Part; sequence: number } {
    let key: Part['key'];
    let init: Part | undefined;
    let range: Range | undefined;
    let sequence = 0;
    let inSegment = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            sequence = Number(line.slice(22)) || 0;
        } else if (line.startsWith('#EXT-X-KEY:')) {
            const method = attribute(line, 'METHOD') ?? 'NONE';
            key = method === 'NONE' ? undefined : { method, iv: attribute(line, 'IV') };
        } else if (line.startsWith('#EXT-X-MAP:')) {
            const uri = attribute(line, 'URI');
            const mapRange = parseRange(attribute(line, 'BYTERANGE'));
            if (uri && !init) init = { uri, ...(mapRange ? { range: mapRange } : {}), ...(key ? { key } : {}) };
        } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
            range = parseRange(line.slice(17));
        } else if (line.startsWith('#EXTINF:')) {
            inSegment = true;
        } else if (!line.startsWith('#') && inSegment) {
            return { init, first: { uri: line, ...(range ? { range } : {}), ...(key ? { key } : {}) }, sequence };
        }
    }
    return { init, sequence };
}

function attribute(line: string, name: string): string | undefined {
    const match = line.match(new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`));
    if (!match) return undefined;
    return match[2] ?? match[1];
}

/** `length[@offset]`; a missing offset is the start of the resource, as it is for its first range. */
function parseRange(text: string | undefined): Range | undefined {
    if (!text) return undefined;
    const [length, offset] = text.split('@').map(Number);
    if (!Number.isFinite(length) || length! <= 0) return undefined;
    return { length: length!, offset: Number.isFinite(offset) ? offset! : 0 };
}

async function readPart(part: Part, sequence: number, ctx: MediaStartContext): Promise<Uint8Array> {
    const headers = part.range
        ? { Range: `bytes=${part.range.offset}-${part.range.offset + part.range.length - 1}` }
        : undefined;
    const response = await ctx.fetchImpl(part.uri, { signal: ctx.signal, ...(headers ? { headers } : {}) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${part.uri}`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    // A server that ignores the range sends the whole resource.
    if (part.range && response.status === 200 && bytes.length > part.range.length) {
        bytes = bytes.subarray(part.range.offset, part.range.offset + part.range.length);
    }
    if (!part.key) return bytes;
    if (part.key.method !== 'AES-128' || !ctx.keyHex) throw new Error(`Cannot decrypt ${part.uri}`);
    return decryptAes128Cbc(bytes, ctx.keyHex, part.key.iv ? hexToBytes(part.key.iv) : sequenceIv(sequence), ctx.subtle);
}

/** The IV a key without one implies: the segment's media sequence number, big-endian. */
function sequenceIv(sequence: number): Uint8Array {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
    return iv;
}

/** The first fragment's decode time in seconds, in the timescale of the track it is for. */
export function firstDecodeTime(init: Uint8Array, fragment: Uint8Array): number | null {
    const timescales = new Map<number, number>();
    for (const trak of children(init, 'moov', 'trak')) {
        const tkhd = find(init, trak, 'tkhd');
        const mdhd = find(init, find(init, trak, 'mdia'), 'mdhd');
        if (!tkhd || !mdhd) continue;
        const view = new DataView(init.buffer, init.byteOffset);
        const trackId = view.getUint32(tkhd.start + (init[tkhd.start] === 1 ? 20 : 12));
        const timescale = view.getUint32(mdhd.start + (init[mdhd.start] === 1 ? 20 : 12));
        if (timescale > 0) timescales.set(trackId, timescale);
    }
    const view = new DataView(fragment.buffer, fragment.byteOffset);
    for (const traf of children(fragment, 'moof', 'traf')) {
        const tfhd = find(fragment, traf, 'tfhd');
        const tfdt = find(fragment, traf, 'tfdt');
        if (!tfhd || !tfdt) continue;
        const timescale = timescales.get(view.getUint32(tfhd.start + 4));
        if (!timescale) continue;
        const time =
            fragment[tfdt.start] === 1
                ? Number(view.getBigUint64(tfdt.start + 4))
                : view.getUint32(tfdt.start + 4);
        return time / timescale;
    }
    return null;
}

/** A box's content, as offsets into its buffer. */
interface Box {
    type: string;
    start: number;
    end: number;
}

function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = start;
    while (at + 8 <= end) {
        let size = view.getUint32(at);
        const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
        let header = 8;
        if (size === 1) {
            if (at + 16 > end) return;
            size = Number(view.getBigUint64(at + 8));
            header = 16;
        } else if (size === 0) {
            size = end - at;
        }
        if (size < header || at + size > end) return;
        yield { type, start: at + header, end: at + size };
        at += size;
    }
}

function find(bytes: Uint8Array, parent: Box | undefined, type: string): Box | undefined {
    if (!parent) return undefined;
    for (const box of boxes(bytes, parent.start, parent.end)) if (box.type === type) return box;
    return undefined;
}

/** Every `child` in the top-level `parent` boxes. */
function children(bytes: Uint8Array, parent: string, child: string): Box[] {
    const found: Box[] = [];
    for (const top of boxes(bytes, 0, bytes.length)) {
        if (top.type !== parent) continue;
        for (const box of boxes(bytes, top.start, top.end)) if (box.type === child) found.push(box);
    }
    return found;
}
