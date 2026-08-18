/**
 * Media (variant) playlist parsing and building.
 *
 * Same contract as the master parser: every line either becomes a modeled
 * entry or is kept verbatim in the playlist layout, so parse → build
 * reproduces the source. That matters because the player wrapper rewrites
 * these playlists — absolutizing segment URIs, normalizing `#EXT-X-KEY` URIs,
 * swapping decrypted sidecars in — and must not disturb anything else, least
 * of all the byte ranges, which are ciphertext offsets.
 */

import {
    attr,
    formatAttributeList,
    mergeAttributes,
    parseAttributeList,
    preferOriginalNumber,
    type HlsAttribute,
} from './attributes';
import {
    getAttributeSource,
    getLayout,
    getNumericText,
    orderedHeaderNames,
    setAttributeSource,
    setHeaderOrder,
    setLayout,
    setNumericText,
} from './metadata';

/** `#EXT-X-BYTERANGE:<length>[@<offset>]`. */
export interface HlsByteRange {
    length: number;
    /**
     * Absent means "continue where the previous range in this resource ended".
     * This encoder always writes an explicit offset; other writers do not.
     */
    offset?: number;
}

export interface HlsSegment {
    /** `#EXTINF` duration in seconds. */
    duration: number;
    /** Text after the `#EXTINF` comma. `''` for the usual empty title. */
    title?: string;
    byteRange?: HlsByteRange;
    uri: string;
}

export interface HlsKey {
    /** `NONE`, `AES-128`, `SAMPLE-AES`, … */
    method: string;
    uri?: string;
    /** Raw `IV` text including the `0x` prefix. */
    iv?: string;
    keyFormat?: string;
    keyFormatVersions?: string;
}

export interface HlsMap {
    uri: string;
    byteRange?: HlsByteRange;
}

/** One position in a media playlist — a modeled entry (by identity) or a raw line. */
export type HlsMediaLayoutItem = string | HlsSegment | HlsKey | HlsMap;

export interface HlsParsedMediaPlaylist {
    version?: number;
    targetDuration?: number;
    mediaSequence?: number;
    /** `#EXT-X-PLAYLIST-TYPE`, e.g. `'VOD'`. */
    playlistType?: string;
    independentSegments?: boolean;
    /** `#EXT-X-MAP` entries, in playlist order (this encoder writes one, in the header). */
    maps: HlsMap[];
    /** `#EXT-X-KEY` entries, in playlist order. */
    keys: HlsKey[];
    segments: HlsSegment[];
    /** `#EXT-X-ENDLIST` was present — the playlist is complete (VOD). */
    endList: boolean;
}

const KEY_ATTRS = ['METHOD', 'URI', 'IV', 'KEYFORMAT', 'KEYFORMATVERSIONS'];
const MAP_ATTRS = ['URI', 'BYTERANGE'];

const HEADER_TAGS = [
    '#EXT-X-VERSION',
    '#EXT-X-TARGETDURATION',
    '#EXT-X-MEDIA-SEQUENCE',
    '#EXT-X-PLAYLIST-TYPE',
    '#EXT-X-INDEPENDENT-SEGMENTS',
];

