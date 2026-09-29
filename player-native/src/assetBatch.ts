/**
 * What the serving layer has minted that native does not hold yet.
 *
 * `ServeStrategy.serve` is synchronous and must hand back an address at once,
 * but nothing crosses the bridge until the adapter has something to send it
 * with. So the strategy records each asset here, and the adapter takes the
 * pending ones along with the next `load` — one call per attach rather than one
 * per playlist. Shared by {@link NativeServeStrategy} and
 * {@link NativeBridgeAdapter}, which is why it is its own object.
 *
 * A generation is one controller `load()`. Within it the munge reuses the
 * media-playlist addresses it has already served, so a later attach — an angle
 * switch, the audio toggle, a re-munge — sends only what is new.
 */

import type { BridgeAsset } from './bridge.js';

export class AssetBatch {
    /** Starts at 0; the controller releases once before its first load. */
    private current = 0;
    private pending: BridgeAsset[] = [];
    private delivered = false;

    get generation(): number {
        return this.current;
    }

    add(asset: BridgeAsset): void {
        this.pending.push(asset);
    }

    /** The pending assets, now considered sent with this generation. */
    take(): BridgeAsset[] {
        const assets = this.pending;
        this.pending = [];
        this.delivered = true;
        return assets;
    }

    /**
     * Drops pending assets that will never be sent, such as side-loaded
     * subtitles handed to an engine that cannot render them.
     */
    discard(uris: readonly string[]): void {
        const drop = new Set(uris);
        this.pending = this.pending.filter((asset) => !drop.has(asset.uri));
    }

    /**
     * Ends the current generation and starts the next. Returns the one ended,
     * and whether native ever received any of it — a generation that never
     * reached native has nothing there to release.
     */
    release(): { generation: number; delivered: boolean } {
        const ended = { generation: this.current, delivered: this.delivered };
        this.current += 1;
        this.pending = [];
        this.delivered = false;
        return ended;
    }
}
