/**
 * A longer request timeout for byte-range segments, on the VHS seam.
 *
 * VHS issues every segment request with `timeout = targetDuration × 1.5` —
 * 9 s for the encoder's default 6 s segments — and lifts it (to none at all)
 * only while playing the lowest enabled rendition. On a timeout it takes what
 * its source calls emergency action: the video loader sets its bandwidth
 * estimate to 1 and forces ABR to the lowest rendition; the audio loader
 * raises an error, which the media-groups handler answers by excluding the
 * current video rendition or flipping the audio track back to default. All of
 * it assumes a slow request means insufficient bandwidth *for this rendition*.
 *
 * On byte-range output that assumption is false. Every rendition of an angle
 * shares one chunk chain and every audio group shares another, so the first
 * request into a cold chunk object is slow because the edge is still
 * backhauling the object — and the "switch down" re-requests the same cold
 * object at a different offset, one the backhaul may not have reached. Nine
 * seconds of progress discarded, quality floored, the wait started over, and
 * on the audio chain a rendition lost or a language changed for no reason.
 *
 * So requests carrying a `Range` header — on VHS exactly the byte-range
 * segment requests, since `segmentXhrHeaders` sets it for those and nothing
 * else — get a backstop instead: ten times the target duration, 60 s at the
 * defaults. A genuinely dead request still times out. Init, key and playlist
 * requests carry no `Range` and keep VHS's default, and a request VHS issued
 * with no timeout (the lowest rendition) is left with none. The *loader's* own
 * `xhrOptions_.timeout` is untouched, so `earlyAbortWhenNeeded_` — the
 * bandwidth-estimate driven early abort, which needs a second of received
 * bytes and therefore cannot fire on a cold object — keeps working on links
 * that are measurably slow.
 */

import type Player from 'video.js/dist/types/player';
import type { VhsXhrFactory, VhsXhrOptions } from '../types/videojs-vhs';
import { wrapVhsXhr } from './vhsXhrSeam';

/** The backstop, as a multiple of the playlist's target duration. */
export const BYTE_RANGE_TIMEOUT_MULTIPLIER = 10;

/** The backstop when the target duration cannot be read: the default encode's. */
export const BYTE_RANGE_TIMEOUT_FALLBACK_MS = 60_000;

/** The timeout a byte-range request gets, for a playlist with this target duration. */
export function byteRangeBackstopMs(targetDurationSec: number | undefined): number {
    return typeof targetDurationSec === 'number' && targetDurationSec > 0
        ? targetDurationSec * BYTE_RANGE_TIMEOUT_MULTIPLIER * 1000
        : BYTE_RANGE_TIMEOUT_FALLBACK_MS;
}

function isByteRangeRequest(options: VhsXhrOptions): boolean {
    return typeof options.headers?.Range === 'string';
}

/**
 * Replaces `tech.vhs.xhr` so byte-range segment requests are issued with the
 * backstop timeout; every other request, and every request VHS issued without
 * a timeout, is delegated untouched. Returns the uninstall function. Install
 * once per source, from `xhr-hooks-ready`, like the key interceptor.
 */
export function installByteRangeTimeout(player: Player): () => void {
    return wrapVhsXhr(player, (original, vhs) => {
        return function byteRangeTimeoutXhr(options, callback) {
            const timeout = options.timeout;
            if (!isByteRangeRequest(options) || typeof timeout !== 'number' || timeout <= 0) {
                return original(options, callback);
            }
            const backstop = byteRangeBackstopMs(vhs.playlists?.media()?.targetDuration);
            // A copy, not a mutation: the options object is VHS's, built per request.
            return original({ ...options, timeout: Math.max(timeout, backstop) }, callback);
        } as VhsXhrFactory;
    });
}
