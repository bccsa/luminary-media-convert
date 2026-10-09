/**
 * Live media playlists, answered on the VHS request seam.
 *
 * `serveLive` hands the munged master a `luminary://live/<n>` URI for every
 * live media playlist, because an object URL is frozen and a live playlist is
 * not. VHS requests that URI like any other playlist — once to start, then
 * again every target duration for as long as the stream has no
 * `#EXT-X-ENDLIST` — through its per-handler factory `tech.vhs.xhr`. This
 * wrapper answers each of those requests from the {@link LivePlaylistSource}
 * with a fresh read of the upstream playlist; everything else goes to the
 * factory that was there.
 *
 * VHS keeps its refresh schedule, its retry policy and its error handling:
 * this seam only changes where the bytes come from. An upstream failure is
 * reported with the status the upstream answered, so the engine reacts to a
 * 404 the way it would have reacted to one met directly.
 *
 * The shape of the request object is dictated by what `playlist-loader.js`
 * reads off it — `responseText`, `status`, `responseURL` for redirect
 * tracking, `abort()` for `stopRequest()` — rather than by any spec. As with
 * the key interceptor, the VHS host hooks (`onRequest` / `onResponse`) do not
 * see these requests: nothing reaches the network through VHS for them, and
 * the fetch that does go out is the serving layer's, as the load's was.
 */

import type Player from 'video.js/dist/types/player';
import type {
    VhsXhrCallback,
    VhsXhrFactory,
    VhsXhrOptions,
    VhsXhrResponse,
} from '../types/videojs-vhs';
import {
    isLivePlaylistUri,
    type LivePlaylistSource,
} from '../serve/livePlaylistUri';
import { wrapVhsXhr } from './vhsXhrSeam';

/**
 * Replaces `tech.vhs.xhr` so requests for `luminary://live/…` URIs are
 * answered by `source`; every other URI is delegated to the factory that was
 * there. Returns the uninstall function. Install once per source, from
 * `xhr-hooks-ready`, like the other seam policies.
 */
export function installLivePlaylistXhr(
    player: Player,
    source: LivePlaylistSource,
): () => void {
    const noop = (): void => {};

    return wrapVhsXhr(player, (original) => {
        const wrapper = function livePlaylistXhr(
            options: VhsXhrOptions,
            callback: VhsXhrCallback,
        ): unknown {
            if (!isLivePlaylistUri(options.uri)) return original(options, callback);

            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const request: VhsXhrResponse = {
                uri: options.uri,
                requestType: options.requestType,
                requestTime: Date.now(),
                // Set to the URI asked for, never the upstream URL: VHS adopts a
                // differing `responseURL` as the playlist's new address, and the
                // upstream one would bypass this seam on the next refresh.
                responseURL: options.uri,
                responseType: '',
                status: 0,
                statusCode: 0,
                response: '',
                responseText: '',
                aborted: false,
                timedout: false,
                abort: () => {
                    request.aborted = true;
                    finish();
                    controller.abort();
                },
                addEventListener: noop,
                removeEventListener: noop,
            };

            // Abort, timeout and response race for one settle; only the winner
            // acts. An abort calls nothing back: VHS aborts only requests it has
            // already stopped listening to.
            function finish(): boolean {
                if (settled) return false;
                settled = true;
                if (timer !== undefined) clearTimeout(timer);
                return true;
            }

            const timeoutMs = Number(options.timeout);
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    if (!finish()) return;
                    request.timedout = true;
                    controller.abort();
                    callback(
                        Object.assign(new Error(`Timed out requesting ${options.uri}`), {
                            code: 'ETIMEDOUT',
                        }),
                        request,
                    );
                }, timeoutMs);
            }

            source.resolveLive(options.uri, controller.signal).then(
                (text) => {
                    if (!finish()) return;
                    request.status = 200;
                    request.statusCode = 200;
                    request.response = text;
                    request.responseText = text;
                    callback(null, request);
                },
                (error: unknown) => {
                    if (!finish()) return;
                    const status = (error as { status?: unknown })?.status;
                    if (typeof status === 'number') {
                        request.status = status;
                        request.statusCode = status;
                    }
                    callback(error, request);
                },
            );

            return request;
            // The cast carries the hook properties the seam copies across, which a
            // plain function expression cannot declare.
        } as VhsXhrFactory;
        return wrapper;
    });
}
