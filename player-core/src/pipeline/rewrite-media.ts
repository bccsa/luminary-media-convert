/**
 * Media-playlist rewriting.
 *
 * A munged playlist is served from a blob (or whatever the {@link ServeStrategy}
 * provides), so relative references in it have no meaningful base any more —
 * every URI is absolutized against the playlist's ORIGINAL URL first. The key
 * policy is applied in the same pass.
 *
 * ### Why this is string work rather than a model round-trip
 *
 * It used to parse into `hls-core`'s lossless model, edit three fields and
 * build. The model earns its keep where a playlist is genuinely restructured —
 * the master munge narrows angles and caps quality — but the media rewrite
 * makes exactly three edits, all of them to text: substitute a key URI,
 * absolutize a `URI="…"` attribute, absolutize a segment line. Doing that
 * directly is not a shortcut, it is strictly MORE preserving: a line this pass
 * does not recognise is not reformatted from a model, it is not touched at all,
 * so attribute order in a tag nothing here cares about survives exactly as
 * written. The old implementation already conceded the point, keeping a textual
 * fallback for every tag the model did not represent.
 *
 * It also has to be text. This is the only rewrite on the per-request path for
 * live, where a native asset resolver re-fetches, re-decrypts and re-applies it
 * every target-duration while JavaScript may be frozen — so it is ported to
 * Swift and Kotlin, and two string edits port in a way a 468-line lossless
 * parser does not. One implementation of the rule, three languages, the same
 * fixtures. `docs/suspension-safe-playback.md` has the boundary in prose.
 */
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/hls-core';
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

const KEY_TAG = '#EXT-X-KEY:';

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
 * - Everything else → reproduced exactly, because nothing here reads it.
 */
export function rewriteMediaPlaylist(
    text: string,
    options: RewriteMediaOptions,
): string {
    return text
        .split('\n')
        .map((line) => rewriteLine(line, options))
        .join('\n');
}

function rewriteLine(line: string, options: RewriteMediaOptions): string {
    // Playlists written on Windows arrive CRLF; the carriage return is part of
    // the separator, not of the URI, and has to be put back afterwards.
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    const rewritten = rewriteBody(body, options);
    return cr ? `${rewritten}\r` : rewritten;
}

function rewriteBody(line: string, options: RewriteMediaOptions): string {
    if (!line) return line;
    if (!line.startsWith('#')) return rewriteSegmentUri(line, options);
    if (line.startsWith(KEY_TAG)) return rewriteKeyLine(line, options);
    if (!line.includes('URI="')) return line;
    return line.replace(
        /URI="([^"]*)"/g,
        (_match, uri: string) =>
            `URI="${absolutize(uri, options.playlistUrl)}"`,
    );
}

/**
 * The key line is the one place a URI is replaced outright rather than
 * resolved: a locally supplied session key wins over whatever the playlist
 * names, which is the whole point of `luminary://key`. Every other attribute —
 * `IV`, `KEYFORMAT`, `KEYFORMATVERSIONS` — is left exactly as found.
 */
function rewriteKeyLine(line: string, options: RewriteMediaOptions): string {
    const { keyUri } = options;
    if (!keyUri) return line;

    const attrs = line.slice(KEY_TAG.length);
    // `METHOD=NONE` declares the segments after it are NOT encrypted. Pointing
    // a key at it would claim the opposite.
    if (/(?:^|,)\s*METHOD=NONE(?:,|$)/.test(attrs)) return line;

    if (/URI="[^"]*"/.test(line)) {
        return line.replace(/URI="[^"]*"/, `URI="${keyUri}"`);
    }
    // A non-NONE key with no URI at all is malformed HLS — the attribute is
    // required — but the key it is missing is exactly the one being supplied,
    // so completing the line is more useful than passing the fault through.
    return `${line},URI="${keyUri}"`;
}

function rewriteSegmentUri(uri: string, options: RewriteMediaOptions): string {
    const absolute = absolutize(uri, options.playlistUrl);
    return options.segmentReplacements?.get(absolute) ?? absolute;
}
