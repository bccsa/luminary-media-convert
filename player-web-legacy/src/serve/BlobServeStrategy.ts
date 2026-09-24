/**
 * The web's serving layer: object URLs, and synthetic URIs for live.
 *
 * `player-core` munges playlists into text and then has to hand that text to an
 * engine, which can only load a URL. On the web the answer is an object URL; in
 * a native shell it is a loopback HTTP server or a file URI. The wrapper never
 * learns which, because every one of them is a `ServeStrategy` — and this is
 * the web's.
 *
 * It lives here rather than in `player-core` because that package is headless
 * by contract (its own vitest config says as much: "no DOM. Anything that needs
 * Blob/URL is reached through the ServeStrategy seam and faked in tests"), and
 * a strategy built on `URL.createObjectURL` sitting inside it contradicted that
 * for as long as it was there. Moving it out has a second effect worth more
 * than the tidiness: the seam is now exercised by the shipping player on every
 * load, so the native shell that follows is the second host through a proven
 * path rather than the first.
 *
 * ### Live
 *
 * A live media playlist changes every target duration, and an object URL is
 * frozen at creation, so `serveLive` does not mint one. It registers the
 * {@link LivePlaylistSpec} under a synthetic `luminary://live/<n>` and returns
 * that; the adapter's VHS request seam recognises the scheme and calls
 * {@link resolveLive} every time the engine asks, which re-reads the upstream
 * playlist through `player-core`'s `resolveLivePlaylist` — fetch, LMCENC sniff,
 * rewrite. There is no timer here: VHS already re-requests a live playlist on
 * the cadence HLS prescribes, and answering those requests is the whole job.
 *
 * This only works while JavaScript runs. A locked phone freezes the page and
 * the refresh with it — which on the web is also true of VHS itself, so nothing
 * is lost that was not lost anyway. A native shell cannot lean on that, which
 * is why the spec is plain data: its resolver does the same three steps behind
 * a loopback URL or a resource-loader delegate, with no JavaScript involved.
 * `docs/suspension-safe-playback.md` has the boundary.
 */

import {
    PipelineError,
    resolveLivePlaylist,
    type LivePlaylistSpec,
    type ServeStrategy,
} from '@luminary-media-converter/player-core';
import {
    LIVE_PLAYLIST_URI_PREFIX,
    normalizeLivePlaylistUri,
    type LivePlaylistSource,
} from './livePlaylistUri';

export interface BlobServeStrategyOptions {
    /**
     * How live playlists are re-read. Pass the controller's own `fetchImpl`
     * when the host supplies one, so a live refresh sends whatever the load
     * sent. Defaults to the global `fetch`.
     */
    fetchImpl?: typeof fetch;
}

/**
 * Object-URL backed serve strategy with generation semantics: `release()`
 * revokes everything handed out since the previous `release()`, which the
 * controller calls once per source generation (on `load()` and `destroy()`).
 * Live registrations follow the same rule.
 */
export class BlobServeStrategy implements ServeStrategy, LivePlaylistSource {
    private urls: string[] = [];
    private readonly live = new Map<string, LivePlaylistSpec>();
    /**
     * Never reset, so a URI from a released generation can never name a spec
     * registered after it — it stays unknown, and is answered as such.
     */
    private nextLiveId = 0;
    private readonly fetchImpl: typeof fetch;

    constructor(options: BlobServeStrategyOptions = {}) {
        this.fetchImpl =
            options.fetchImpl ??
            ((input: RequestInfo | URL, init?: RequestInit) =>
                globalThis.fetch(input, init));
    }

    serve(content: string | Uint8Array, contentType: string): string {
        const blob = new Blob([toBlobPart(content)], { type: contentType });
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        return url;
    }

    serveLive(spec: LivePlaylistSpec): string {
        const uri = `${LIVE_PLAYLIST_URI_PREFIX}${++this.nextLiveId}`;
        this.live.set(uri, spec);
        return uri;
    }

    resolveLive(uri: string, signal: AbortSignal): Promise<string> {
        const spec = this.live.get(normalizeLivePlaylistUri(uri));
        if (!spec) {
            // Released, or never ours: answered the way a server answers a
            // playlist it does not have, so the engine's own error path runs.
            return Promise.reject(
                new PipelineError('fetch-failed', `${uri} is not being served`, {
                    missing: true,
                    status: 404,
                    url: uri,
                }),
            );
        }
        return resolveLivePlaylist(spec, { fetchImpl: this.fetchImpl, signal });
    }

    release(): void {
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.urls = [];
        this.live.clear();
    }
}

function toBlobPart(content: string | Uint8Array): BlobPart {
    if (typeof content === 'string') return content;
    // Copy so the blob never aliases a subarray view of a larger buffer.
    const copy = new Uint8Array(content.length);
    copy.set(content);
    return copy;
}
