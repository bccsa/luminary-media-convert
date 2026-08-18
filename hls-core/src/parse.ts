import {
    parseAttributeList,
    type HlsAttribute,
} from './attributes.js';
import {
    getLayout,
    setAttributeSource,
    setHeaderOrder,
    setLayout,
} from './metadata.js';

/** Structured form of a `RESOLUTION=<width>x<height>` attribute. */
export interface HlsResolution {
    width: number;
    height: number;
}

export interface HlsVariant {
    bandwidth: number;
    /** `AVERAGE-BANDWIDTH`, when the source states one. */
    averageBandwidth?: number;
    /** Raw `RESOLUTION` text, e.g. `'1280x720'`. */
    resolution?: string;
    /** `resolution` split into numbers — quality logic wants `height` directly. */
    resolutionParsed?: HlsResolution;
    /** `FRAME-RATE`, when the source states one. */
    frameRate?: number;
    codecs?: string;
    /** `VIDEO="…"` — the camera angle (video rendition group) this variant belongs to. */
    videoGroup?: string;
    /** `AUDIO="…"` — the audio rendition group this variant pairs with. */
    audioGroup?: string;
    /** `SUBTITLES="…"` — the subtitle rendition group this variant pairs with. */
    subtitlesGroup?: string;
    uri: string;
}

export interface HlsMedia {
    type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
    groupId: string;
    name: string;
    language?: string;
    uri?: string;
    /** `true` for `DEFAULT=YES`, `false` for an explicit `DEFAULT=NO`, absent otherwise. */
    default?: boolean;
    autoselect?: boolean;
    forced?: boolean;
}

/** An `#EXT-X-I-FRAME-STREAM-INF` entry (its URI is an attribute, not a line). */
export interface HlsIFrameStream {
    bandwidth: number;
    averageBandwidth?: number;
    resolution?: string;
    resolutionParsed?: HlsResolution;
    codecs?: string;
    videoGroup?: string;
    uri: string;
}

/**
 * One position in a master playlist: either a modeled entry (by identity — the
 * very object stored in `media` / `variants` / `iFrameStreams`) or a raw line
 * the model does not cover.
 */
export type HlsMasterLayoutItem =
    | string
    | HlsMedia
    | HlsVariant
    | HlsIFrameStream;

export interface HlsParsedMaster {
    variants: HlsVariant[];
    /** All `#EXT-X-MEDIA` entries (video, audio, subtitles, closed-captions). */
    media: HlsMedia[];
    /** Audio-only subset — equivalent to `media.filter(m => m.type === 'AUDIO')`. */
    audioGroups: HlsMedia[];
    /** Video-only subset (the camera angles) — `media.filter(m => m.type === 'VIDEO')`. */
    videoGroups: HlsMedia[];
    /** `#EXT-X-VERSION`, when present. */
    version?: number;
    /** `#EXT-X-INDEPENDENT-SEGMENTS` was present. */
    independentSegments?: boolean;
    /** `#EXT-X-I-FRAME-STREAM-INF` entries, only when the source had any. */
    iFrameStreams?: HlsIFrameStream[];
}

const VARIANT_ATTRS = [
    'BANDWIDTH',
    'AVERAGE-BANDWIDTH',
    'RESOLUTION',
    'FRAME-RATE',
    'CODECS',
    'VIDEO',
    'AUDIO',
    'SUBTITLES',
];

const MEDIA_ATTRS = [
    'TYPE',
    'GROUP-ID',
    'NAME',
    'LANGUAGE',
    'DEFAULT',
    'AUTOSELECT',
    'FORCED',
    'URI',
];

const IFRAME_ATTRS = [
    'BANDWIDTH',
    'AVERAGE-BANDWIDTH',
    'RESOLUTION',
    'CODECS',
    'VIDEO',
    'URI',
];

/** Attribute names the variant model can express — see `mergeAttributes`. */
export const VARIANT_MODELED_ATTRS = VARIANT_ATTRS;
/** Attribute names the media model can express. */
export const MEDIA_MODELED_ATTRS = MEDIA_ATTRS;
/** Attribute names the I-frame stream model can express. */
export const IFRAME_MODELED_ATTRS = IFRAME_ATTRS;

const MEDIA_TYPES = new Set(['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']);

