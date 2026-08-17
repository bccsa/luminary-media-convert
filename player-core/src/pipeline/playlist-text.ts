/**
 * Playlist introspection for the munging pipeline.
 *
 * Every function here is a pure view over the lossless model in
 * `@luminary-media-converter/hls`: parse → inspect (or edit the model) →
 * build. Nothing in this package reads a playlist line by line any more, so
 * unknown tags, unknown attributes, attribute order and the exact numeric
 * spelling of a duration all survive a munge untouched.
 *
 * The entry types below are a narrow projection of the model, shaped for what
 * the pipeline actually asks: `height` rather than `resolutionParsed`,
 * `undefined` rather than `''` for absent text, and rendition groups keyed by
 * the attribute that names them. Each projection keeps a reference to the model
 * object it came from — that reference is what lets {@link filterMasterText}
 * and {@link substituteMasterRefs} edit and rebuild losslessly.
 */

import {
    buildMasterPlaylist,
    parseMasterPlaylist,
    parseMediaPlaylist,
    type HlsMedia,
    type HlsParsedMaster,
    type HlsVariant,
} from '@luminary-media-converter/hls';

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * `NAME="value"` → `value`.
 *
 * For tag lines the model does not represent (see `rewrite-media.ts`); modeled
 * tags are read off the model instead.
 */
export function quotedAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}="([^"]*)"`));
    return match?.[1];
}

