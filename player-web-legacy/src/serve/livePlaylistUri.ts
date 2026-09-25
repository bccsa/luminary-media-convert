/**
 * The address a live media playlist is served from on the web, and the one
 * question the engine side asks of whoever minted it.
 *
 * A blob URL cannot serve a live playlist — its bytes are fixed at creation,
 * and a live playlist is a different document every few seconds — so
 * `serveLive` hands out a synthetic `luminary://live/<n>` instead, the same
 * trick `luminary://key` plays for keys: a URI nothing on the network answers,
 * that the VHS request seam recognises and answers itself, freshly, on every
 * request the engine makes for it.
 *
 * This file is the contract between the two halves — the serving layer that
 * mints the URI (`BlobServeStrategy`) and the adapter seam that answers it
 * (`vhsLivePlaylistInterceptor`) — so that neither has to import the other.
 */

/** Every URI `serveLive` mints starts with this. */
export const LIVE_PLAYLIST_URI_PREFIX = 'luminary://live/';

/**
 * True for a URI minted by `serveLive`. Tolerates the trailing slash a URL
 * resolver may append, as the key sentinel check does.
 */
export function isLivePlaylistUri(uri: string): boolean {
    return uri.startsWith(LIVE_PLAYLIST_URI_PREFIX);
}

/** The URI with any resolver-appended trailing slash removed. */
export function normalizeLivePlaylistUri(uri: string): string {
    return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

/** What the adapter needs from the serving layer to answer a live request. */
export interface LivePlaylistSource {
    /**
     * The current text of the live playlist behind `uri`, rewritten and ready
     * to hand to the engine. Rejects with a `PipelineError` — carrying the
     * upstream HTTP `status` where there was one — when it cannot be read, and
     * with a 404 for a URI this source never minted.
     *
     * A URI it minted and has since released is never answered: the promise
     * settles only when `signal` aborts. Only the engine the URI was handed to
     * can be asking, in the moments before the next source replaces it, and an
     * error would send it through its exclusion ladder on the way out.
     */
    resolveLive(uri: string, signal: AbortSignal): Promise<string>;
}