/**
 * Parse a master playlist.
 *
 * The model is lossless: every line either becomes a modeled entry or is kept
 * verbatim in the playlist's layout (see {@link getMasterLayout}), so
 * `buildMasterPlaylist(parseMasterPlaylist(text))` reproduces `text` — modulo
 * blank lines, leading/trailing whitespace, and a `LANGUAGE` case fold.
 */
export function parseMasterPlaylist(content: string): HlsParsedMaster {
    const lines = content.split('\n').map((l) => l.trim());

    const variants: HlsVariant[] = [];
    const media: HlsMedia[] = [];
    const iFrameStreams: HlsIFrameStream[] = [];
    const layout: HlsMasterLayoutItem[] = [];
    const headerOrder: string[] = [];

    let version: number | undefined;
    let independentSegments = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === '' || line === '#EXTM3U') continue;

        if (line.startsWith('#EXT-X-VERSION:')) {
            const parsed = Number(line.slice('#EXT-X-VERSION:'.length).trim());
            if (Number.isFinite(parsed)) {
                version = parsed;
                headerOrder.push('#EXT-X-VERSION');
                continue;
            }
            layout.push(line);
            continue;
        }

        if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
            independentSegments = true;
            headerOrder.push('#EXT-X-INDEPENDENT-SEGMENTS');
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA:')) {
            const attrs = parseAttributeList(
                line.slice('#EXT-X-MEDIA:'.length)
            );
            const entry = buildMediaEntry(attrs);
            if (!entry) {
                // Unknown TYPE — keep the line rather than silently dropping it.
                layout.push(line);
                continue;
            }
            media.push(entry);
            layout.push(entry);
            continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            // The URI is the next line, skipping blanks only. Scanning past a
            // tag would let a URI-less STREAM-INF steal the following
            // variant's URI, which is how this parser used to misread a
            // truncated playlist.
            let j = i + 1;
            while (j < lines.length && lines[j] === '') j++;
            const uri =
                j < lines.length && !lines[j].startsWith('#')
                    ? lines[j]
                    : undefined;

            const attrs = parseAttributeList(
                line.slice('#EXT-X-STREAM-INF:'.length)
            );
            const variant = uri ? buildVariant(attrs, uri) : undefined;

            if (!variant) {
                layout.push(line);
                continue;
            }

            variants.push(variant);
            layout.push(variant);
            i = j;
            continue;
        }

        if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
            const attrs = parseAttributeList(
                line.slice('#EXT-X-I-FRAME-STREAM-INF:'.length)
            );
            const entry = buildIFrameStream(attrs);
            if (!entry) {
                layout.push(line);
                continue;
            }
            iFrameStreams.push(entry);
            layout.push(entry);
            continue;
        }

        layout.push(line);
    }

    const master: HlsParsedMaster = {
        variants,
        media,
        audioGroups: media.filter((m) => m.type === 'AUDIO'),
        videoGroups: media.filter((m) => m.type === 'VIDEO'),
        ...(version !== undefined ? { version } : {}),
        ...(independentSegments ? { independentSegments: true } : {}),
        ...(iFrameStreams.length > 0 ? { iFrameStreams } : {}),
    };

    setLayout(master, layout);
    setHeaderOrder(master, headerOrder);
    return master;
}

/**
 * The playlist's line order, including any lines the model does not represent.
 *
 * Entries are the same objects held in `media` / `variants` / `iFrameStreams`,
 * so removing one from those arrays removes it from the output too, and adding
 * one appends it. Returns `undefined` for a model that was not parsed from
 * text — the builder then falls back to a canonical layout.
 */
export function getMasterLayout(
    master: HlsParsedMaster
): HlsMasterLayoutItem[] | undefined {
    return getLayout(master) as HlsMasterLayoutItem[] | undefined;
}

/** Fix the line order of a master assembled in code (see {@link getMasterLayout}). */
export function setMasterLayout(
    master: HlsParsedMaster,
    items: readonly HlsMasterLayoutItem[]
): void {
    setLayout(master, items);
}

