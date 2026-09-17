/**
 * In-memory AES-128 key delivery for `@videojs/http-streaming`.
 *
 * The session key never leaves the process: it is not written to a blob URL,
 * not fetched, and never appears on the network. VHS asks for it like any other
 * resource — through the per-handler request factory `tech.vhs.xhr`, which
 * `media-segment-request.js` calls with the AES-128 `URI="…"` of the playlist —
 * so answering it from memory is a matter of wrapping that one function. The
 * wrapping itself, hook plumbing and all, is `vhsXhrSeam`'s job; this file is
 * only the key policy on top of it.
 *
 * The shape of the request object handed back is dictated by
 * `handleKeyResponse`/`handleErrors` rather than by any spec. Should the seam
 * ever prove brittle, the documented escape is one word: construct
 * {@link ../adapter/VideoJsAdapter!VideoJsAdapter} with `keyDelivery: 'url'`
 * and the wrapper mints a key blob URL instead.
 */

import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/player-core';
import type Player from 'video.js/dist/types/player';
import type {
    VhsXhrCallback,
    VhsXhrFactory,
    VhsXhrOptions,
    VhsXhrResponse,
} from '../types/videojs-vhs';
import { wrapVhsXhr } from './vhsXhrSeam';

/**
 * Recognizes the sentinel key URI the wrapper normalizes every AES-128
 * `URI="…"` to. Tolerates the trailing slash a URL resolver may append.
 */
function isKeyPlaceholder(url: string): boolean {
    return url === LUMINARY_KEY_PLACEHOLDER_URI || url === `${LUMINARY_KEY_PLACEHOLDER_URI}/`;
}

/**
 * Replaces `tech.vhs.xhr` so requests for the sentinel key URI are answered
 * from `getKeyBytes()`; every other URI is delegated to the factory that was
 * there. Returns the uninstall function.
 *
 * Call this once per source: `handleSource` builds a fresh handler and a fresh
 * `xhr` on every `player.src(...)`, and announces it with `xhr-hooks-ready`.
 * Segment loading reads `this.vhs_.xhr` per request, so there is no stale
 * capture to worry about — replacing the property is enough.
 */
export function installMemoryKeyXhr(
    player: Player,
    getKeyBytes: () => Uint8Array | null,
): () => void {
    const noop = (): void => {};

    return wrapVhsXhr(player, (original) => {
        const wrapper = function keyInterceptingXhr(
            options: VhsXhrOptions,
            callback: VhsXhrCallback,
        ): unknown {
            if (!isKeyPlaceholder(options.uri)) return original(options, callback);

            const key = getKeyBytes();
            const hasKey = key !== null && key.byteLength > 0;
            const request: VhsXhrResponse = {
                uri: options.uri,
                responseType: 'arraybuffer',
                status: 200,
                aborted: false,
                timedout: false,
                // A standalone 16-byte ArrayBuffer: VHS keeps the buffer and checks
                // its length exactly, so a view onto a larger one would be rejected.
                response: hasKey ? key.slice().buffer : new ArrayBuffer(0),
                // mediaSegmentRequest files whatever comes back in its abort list, then
                // attaches a `loadend` listener to every entry in it. Both have to exist
                // or the segment load throws before a single byte is decrypted. Nothing
                // depends on the event arriving: VHS's handler only reads `aborted`, and
                // this request is answered from memory and never aborted.
                abort: noop,
                addEventListener: noop,
                removeEventListener: noop,
            };
            const error = hasKey
                ? null
                : new Error('No session key available for the in-memory key loader');

            // Asynchronously, always: the caller pushes this object into its active
            // request list *after* we return, and a synchronous callback re-enters
            // its completion logic before that has happened.
            queueMicrotask(() => callback(error, request));
            return request;
            // The cast carries the hook properties the seam copies across, which a
            // plain function expression cannot declare.
        } as VhsXhrFactory;
        return wrapper;
    });
}
