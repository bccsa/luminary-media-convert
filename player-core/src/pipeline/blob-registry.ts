/**
 * Default {@link ServeStrategy}: blob/object URLs.
 *
 * All blob creation in the package funnels through here so native shells can
 * swap in a loopback server or file URIs without touching the pipeline, and so
 * tests can assert exactly what was served (including that a `keyDelivery:
 * 'memory'` adapter causes NO key to be served at all).
 */

import type { ServeStrategy } from '../types.js';

export const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
export const VTT_CONTENT_TYPE = 'text/vtt';
export const KEY_CONTENT_TYPE = 'application/octet-stream';

/**
 * Object-URL backed serve strategy with generation semantics: `release()`
 * revokes everything handed out since the previous `release()`, which the
 * controller calls once per source generation (on `load()` and `destroy()`).
 */
export class BlobServeStrategy implements ServeStrategy {
    private urls: string[] = [];

    serve(content: string | Uint8Array, contentType: string): string {
        const blob = new Blob([toBlobPart(content)], { type: contentType });
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        return url;
    }

    release(): void {
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.urls = [];
    }
}

/**
 * The strategy to use when the caller supplies none. Throws in environments
 * without `Blob`/`URL.createObjectURL` rather than failing later, deep inside a
 * load.
 */
export function createDefaultServeStrategy(): ServeStrategy {
    if (
        typeof Blob === 'undefined' ||
        typeof URL === 'undefined' ||
        typeof URL.createObjectURL !== 'function'
    ) {
        throw new Error(
            'No ServeStrategy available: this environment has no Blob/URL.createObjectURL. ' +
                'Pass opts.serveStrategy to PlayerController.',
        );
    }
    return new BlobServeStrategy();
}

function toBlobPart(content: string | Uint8Array): BlobPart {
    if (typeof content === 'string') return content;
    // Copy so the blob never aliases a subarray view of a larger buffer.
    const copy = new Uint8Array(content.length);
    copy.set(content);
    return copy;
}