function buildMediaEntry(attrs: HlsAttribute[]): HlsMedia | undefined {
    const type = plain(attrs, 'TYPE');
    if (!type || !MEDIA_TYPES.has(type)) return undefined;

    const language = quoted(attrs, 'LANGUAGE');
    const uri = quoted(attrs, 'URI');

    const entry: HlsMedia = {
        type: type as HlsMedia['type'],
        groupId: quoted(attrs, 'GROUP-ID') ?? '',
        name: quoted(attrs, 'NAME') ?? '',
        ...(language ? { language } : {}),
        ...(uri ? { uri } : {}),
        ...flag(attrs, 'DEFAULT', 'default'),
        ...flag(attrs, 'AUTOSELECT', 'autoselect'),
        ...flag(attrs, 'FORCED', 'forced'),
    };
    setAttributeSource(entry, attrs);
    return entry;
}

function buildVariant(
    attrs: HlsAttribute[],
    uri: string
): HlsVariant | undefined {
    const bandwidth = numeric(attrs, 'BANDWIDTH');
    if (bandwidth === undefined) return undefined;

    const resolution = plain(attrs, 'RESOLUTION');
    const codecs = quoted(attrs, 'CODECS');
    const averageBandwidth = numeric(attrs, 'AVERAGE-BANDWIDTH');
    const frameRate = numeric(attrs, 'FRAME-RATE');
    const videoGroup = quoted(attrs, 'VIDEO');
    const audioGroup = quoted(attrs, 'AUDIO');
    const subtitlesGroup = quoted(attrs, 'SUBTITLES');
    const resolutionParsed = resolution
        ? parseResolution(resolution)
        : undefined;

    const variant: HlsVariant = {
        bandwidth,
        ...(averageBandwidth !== undefined ? { averageBandwidth } : {}),
        ...(resolution ? { resolution } : {}),
        ...(resolutionParsed ? { resolutionParsed } : {}),
        ...(frameRate !== undefined ? { frameRate } : {}),
        ...(codecs ? { codecs } : {}),
        ...(videoGroup ? { videoGroup } : {}),
        ...(audioGroup ? { audioGroup } : {}),
        ...(subtitlesGroup ? { subtitlesGroup } : {}),
        uri,
    };
    setAttributeSource(variant, attrs);
    return variant;
}

function buildIFrameStream(attrs: HlsAttribute[]): HlsIFrameStream | undefined {
    const bandwidth = numeric(attrs, 'BANDWIDTH');
    const uri = quoted(attrs, 'URI');
    if (bandwidth === undefined || !uri) return undefined;

    const resolution = plain(attrs, 'RESOLUTION');
    const averageBandwidth = numeric(attrs, 'AVERAGE-BANDWIDTH');
    const codecs = quoted(attrs, 'CODECS');
    const videoGroup = quoted(attrs, 'VIDEO');
    const resolutionParsed = resolution
        ? parseResolution(resolution)
        : undefined;

    const entry: HlsIFrameStream = {
        bandwidth,
        ...(averageBandwidth !== undefined ? { averageBandwidth } : {}),
        ...(resolution ? { resolution } : {}),
        ...(resolutionParsed ? { resolutionParsed } : {}),
        ...(codecs ? { codecs } : {}),
        ...(videoGroup ? { videoGroup } : {}),
        uri,
    };
    setAttributeSource(entry, attrs);
    return entry;
}

/** `'1280x720'` → `{ width: 1280, height: 720 }`; `undefined` when malformed. */
export function parseResolution(raw: string): HlsResolution | undefined {
    const match = raw.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (!match) return undefined;
    return { width: Number(match[1]), height: Number(match[2]) };
}

/** `{ width, height }` → `'1280x720'`. */
export function formatResolution(res: HlsResolution): string {
    return `${res.width}x${res.height}`;
}

function find(attrs: HlsAttribute[], name: string): HlsAttribute | undefined {
    return attrs.find((a) => a.name === name);
}

function quoted(attrs: HlsAttribute[], name: string): string | undefined {
    const a = find(attrs, name);
    return a && a.quoted ? a.value : undefined;
}

function plain(attrs: HlsAttribute[], name: string): string | undefined {
    const a = find(attrs, name);
    return a && !a.quoted && !a.bare ? a.value : undefined;
}

function numeric(attrs: HlsAttribute[], name: string): number | undefined {
    const raw = plain(attrs, name);
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function flag<K extends string>(
    attrs: HlsAttribute[],
    name: string,
    key: K
): Partial<Record<K, boolean>> {
    const raw = plain(attrs, name);
    if (raw === 'YES') return { [key]: true } as Record<K, boolean>;
    if (raw === 'NO') return { [key]: false } as Record<K, boolean>;
    return {};
}
