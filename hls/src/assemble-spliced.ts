/**
 * Programmatic assembly of a spliced media playlist — the smart-cut output
 * shape: parts joined by `#EXT-X-DISCONTINUITY`, each part optionally opening
 * with its own `#EXT-X-MAP` (a re-encoded bridge carries its own init; a
 * copy-split part continues the previous one's).
 *
 * The builder's no-layout fallback emits all MAPs first, then all segments —
 * structurally wrong for a spliced playlist — so assembly here always records
 * an explicit layout. Every map and segment is a fresh object: the builder
 * emits modeled entries once by identity, so a shared object would collapse
 * two positions into one.
 */

import {
    buildMediaPlaylist,
    setMediaPlaylistLayout,
    type HlsMap,
    type HlsMediaLayoutItem,
    type HlsParsedMediaPlaylist,
    type HlsSegment,
} from './media-playlist';
import { setNumericText } from './metadata';

export interface SplicedPartSegment {
    uri: string;
    /** Exact planned duration in seconds — becomes the `#EXTINF` value. */
    duration: number;
}

export interface SplicedPart {
    /**
     * Init segment URI for this part. Omit to continue decoding with the
     * previous part's init (a copy span split only to keep the discontinuity
     * structure uniform across streams).
     */
    mapUri?: string;
    segments: SplicedPartSegment[];
}

export interface AssembleSplicedOptions {
    /** Default 7 — fMP4 media playlists require it. */
    version?: number;
    /** Default 0. */
    mediaSequence?: number;
    /**
     * Default true: every part starts at a keyframe (copy parts are split on
     * keyframes, bridges open with an IDR), which is what the tag asserts.
     */
    independentSegments?: boolean;
}

export function assembleSplicedMediaPlaylist(
    parts: readonly SplicedPart[],
    options: AssembleSplicedOptions = {}
): HlsParsedMediaPlaylist {
    if (parts.length === 0) {
        throw new Error('assembleSplicedMediaPlaylist: no parts');
    }
    for (const [i, part] of parts.entries()) {
        if (part.segments.length === 0) {
            throw new Error(
                `assembleSplicedMediaPlaylist: part ${i} has no segments`
            );
        }
    }

    const maps: HlsMap[] = [];
    const segments: HlsSegment[] = [];
    const layout: HlsMediaLayoutItem[] = [];
    let maxDuration = 0;

    parts.forEach((part, index) => {
        if (index > 0) layout.push('#EXT-X-DISCONTINUITY');
        if (part.mapUri !== undefined) {
            const map: HlsMap = { uri: part.mapUri };
            maps.push(map);
            layout.push(map);
        }
        for (const s of part.segments) {
            const segment: HlsSegment = {
                duration: s.duration,
                title: '',
                uri: s.uri,
            };
            // ffmpeg writes six decimals; authored playlists match so that
            // spliced and muxer-written output are indistinguishable in style.
            setNumericText(segment, 'duration', s.duration.toFixed(6));
            segments.push(segment);
            layout.push(segment);
            if (s.duration > maxDuration) maxDuration = s.duration;
        }
    });

    const playlist: HlsParsedMediaPlaylist = {
        version: options.version ?? 7,
        targetDuration: Math.ceil(maxDuration),
        mediaSequence: options.mediaSequence ?? 0,
        playlistType: 'VOD',
        ...(options.independentSegments !== false
            ? { independentSegments: true }
            : {}),
        maps,
        keys: [],
        segments,
        endList: true,
    };
    setMediaPlaylistLayout(playlist, layout);
    return playlist;
}

/** Convenience: assemble straight to playlist text. */
export function buildSplicedMediaPlaylist(
    parts: readonly SplicedPart[],
    options: AssembleSplicedOptions = {}
): string {
    return buildMediaPlaylist(assembleSplicedMediaPlaylist(parts, options));
}
