/**
 * The web's serving layer: object URLs. A copy, on life support.
 *
 * The canonical version is `player-web-legacy/src/serve/BlobServeStrategy.ts`,
 * and this file exists only so this package keeps building and the encoder app
 * keeps playing until it is deleted and the legacy package takes its name. Do
 * not develop it here; `chunkWarming.ts` is duplicated between the two packages
 * for the same reason and on the same terms.
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
 * Live is not implemented: there is no `serveLive`, which is exactly how a
 * strategy says so. The pipeline reads its absence and refuses a live source
 * rather than serving a snapshot that can never change. Implementing it here
 * would mean intercepting engine requests to re-fetch, re-decrypt and rewrite
 * the playlist on a cadence — possible over the VHS request seam, and still
 * useless on a locked phone, because that work is JavaScript. Live belongs to
 * the native resolver; see `docs/suspension-safe-playback.md`.
 */

import type { ServeStrategy } from '@luminary-media-converter/player-core';

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

function toBlobPart(content: string | Uint8Array): BlobPart {
    if (typeof content === 'string') return content;
    // Copy so the blob never aliases a subarray view of a larger buffer.
    const copy = new Uint8Array(content.length);
    copy.set(content);
    return copy;
}