/** `NAME=VALUE` (unquoted) → `VALUE`. See {@link quotedAttr}. */
export function plainAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}=([^",]+)`));
    return match?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// Master playlist
// ---------------------------------------------------------------------------

/** Rendition-group attribute names a variant can reference media through. */
export const GROUP_ATTRS = [
    'AUDIO',
    'VIDEO',
    'SUBTITLES',
    'CLOSED-CAPTIONS',
] as const;

export type GroupAttr = (typeof GROUP_ATTRS)[number];

/**
 * The rendition-group attributes the model surfaces on a variant.
 *
 * `CLOSED-CAPTIONS` is deliberately absent: the model carries it through a
 * round-trip verbatim but does not expose it, so group garbage collection must
 * not judge — and therefore can never orphan — a `TYPE=CLOSED-CAPTIONS` entry.
 */
export const MODELED_GROUP_ATTRS: readonly GroupAttr[] = [
    'VIDEO',
    'AUDIO',
    'SUBTITLES',
];

export interface MasterMediaEntry {
    /** The model entry this projects — the object the editors mutate. */
    readonly entry: HlsMedia;
    /** `TYPE` — AUDIO / VIDEO / SUBTITLES / CLOSED-CAPTIONS. */
    type: string;
    groupId?: string;
    /** `URI` attribute; absent for CLOSED-CAPTIONS and muxed audio. */
    uri?: string;
    name?: string;
    language?: string;
    isDefault: boolean;
}

export interface MasterVariantEntry {
    /** The model entry this projects — the object the editors mutate. */
    readonly variant: HlsVariant;
    /** The URI line that follows the `#EXT-X-STREAM-INF`. */
    uri: string;
    bandwidth: number;
    width?: number;
    height?: number;
    /** Rendition groups referenced by this variant, keyed by attribute name. */
    groups: Partial<Record<GroupAttr, string>>;
}

export interface ParsedMasterText {
    /** The lossless model everything below projects. */
    master: HlsParsedMaster;
    media: MasterMediaEntry[];
    variants: MasterVariantEntry[];
}

/**
 * True when `text` is a MASTER playlist.
 *
 * Decided on the parsed model, not on a substring: a media playlist that merely
 * mentions `#EXT-X-STREAM-INF` inside a `URI="…"` or a comment carries no
 * variant, media or I-frame entry and is correctly rejected.
 */
export function isMasterPlaylistText(text: string): boolean {
    const master = parseMasterPlaylist(text);
    return (
        master.variants.length > 0 ||
        master.media.length > 0 ||
        (master.iFrameStreams?.length ?? 0) > 0
    );
}

export function parseMasterText(text: string): ParsedMasterText {
    const master = parseMasterPlaylist(text);
    return {
        master,
        media: master.media.map(toMediaEntry),
        variants: master.variants.map(toVariantEntry),
    };
}

/**
 * Rebuild a master's text keeping only the variants / media entries the
 * predicates accept. Every other line — version tags, comments, unknown tags,
 * unknown attributes, attribute order — is reproduced verbatim by the model's
 * recorded layout.
 *
 * Edits `parsed.master` in place: the recorded line order lives beside that
 * object, so rebuilding from a copy would fall back to a canonical layout.
 * Callers own their `ParsedMasterText` and discard it afterwards.
 */
export function filterMasterText(
    parsed: ParsedMasterText,
    keep: {
        variant?: (variant: MasterVariantEntry) => boolean;
        media?: (media: MasterMediaEntry) => boolean;
    },
): string {
    const { master } = parsed;
    const keepVariant = keep.variant;
    const keepMedia = keep.media;

    if (keepVariant) {
        master.variants = parsed.variants
            .filter(keepVariant)
            .map((v) => v.variant);
    }
    if (keepMedia) {
        master.media = parsed.media.filter(keepMedia).map((m) => m.entry);
        master.audioGroups = master.media.filter((m) => m.type === 'AUDIO');
        master.videoGroups = master.media.filter((m) => m.type === 'VIDEO');
    }

    return buildMasterPlaylist(master);
}

/** A playlist URI referenced by a master. */
export interface MasterRef {
    /** The URI exactly as written in the playlist. */
    uri: string;
    kind: 'variant' | 'media';
    /** `TYPE` of the media entry, for `kind: 'media'`. */
    mediaType?: string;
}

/** Every sub-playlist a master points at: variant URIs plus media `URI=`. */
export function collectMasterRefs(text: string): MasterRef[] {
    const master = parseMasterPlaylist(text);
    const refs: MasterRef[] = [];
    const seen = new Set<string>();

    for (const variant of master.variants) {
        if (seen.has(variant.uri)) continue;
        seen.add(variant.uri);
        refs.push({ uri: variant.uri, kind: 'variant' });
    }
    for (const entry of master.media) {
        if (!entry.uri || seen.has(entry.uri)) continue;
        seen.add(entry.uri);
        refs.push({ uri: entry.uri, kind: 'media', mediaType: entry.type });
    }

    return refs;
}

/**
 * Swap every sub-playlist reference in a master for its replacement URL.
 * Keys of `replacements` are URIs exactly as `collectMasterRefs` reported them.
 */
export function substituteMasterRefs(
    text: string,
    replacements: ReadonlyMap<string, string>,
): string {
    const master = parseMasterPlaylist(text);

    for (const variant of master.variants) {
        const replacement = replacements.get(variant.uri);
        if (replacement) variant.uri = replacement;
    }
    for (const entry of master.media) {
        if (!entry.uri) continue;
        const replacement = replacements.get(entry.uri);
        if (replacement) entry.uri = replacement;
    }

    return buildMasterPlaylist(master);
}

/** True when the master (or any playlist) declares at least one video variant. */
export function hasVideoVariants(text: string): boolean {
    const master = parseMasterPlaylist(text);
    if (master.videoGroups.length > 0) return true;
    return master.variants.some(
        (v) => v.resolutionParsed !== undefined || v.videoGroup !== undefined,
    );
}

// ---------------------------------------------------------------------------
// Media playlist
// ---------------------------------------------------------------------------

/** True when a media playlist declares an AES-128 key (i.e. `METHOD` ≠ NONE). */
export function hasAes128Key(text: string): boolean {
    return parseMediaPlaylist(text).keys.some((key) => key.method !== 'NONE');
}

/** Every segment URI of a media playlist, exactly as written. */
export function listSegmentUris(text: string): string[] {
    return parseMediaPlaylist(text).segments.map((segment) => segment.uri);
}

// ---------------------------------------------------------------------------
// URI utilities
// ---------------------------------------------------------------------------

/**
 * Resolve `uri` against `base` with the URL parser.
 *
 * This is the fix for the old pipeline's `endsWith('.m3u8')` /
 * `startsWith('http')` string sniffing: query strings, fragments, protocol-
 * relative URIs and absolute paths all resolve correctly, and already-absolute
 * URIs come back unchanged.
 */
export function absolutize(uri: string, base: string): string {
    if (!uri) return uri;
    if (/^(?:blob|data):/i.test(uri)) return uri;
    try {
        return new URL(uri, base).href;
    } catch {
        // `base` was itself relative — a same-origin app hands over
        // `/api/sessions/…/playlist.m3u8` with no scheme or host, and `new URL`
        // refuses a relative base. Anchoring it to the document turns it into
        // the absolute URL it was always meant to be. Left as-is, a rendition
        // reference like `r0/playlist.m3u8` came back unchanged, the browser
        // resolved it against the *page*, and the app's SPA fallback answered
        // with index.html where a playlist should be.
        if (typeof document !== 'undefined' && document.baseURI) {
            try {
                return new URL(uri, new URL(base, document.baseURI)).href;
            } catch {
                /* fall through */
            }
        }
        return uri;
    }
}

/** Replace the `URI="…"` attribute of a tag line the model does not model. */
export function replaceUriAttr(line: string, uri: string): string {
    return line.replace(/URI="[^"]*"/, `URI="${uri}"`);
}

// ---------------------------------------------------------------------------
// Model → projection
// ---------------------------------------------------------------------------

function toMediaEntry(entry: HlsMedia): MasterMediaEntry {
    return {
        entry,
        type: entry.type,
        groupId: entry.groupId || undefined,
        uri: entry.uri || undefined,
        name: entry.name || undefined,
        language: entry.language || undefined,
        isDefault: entry.default === true,
    };
}

function toVariantEntry(variant: HlsVariant): MasterVariantEntry {
    const groups: Partial<Record<GroupAttr, string>> = {};
    if (variant.videoGroup) groups.VIDEO = variant.videoGroup;
    if (variant.audioGroup) groups.AUDIO = variant.audioGroup;
    if (variant.subtitlesGroup) groups.SUBTITLES = variant.subtitlesGroup;

    return {
        variant,
        uri: variant.uri,
        bandwidth: variant.bandwidth,
        width: variant.resolutionParsed?.width,
        height: variant.resolutionParsed?.height,
        groups,
    };
}
