/**
 * The reference `AssetStore`, `KeyHolder` and `UriRouter`: what native answers
 * for the bridge's URI scheme (`ASSET_URI_PREFIX`, `KEY_URI` in `bridge.ts`).
 */

import { ASSET_URI_PREFIX, KEY_URI, type BridgeAsset } from '../../../bridge.js';
import type { RouteResult } from '../harness.js';

export class AssetStore {
    private readonly generations = new Map<number, Map<string, BridgeAsset>>();
    private readonly released = new Set<number>();

    put(generation: number, assets: readonly BridgeAsset[]): void {
        let store = this.generations.get(generation);
        if (!store) {
            store = new Map();
            this.generations.set(generation, store);
        }
        for (const asset of assets) store.set(asset.uri, asset);
    }

    get(uri: string): BridgeAsset | undefined {
        for (const store of this.generations.values()) {
            const asset = store.get(uri);
            if (asset) return asset;
        }
        return undefined;
    }

    release(generation: number): void {
        this.released.add(generation);
    }

    /** After a load of `current` has reached the engine: released generations before it go. */
    purgeReleasedBefore(current: number): void {
        for (const generation of [...this.released]) {
            if (generation < current) {
                this.generations.delete(generation);
                this.released.delete(generation);
            }
        }
    }

    clear(): void {
        this.generations.clear();
        this.released.clear();
    }
}

export class KeyHolder {
    private key: Uint8Array | null = null;

    /** Replaces the key; the old bytes are zeroed, and no key means none. */
    set(hex: string | undefined): void {
        this.zero();
        if (hex) this.key = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
    }

    get(): Uint8Array | null {
        return this.key;
    }

    zero(): void {
        this.key?.fill(0);
        this.key = null;
    }
}

export class UriRouter {
    constructor(
        private readonly assets: AssetStore,
        private readonly key: KeyHolder,
    ) {}

    route(uri: string): RouteResult {
        if (uri === KEY_URI) {
            const key = this.key.get();
            return key ? { served: { bytes: key.slice(), contentType: 'application/octet-stream' } } : { failed: 'key-required' };
        }
        if (uri.startsWith(ASSET_URI_PREFIX)) {
            const asset = this.assets.get(uri);
            if (!asset) return { failed: 'not-found' };
            return { served: { bytes: new TextEncoder().encode(asset.text), contentType: asset.contentType } };
        }
        return { failed: 'not-found' };
    }
}
