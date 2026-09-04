/**
 * Structural shims for the video.js internals this player reaches into, none of
 * which video.js 8's bundled types describe: `@videojs/http-streaming`'s
 * per-handler request factory (`tech().vhs.xhr` — the seam the in-memory key
 * delivery hangs off) and `videojs-contrib-quality-levels`' `qualityLevels()`
 * plugin (bundled with video.js, so it is always there, but untyped).
 *
 * These are deliberately loose: `unknown` and index signatures wherever the
 * exact shape is VHS's business rather than ours, so a patch release that adds
 * a field cannot break the build. Only what is actually read is named.
 */

/** The request description VHS passes to its request factory. */
export interface VhsXhrOptions {
    uri: string;
    [key: string]: unknown;
}

/**
 * The response object a request factory hands back through its callback. VHS
 * reads `response` (an `ArrayBuffer` for a key request — it checks the byte
 * length), `statusCode`/`status` and the request `uri`.
 */
export interface VhsXhrResponse {
    uri?: string;
    response?: unknown;
    responseText?: string;
    status?: number;
    statusCode?: number;
    headers?: Record<string, string>;
    aborted?: boolean;
    timedout?: boolean;
    abort?: () => void;
    /** VHS attaches a `loadend` listener to every request it is tracking. */
    addEventListener?: (type: string, listener: unknown) => void;
    removeEventListener?: (type: string, listener: unknown) => void;
    [key: string]: unknown;
}

export type VhsXhrCallback = (
    error: unknown,
    request: VhsXhrResponse
) => unknown;

/**
 * `vhs.xhr` is callable *and* carries the hook plumbing VHS bolts onto it
 * (`beforeRequest` and the on/off request-response hooks with their backing
 * sets). Anything wrapping it has to carry those across, or the hooks a host
 * registered stop firing — hence naming them here.
 */
export interface VhsXhrFactory {
    (options: VhsXhrOptions, callback: VhsXhrCallback): unknown;
    beforeRequest?: unknown;
    onRequest?: unknown;
    onResponse?: unknown;
    offRequest?: unknown;
    offResponse?: unknown;
    /**
     * The backing sets, named as `Set`s rather than `unknown` because a wrapper
     * has to be able to create one: VHS allocates them lazily on whichever
     * object a hook was registered through, so the original and the wrapper
     * must be made to share one instance at install time.
     */
    _requestCallbackSet?: Set<unknown>;
    _responseCallbackSet?: Set<unknown>;
    [key: string]: unknown;
}

/** The handler VHS attaches to the tech once a source is loaded. */
export interface VhsHandler {
    xhr: VhsXhrFactory;
    [key: string]: unknown;
}

/** One entry of `player.qualityLevels()`. */
export interface QualityLevel {
    id: string;
    label?: string;
    width?: number;
    height?: number;
    bitrate?: number;
    frameRate?: number;
    /** Writable: clearing it is how a variant is taken out of ABR's hands. */
    enabled: boolean;
}

/**
 * `videojs-contrib-quality-levels`' list: array-like, and an event target
 * emitting `addqualitylevel`, `removequalitylevel` and `change`.
 */
export interface QualityLevelList {
    readonly length: number;
    selectedIndex: number;
    [index: number]: QualityLevel;
    on(type: string, listener: (...args: unknown[]) => void): void;
    off(type: string, listener: (...args: unknown[]) => void): void;
    addEventListener?(
        type: string,
        listener: (...args: unknown[]) => void
    ): void;
    removeEventListener?(
        type: string,
        listener: (...args: unknown[]) => void
    ): void;
}

declare module 'video.js/dist/types/tech/tech' {
    export default interface Tech {
        /** Present only while VHS is the active source handler. */
        vhs?: VhsHandler;
    }
}

declare module 'video.js/dist/types/player' {
    export default interface Player {
        qualityLevels(): QualityLevelList;
    }
}
