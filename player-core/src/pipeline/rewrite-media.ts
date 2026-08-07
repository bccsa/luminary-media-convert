/**
 * Media-playlist rewriting.
 *
 * A munged playlist is served from a blob (or whatever the {@link ServeStrategy}
 * provides), so relative references in it have no meaningful base any more —
 * every URI is absolutized against the playlist's ORIGINAL URL first. The key
 * policy is applied in the same pass.
 *
 * The rewrite runs on the lossless model: parse, edit the URIs the model owns,
 * build. Everything else — byte ranges, `#EXTINF` spelling, unknown tags,
 * unknown attributes, attribute order — comes back out exactly as it went in.
 */
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    buildMediaPlaylist,
    getMediaPlaylistLayout,
    parseMediaPlaylist,
    setMediaPlaylistLayout,
} from '@luminary-media-converter/hls';
import { absolutize } from './playlist-text.js';

export { LUMINARY_KEY_PLACEHOLDER_URI };

export interface RewriteMediaOptions {
    /** Absolute URL the playlist was fetched from — the base for every URI. */
    playlistUrl: string;
    /**
     * Replacement URI for `METHOD=AES-128` keys. `LUMINARY_KEY_PLACEHOLDER_URI`
     * for `keyDelivery: 'memory'` adapters (which answer the sentinel from key
     * bytes they hold), a served key URL for `keyDelivery: 'url'` adapters.
     * `undefined` leaves key lines untouched.
     */
    keyUri?: string;
    /**
     * Absolute segment URL → replacement URL. Used to swap decrypted WebVTT
     * segments of a SUBTITLES playlist for served plaintext copies (the engine
     * fetches those itself and cannot decrypt LMCENC).
     */
    segmentReplacements?: ReadonlyMap<string, string>;
}

/**
 * Rewrite one media playlist.
 *
 * - `#EXT-X-KEY` with `METHOD=NONE` → untouched.
 * - `#EXT-X-KEY` with any other method → `URI` normalized to `keyUri`
 *   (the supplied session key wins over whatever the playlist names);
 *   `IV=` and every other attribute untouched.
 * - `#EXT-X-MAP:URI` and every other `URI="…"` attribute → absolutized.
 * - Segment URIs → absolutized (or replaced from `segmentReplacements`).
 * - `#EXT-X-BYTERANGE` → untouched: the offsets address ciphertext in the
 *   packed file and must not be recomputed.
 */
export function rewriteMediaPlaylist(
    text: string,
    options: RewriteMediaOptions,
): string {
    const playlist = parseMediaPlaylist(text);

    if (options.keyUri) {
        for (const key of playlist.keys) {
            if (key.method === 'NONE') continue;
            key.uri = options.keyUri;
        }
    }

    for (const map of playlist.maps) {
        map.uri = absolutize(map.uri, options.playlistUrl);
    }

    for (const segment of playlist.segments) {
        segment.uri = rewriteSegmentUri(segment.uri, options);
    }

    // Lines outside the model keep the old line-level treatment, so a tag this
    // package has never modeled still gets its URIs absolutized.
    const layout = getMediaPlaylistLayout(playlist);
    if (layout) {
        setMediaPlaylistLayout(
            playlist,
            layout.map((item) =>
                typeof item === 'string' ? rewriteRawLine(item, options) : item,
            ),
        );
    }

    return buildMediaPlaylist(playlist);
}

function rewriteSegmentUri(uri: string, options: RewriteMediaOptions): string {
    const absolute = absolutize(uri, options.playlistUrl);
    return options.segmentReplacements?.get(absolute) ?? absolute;
}

function rewriteRawLine(line: string, options: RewriteMediaOptions): string {
    if (!line) return line;
    if (!line.startsWith('#')) return rewriteSegmentUri(line, options);
    // A key line the model could not read is left exactly as found: its URI is
    // a key URI, and the key policy above is the only thing allowed near those.
    if (line.startsWith('#EXT-X-KEY:')) return line;
    if (!line.includes('URI="')) return line;
    return line.replace(
        /URI="([^"]*)"/g,
        (_match, uri: string) =>
            `URI="${absolutize(uri, options.playlistUrl)}"`,
    );
}
