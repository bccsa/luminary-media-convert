/**
 * The native shell's serving layer: `luminary://asset/` addresses answered from
 * native memory.
 *
 * `player-core` munges playlists into text and needs an address the engine can
 * load. On the web that is an object URL (`player-web`'s `BlobServeStrategy`);
 * here it is an address in the bridge's own scheme, which native's `UriRouter`
 * answers from the bytes it was sent. Minting is synchronous and local: the
 * asset is recorded in the {@link AssetBatch}, and crosses the bridge with the
 * adapter's next `load`.
 *
 * Only text crosses. The pipeline serves binary content only for a key under
 * `keyDelivery: 'url'`, and this shell delivers keys from memory, so binary
 * content here is a programming error and is refused rather than mangled.
 *
 * There is no `serveLive` yet: its absence is what makes the pipeline refuse a
 * live source with `live-unsupported`. It arrives with `putLive` once both
 * platforms turn `live` on.
 */

import {
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
    type ServeStrategy,
} from '@luminary-media-converter/player-core';
import { assetUri, type LuminaryPlayerPlugin } from './bridge.js';
import type { AssetBatch } from './assetBatch.js';

const EXTENSIONS: Record<string, 'm3u8' | 'vtt'> = {
    [PLAYLIST_CONTENT_TYPE]: 'm3u8',
    [VTT_CONTENT_TYPE]: 'vtt',
};

export interface NativeServeStrategyOptions {
    plugin: LuminaryPlayerPlugin;
    playerId: string;
    batch: AssetBatch;
    /** Where a failed `releaseAssets` is reported; it is never retried. */
    report: (method: string, error: unknown) => void;
}

export class NativeServeStrategy implements ServeStrategy {
    /** Never reset, so an address is never reused, across generations or within one. */
    private counter = 0;

    constructor(private readonly options: NativeServeStrategyOptions) {}

    serve(content: string | Uint8Array, contentType: string): string {
        if (typeof content !== 'string') {
            throw new Error(
                `The native bridge carries text only; refusing ${contentType} bytes`,
            );
        }
        const extension = EXTENSIONS[contentType];
        if (!extension) {
            throw new Error(`The native bridge cannot serve ${contentType}`);
        }
        const { batch } = this.options;
        const uri = assetUri(batch.generation, ++this.counter, extension);
        batch.add({ uri, contentType, text: content });
        return uri;
    }

    /**
     * Ends the generation. Native purges it only once a load of a newer one
     * has taken over, so this is safe to send before the next load: the
     * engine keeps playing from it until then.
     */
    release(): void {
        const { plugin, playerId, batch, report } = this.options;
        const { generation, delivered } = batch.release();
        if (!delivered) return;
        plugin
            .releaseAssets({ playerId, generation })
            .catch((error: unknown) => report('releaseAssets', error));
    }
}
