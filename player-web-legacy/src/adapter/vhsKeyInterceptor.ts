/**
 * In-memory AES-128 key delivery for `@videojs/http-streaming`.
 *
 * The session key never leaves the process: it is not written to a blob URL,
 * not fetched, and never appears on the network. VHS asks for it like any other
 * resource — through the per-handler request factory `tech.vhs.xhr`, which
 * `media-segment-request.js` calls with the AES-128 `URI="…"` of the playlist —
 * so answering it from memory is a matter of wrapping that one function.
 *
 * The wrap is internal VHS API, pinned to the 8.23.4 / VHS 3.17.5 versions this
 * workspace installs, and the shape of the request object handed back is
 * dictated by `handleKeyResponse`/`handleErrors` rather than by any spec. Should
 * it ever prove brittle, the documented escape is one word: construct
 * {@link ../adapter/VideoJsAdapter!VideoJsAdapter} with
 * `keyDelivery: 'url'` and the wrapper mints a key blob URL instead.
 */

import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/player-core';
import type Player from 'video.js/dist/types/player';
import type {
    VhsHandler,
    VhsXhrCallback,
    VhsXhrFactory,
    VhsXhrOptions,
    VhsXhrResponse,
} from '../types/videojs-vhs';

/**
 * The hook plumbing VHS bolts onto its request factory. A wrapper that does not
 * carry these across silently stops firing whatever request/response hooks a
 * host registered, so they are copied rather than re-implemented.
 */
const HOOK_PROPERTIES = [
    'beforeRequest',
    'onRequest',
    'onResponse',
    'offRequest',
    'offResponse',
] as const;

/**
 * The two hook registries, which are copied by *reference* rather than by
 * value — and are created up front on the original when it has none.
 *
 * VHS creates these lazily: `onRequest` allocates the set on whichever object
 * it was called on. So a host registering a hook after the wrap would create a
 * set on the wrapper that the original — which is what actually reads them when
 * it runs a real request — cannot see, and the hook would never fire. Both
 * objects have to end up pointing at the same Set, which means it has to exist
 * before either of them can make its own.
 */
const HOOK_CALLBACK_SETS = ['_requestCallbackSet', '_responseCallbackSet'] as const;

/**
 * Recognizes the sentinel key URI the wrapper normalizes every AES-128
 * `URI="…"` to. Tolerates the trailing slash a URL resolver may append.
 */
function isKeyPlaceholder(url: string): boolean {
    return url === LUMINARY_KEY_PLACEHOLDER_URI || url === `${LUMINARY_KEY_PLACEHOLDER_URI}/`;
}

/**
 * The VHS handler for the source currently loaded, or null when VHS is not
 * driving this tech (native playback, or no source yet).
 */
function vhsHandler(player: Player): VhsHandler | null {
    try {
        const tech = player.tech({ IWillNotUseThisInPlugins: true });
        return tech?.vhs ?? null;
    } catch {
        // tech() throws before a tech exists; treat it as "nothing to wrap".
        return null;
    }
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
    const vhs = vhsHandler(player);
    const original = vhs?.xhr;
    if (!vhs || typeof original !== 'function') return noop;

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
        // The cast carries the hook properties copied below, which a plain
        // function expression cannot declare.
    } as VhsXhrFactory;

    for (const property of HOOK_PROPERTIES) {
        if (original[property] !== undefined) wrapper[property] = original[property];
    }
    for (const property of HOOK_CALLBACK_SETS) {
        original[property] ??= new Set();
        wrapper[property] = original[property];
    }

    vhs.xhr = wrapper;

    return () => {
        // Only if it is still ours: a later source replaced the whole handler,
        // and restoring into that one would hand it a factory from a dead load.
        if (vhs.xhr === wrapper) vhs.xhr = original;
    };
}
