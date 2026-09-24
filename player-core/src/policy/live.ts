/**
 * Liveness: telling a finished encode from a stream still being written, and
 * describing the latter in terms a native asset resolver can act on alone.
 *
 * Everything else in this package assumes a media playlist is read once. That
 * is true of VOD and is why the VOD path is suspension-safe at all: the wrapper
 * munges at load, hands the finished text to whatever serves it, and JavaScript
 * is off the request path for the rest of playback. A live playlist breaks the
 * assumption at its root — the segment list changes every target-duration, so
 * something must keep re-fetching, re-decrypting and re-rewriting it for as
 * long as the stream runs.
 *
 * That "something" cannot be this package. On a locked phone the WebView is
 * frozen while the native player keeps pulling segments, so a refresh that
 * needs JavaScript is a refresh that does not happen. It has to be the serving
 * layer, natively, which is why {@link LivePlaylistSpec} is plain data: URLs,
 * a key, a cadence. Hand that across a bridge and the resolver can do the whole
 * job — fetch, sniff, decrypt, rewrite, serve — without waking anyone.
 *
 * Nothing in this repository produces live output (`-hls_playlist_type vod`
 * writes the playlist only at the end, which is why coming-soon polling
 * exists); the sources are third-party live streams. {@link resolveLivePlaylist}
 * is the per-request step every serving layer performs, and
 * `player-web-legacy`'s `BlobServeStrategy` is the first to implement
 * `serveLive` on top of it.
 */

import { parseMediaPlaylist } from '@luminary-media-converter/hls-core';
import { bytesToHex, type SubtleLike } from '../pipeline/decrypt.js';
import { PipelineError, fetchMaybeEncrypted } from '../pipeline/fetch.js';
import { hasAes128Key } from '../pipeline/playlist-text.js';
import { rewriteMediaPlaylist } from '../pipeline/rewrite-media.js';

/** What a media playlist says about whether it is finished. */
export interface Liveness {
    /**
     * True when the playlist has not declared itself complete, and therefore
     * has to be re-read for as long as it is played.
     *
     * Decided on `#EXT-X-ENDLIST` alone. `#EXT-X-PLAYLIST-TYPE` is an
     * intention, and an unfinished playlist calling itself VOD is a writer
     * mid-flight rather than a promise anyone should act on; the tag that
     * actually means "there will be no more segments" is the one to read.
     */
    isLive: boolean;
    /**
     * `#EXT-X-TARGETDURATION` — the interval a client is expected to re-read a
     * live playlist at. 0 when the playlist does not declare one.
     */
    targetDurationSec: number;
    /** `#EXT-X-MEDIA-SEQUENCE` of the first segment listed. 0 when absent. */
    mediaSequence: number;
}

export function describeLiveness(playlistText: string): Liveness {
    const playlist = parseMediaPlaylist(playlistText);
    return {
        isLive: !playlist.endList,
        targetDurationSec: playlist.targetDuration ?? 0,
        mediaSequence: playlist.mediaSequence ?? 0,
    };
}

/**
 * Everything a serving layer needs to keep one live media playlist fresh, with
 * nothing in it that has to be called back for.
 *
 * Deliberately plain data — no callbacks, no closures, no object identities —
 * so it serializes across a native bridge unchanged, exactly as
 * `ChunkBoundary[][]` does for chunk warming. A resolver holding one of these
 * performs, per engine request:
 *
 * ```
 * fetch(url) → if (isEncryptedPayload) decryptLmcenc(keyBytes) → rewrite → serve
 * ```
 *
 * The rewrite is the same two edits `rewriteMediaPlaylist` makes — substitute
 * `keyUri`, absolutize against `baseUrl` — which is why that function is string
 * work: this is the path it has to be ported for.
 *
 * LMCENC is sniffed rather than assumed. Detection is by magic prefix, never by
 * absence-sniffing, so a plaintext third-party playlist costs one eight-byte
 * comparison and passes through untouched, while a Luminary-wrapped one
 * decrypts — one code path, and no need to pin down in advance who produces the
 * stream. Standard AES-128 with a real, fetchable `keyUrl` needs no resolver
 * involvement at all: the engine fetches those itself.
 */
export interface LivePlaylistSpec {
    /** Absolute URL of the live media playlist, re-read on every engine request. */
    url: string;
    /** Base every relative URI in it resolves against — normally `url` itself. */
    baseUrl: string;
    /**
     * What every AES-128 `URI="…"` is rewritten to. The sentinel
     * `luminary://key` for an adapter answering key requests from memory, a
     * served key URL otherwise.
     *
     * Absent exactly when there is no session key. Key lines are then left as
     * written, and an AES-128 key turning up is a `key-required` failure — the
     * rule the load applied to the first read, applied to every read after it,
     * since a live stream can start encrypting part-way through.
     */
    keyUri?: string;
    /**
     * The session key, for LMCENC. Absent means the resolver should expect
     * plaintext and pass an encrypted payload through as the error it is.
     */
    keyBytes?: Uint8Array;
    /** Re-read interval in seconds, from `#EXT-X-TARGETDURATION`. */
    refreshSec: number;
}

export interface ResolveLiveOptions {
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    /** Injectable for tests; defaults to `globalThis.crypto.subtle`. */
    subtle?: SubtleLike;
}

/**
 * One read of a live media playlist, served-ready: fetch `spec.url`, decrypt
 * it when it is LMCENC, apply the media rewrite. Call it once per engine
 * request for the URL `serveLive(spec)` returned.
 *
 * Deliberately one read and not a loop. The engine already re-requests a live
 * playlist on the cadence HLS prescribes — every target duration, half that
 * when a read found nothing new — and answering those requests is the whole
 * job; a timer of our own beside it would only race the engine's. `refreshSec`
 * is for a serving layer that has to pre-fetch because it cannot answer a
 * request asynchronously.
 *
 * Failures are {@link PipelineError}s carrying the upstream HTTP `status` when
 * there was one, so a caller can hand the engine the status a direct request
 * would have met and let the engine's own retry policy handle it.
 *
 * This is the reference a native resolver ports: the same three steps, in the
 * same order, with the same failures.
 */
export async function resolveLivePlaylist(
    spec: LivePlaylistSpec,
    options: ResolveLiveOptions,
): Promise<string> {
    const asset = await fetchMaybeEncrypted(spec.url, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        subtle: options.subtle,
        keyHex: spec.keyBytes ? bytesToHex(spec.keyBytes) : undefined,
        expect: 'playlist',
    });
    if (!spec.keyUri && hasAes128Key(asset.text)) {
        throw new PipelineError(
            'key-required',
            `${spec.url} declares AES-128 segments but no session key was supplied`,
            { url: spec.url },
        );
    }
    return rewriteMediaPlaylist(asset.text, {
        playlistUrl: spec.baseUrl,
        keyUri: spec.keyUri,
    });
}