export function parseMediaPlaylist(content: string): HlsParsedMediaPlaylist {
    const lines = content.split('\n').map((l) => l.trim());

    const maps: HlsMap[] = [];
    const keys: HlsKey[] = [];
    const segments: HlsSegment[] = [];
    const layout: HlsMediaLayoutItem[] = [];
    const headerOrder: string[] = [];

    let version: number | undefined;
    let targetDuration: number | undefined;
    let mediaSequence: number | undefined;
    let playlistType: string | undefined;
    let independentSegments = false;
    let endList = false;
    let targetDurationText: string | undefined;

    /** An `#EXTINF` awaiting its URI, plus the raw lines it consumed. */
    let pending: HlsSegment | undefined;
    let pendingLines: string[] = [];

    /** A segment that never got a URI is not a segment — keep its lines as text. */
    const flushPending = (): void => {
        if (!pending) return;
        layout.push(...pendingLines);
        pending = undefined;
        pendingLines = [];
    };

    for (const line of lines) {
        if (line === '' || line === '#EXTM3U') continue;

        if (line.startsWith('#EXTINF:')) {
            flushPending();
            pending = parseExtinf(line.slice('#EXTINF:'.length));
            pendingLines = [line];
            continue;
        }

        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            const range = parseByteRange(
                line.slice('#EXT-X-BYTERANGE:'.length).trim()
            );
            if (pending && range) {
                pending.byteRange = range;
                pendingLines.push(line);
                continue;
            }
            flushPending();
            layout.push(line);
            continue;
        }

        if (!line.startsWith('#')) {
            if (pending) {
                pending.uri = line;
                segments.push(pending);
                layout.push(pending);
                pending = undefined;
                pendingLines = [];
            } else {
                layout.push(line);
            }
            continue;
        }

        flushPending();

        if (line.startsWith('#EXT-X-KEY:')) {
            const key = parseKey(line.slice('#EXT-X-KEY:'.length));
            if (key) {
                keys.push(key);
                layout.push(key);
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line.startsWith('#EXT-X-MAP:')) {
            const map = parseMap(line.slice('#EXT-X-MAP:'.length));
            if (map) {
                maps.push(map);
                layout.push(map);
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line.startsWith('#EXT-X-VERSION:')) {
            const n = Number(line.slice('#EXT-X-VERSION:'.length).trim());
            if (Number.isFinite(n)) {
                version = n;
                headerOrder.push('#EXT-X-VERSION');
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            const raw = line.slice('#EXT-X-TARGETDURATION:'.length).trim();
            const n = Number(raw);
            if (Number.isFinite(n)) {
                targetDuration = n;
                targetDurationText = raw;
                headerOrder.push('#EXT-X-TARGETDURATION');
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const n = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim());
            if (Number.isFinite(n)) {
                mediaSequence = n;
                headerOrder.push('#EXT-X-MEDIA-SEQUENCE');
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
            playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
            headerOrder.push('#EXT-X-PLAYLIST-TYPE');
            continue;
        }

        if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
            independentSegments = true;
            headerOrder.push('#EXT-X-INDEPENDENT-SEGMENTS');
            continue;
        }

        if (line === '#EXT-X-ENDLIST') {
            endList = true;
            continue;
        }

        layout.push(line);
    }
    flushPending();

    const playlist: HlsParsedMediaPlaylist = {
        ...(version !== undefined ? { version } : {}),
        ...(targetDuration !== undefined ? { targetDuration } : {}),
        ...(mediaSequence !== undefined ? { mediaSequence } : {}),
        ...(playlistType !== undefined ? { playlistType } : {}),
        ...(independentSegments ? { independentSegments: true } : {}),
        maps,
        keys,
        segments,
        endList,
    };

    setLayout(playlist, layout);
    setHeaderOrder(playlist, headerOrder);
    if (targetDurationText !== undefined) {
        setNumericText(playlist, 'targetDuration', targetDurationText);
    }
    return playlist;
}

export function buildMediaPlaylist(playlist: HlsParsedMediaPlaylist): string {
    const lines: string[] = ['#EXTM3U'];

    for (const tag of orderedHeaderNames(playlist, HEADER_TAGS)) {
        switch (tag) {
            case '#EXT-X-VERSION':
                if (playlist.version !== undefined) {
                    lines.push(`#EXT-X-VERSION:${playlist.version}`);
                }
                break;
            case '#EXT-X-TARGETDURATION':
                if (playlist.targetDuration !== undefined) {
                    lines.push(
                        `#EXT-X-TARGETDURATION:${preferOriginalNumber(
                            getNumericText(playlist, 'targetDuration'),
                            playlist.targetDuration
                        )}`
                    );
                }
                break;
            case '#EXT-X-MEDIA-SEQUENCE':
                if (playlist.mediaSequence !== undefined) {
                    lines.push(
                        `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`
                    );
                }
                break;
            case '#EXT-X-PLAYLIST-TYPE':
                if (playlist.playlistType !== undefined) {
                    lines.push(
                        `#EXT-X-PLAYLIST-TYPE:${playlist.playlistType}`
                    );
                }
                break;
            case '#EXT-X-INDEPENDENT-SEGMENTS':
                if (playlist.independentSegments) {
                    lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
                }
                break;
        }
    }

    const mapSet = new Set<object>(playlist.maps);
    const keySet = new Set<object>(playlist.keys);
    const segmentSet = new Set<object>(playlist.segments);
    const emitted = new Set<object>();

    for (const item of getMediaPlaylistLayout(playlist) ?? []) {
        if (typeof item === 'string') {
            lines.push(item);
            continue;
        }
        if (emitted.has(item)) continue;
        if (mapSet.has(item)) {
            emitted.add(item);
            lines.push(formatMap(item as HlsMap));
        } else if (keySet.has(item)) {
            emitted.add(item);
            lines.push(formatKey(item as HlsKey));
        } else if (segmentSet.has(item)) {
            emitted.add(item);
            pushSegment(lines, item as HlsSegment);
        }
        // An entry no longer in the playlist was removed — drop it.
    }

    for (const map of playlist.maps) {
        if (emitted.has(map)) continue;
        emitted.add(map);
        lines.push(formatMap(map));
    }
    for (const key of playlist.keys) {
        if (emitted.has(key)) continue;
        emitted.add(key);
        lines.push(formatKey(key));
    }
    for (const segment of playlist.segments) {
        if (emitted.has(segment)) continue;
        emitted.add(segment);
        pushSegment(lines, segment);
    }

    if (playlist.endList) lines.push('#EXT-X-ENDLIST');

    lines.push(''); // trailing newline
    return lines.join('\n');
}

/** See {@link getMasterLayout} — same mechanism, media-playlist entries. */
export function getMediaPlaylistLayout(
    playlist: HlsParsedMediaPlaylist
): HlsMediaLayoutItem[] | undefined {
    return getLayout(playlist) as HlsMediaLayoutItem[] | undefined;
}

export function setMediaPlaylistLayout(
    playlist: HlsParsedMediaPlaylist,
    items: readonly HlsMediaLayoutItem[]
): void {
    setLayout(playlist, items);
}

/** `'1234@0'` → `{ length: 1234, offset: 0 }`; `'1234'` → `{ length: 1234 }`. */
export function parseByteRange(raw: string): HlsByteRange | undefined {
    const match = raw.trim().match(/^(\d+)(?:@(\d+))?$/);
    if (!match) return undefined;
    return {
        length: Number(match[1]),
        ...(match[2] !== undefined ? { offset: Number(match[2]) } : {}),
    };
}

export function formatByteRange(range: HlsByteRange): string {
    return range.offset === undefined
        ? `${range.length}`
        : `${range.length}@${range.offset}`;
}

function pushSegment(lines: string[], segment: HlsSegment): void {
    const duration = preferOriginalNumber(
        getNumericText(segment, 'duration'),
        segment.duration
    );
    lines.push(`#EXTINF:${duration},${segment.title ?? ''}`);
    if (segment.byteRange) {
        lines.push(`#EXT-X-BYTERANGE:${formatByteRange(segment.byteRange)}`);
    }
    lines.push(segment.uri);
}

function parseExtinf(rest: string): HlsSegment {
    const comma = rest.indexOf(',');
    const durationText = (comma >= 0 ? rest.slice(0, comma) : rest).trim();
    const title = comma >= 0 ? rest.slice(comma + 1) : undefined;
    const segment: HlsSegment = {
        duration: Number(durationText),
        ...(title !== undefined ? { title } : {}),
        uri: '',
    };
    setNumericText(segment, 'duration', durationText);
    return segment;
}

function parseKey(rest: string): HlsKey | undefined {
    const attrs = parseAttributeList(rest);
    const method = attrs.find((a) => a.name === 'METHOD')?.value;
    if (!method) return undefined;

    const key: HlsKey = {
        method,
        ...pick(attrs, 'URI', 'uri'),
        ...pick(attrs, 'IV', 'iv'),
        ...pick(attrs, 'KEYFORMAT', 'keyFormat'),
        ...pick(attrs, 'KEYFORMATVERSIONS', 'keyFormatVersions'),
    };
    setAttributeSource(key, attrs);
    return key;
}

function parseMap(rest: string): HlsMap | undefined {
    const attrs = parseAttributeList(rest);
    const uri = attrs.find((a) => a.name === 'URI' && a.quoted)?.value;
    if (uri === undefined) return undefined;

    const rangeText = attrs.find((a) => a.name === 'BYTERANGE')?.value;
    const byteRange = rangeText ? parseByteRange(rangeText) : undefined;

    const map: HlsMap = { uri, ...(byteRange ? { byteRange } : {}) };
    setAttributeSource(map, attrs);
    return map;
}

function formatKey(key: HlsKey): string {
    const modeled: (HlsAttribute | undefined)[] = [
        attr('METHOD', key.method, false),
        attr('URI', key.uri, true),
        attr('IV', key.iv, false),
        attr('KEYFORMAT', key.keyFormat, true),
        attr('KEYFORMATVERSIONS', key.keyFormatVersions, true),
    ];
    return `#EXT-X-KEY:${formatAttributeList(
        mergeAttributes(getAttributeSource(key), modeled, KEY_ATTRS)
    )}`;
}

function formatMap(map: HlsMap): string {
    const modeled: (HlsAttribute | undefined)[] = [
        attr('URI', map.uri, true),
        attr(
            'BYTERANGE',
            map.byteRange ? formatByteRange(map.byteRange) : undefined,
            true
        ),
    ];
    return `#EXT-X-MAP:${formatAttributeList(
        mergeAttributes(getAttributeSource(map), modeled, MAP_ATTRS)
    )}`;
}

function pick<K extends string>(
    attrs: HlsAttribute[],
    name: string,
    key: K
): Partial<Record<K, string>> {
    const found = attrs.find((a) => a.name === name);
    if (!found || found.bare) return {};
    return { [key]: found.value } as Record<K, string>;
}
