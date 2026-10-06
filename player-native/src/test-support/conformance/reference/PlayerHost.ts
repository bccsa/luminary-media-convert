/**
 * The reference `PlayerHost`: one player's `AssetStore`, `KeyHolder`,
 * `UriRouter`, `FakeEngine` and `EventSink`, and the order it applies a load in.
 */

import type { BridgeAsset, InlineFrame } from '../../../bridge.js';
import type { Json, JsonObject } from '../scenario.js';
import type { VirtualClock } from './clock.js';
import { EventSink } from './EventSink.js';
import { FakeEngine, type EngineListener } from './FakeEngine.js';
import { AssetStore, KeyHolder, UriRouter } from './store.js';

export class PlayerHost implements EngineListener {
    readonly engine: FakeEngine;
    readonly router: UriRouter;
    private readonly assets = new AssetStore();
    private readonly key = new KeyHolder();
    private readonly sink: EventSink;
    private generation = 0;
    private loadId: string | null = null;
    private duration: number | null = 0;
    /** A new player plays at 1; a load keeps whatever rate the last one had. */
    private rate = 1;
    /** Where the video is shown inside the page, while it is. */
    private inlineFrame: InlineFrame | null = null;

    constructor(
        readonly playerId: string,
        clock: VirtualClock,
        engineLog: JsonObject[],
        emit: (event: JsonObject) => void,
        private readonly variantSwitching: boolean,
    ) {
        this.engine = new FakeEngine(clock, engineLog);
        this.engine.listener = this;
        this.router = new UriRouter(this.assets, this.key);
        this.sink = new EventSink(playerId, clock, emit, () => this.engine.position());
    }

    get currentGeneration(): number {
        return this.generation;
    }

    /** Assets → key → engine; the generations it replaces are purged once the engine has the new one. */
    load(args: {
        loadId: string;
        generation: number;
        masterUri: string;
        assets: BridgeAsset[];
        keyHex?: string;
        startPosition?: number;
    }): void {
        this.generation = args.generation;
        this.assets.put(args.generation, args.assets);
        this.key.set(args.keyHex);
        this.beginLoad(args.loadId);
        this.engine.load(args.masterUri, args.startPosition);
        this.assets.purgeReleasedBefore(args.generation);
    }

    reattach(loadId: string): void {
        this.beginLoad(loadId);
        this.engine.reattach();
    }

    /** Every load and reattach starts with an empty track list, stamped with the new load. */
    private beginLoad(loadId: string): void {
        this.loadId = loadId;
        this.duration = 0;
        this.sink.begin(loadId);
        this.sink.send('audiotracks-updated', { tracks: [], activeId: null });
    }

    putAssets(generation: number, assets: BridgeAsset[]): void {
        this.assets.put(generation, assets);
    }

    releaseAssets(generation: number): void {
        this.assets.release(generation);
    }

    setInlineFrame(frame: InlineFrame | null): void {
        this.inlineFrame = frame;
        this.engine.setInlineFrame(frame);
    }

    /** Pauses, unless the item has no video, or the video is shown in the page: it plays on there. */
    exitFullscreen(): void {
        this.engine.exitFullscreen();
        if (this.engine.hasVideo && !this.inlineFrame) this.engine.pause();
    }

    resumed(): JsonObject {
        const snapshot = this.engine.snapshot();
        return { loadId: this.loadId, snapshot: { ...snapshot } };
    }

    destroy(): void {
        this.sink.close();
        this.key.zero();
        this.assets.clear();
        this.engine.listener = null;
        this.engine.destroy();
    }

    // EngineListener: the engine's signals, turned into events.

    readyToPlay(reported: number | null): void {
        // Whole milliseconds: an engine refines the duration as it loads, and the
        // sub-millisecond part tells the host nothing.
        const duration = reported === null ? null : Math.round(reported * 1000) / 1000;
        if (duration !== this.duration) {
            this.duration = duration;
            this.sink.send('durationchange', { duration });
        }
        this.sink.send('loadedmetadata', { duration });
    }

    playing(): void {
        this.sink.send('playing');
        this.sink.startTicking();
    }

    paused(): void {
        this.sink.stopTicking();
        this.sink.timeupdateNow();
        this.sink.send('pause');
    }

    buffering(): void {
        this.sink.send('waiting');
    }

    seeked(): void {
        this.sink.timeupdateNow();
        this.sink.send('seeked');
    }

    ended(): void {
        this.sink.stopTicking();
        this.sink.send('ended');
    }

    tracks(tracks: Json, activeId: Json): void {
        this.sink.send('audiotracks-updated', { tracks, activeId });
    }

    /** Always empty unless `variantSwitching`, so there is nothing to announce. */
    variants(variants: Json): void {
        if (this.variantSwitching) this.sink.send('variants-updated', { variants });
    }

    bufferedTo(end: number): void {
        this.sink.progress(end);
    }

    private muted = false;

    /** Only on a change, whoever made it. */
    mutedChanged(muted: boolean): void {
        if (muted === this.muted) return;
        this.muted = muted;
        this.sink.send('mutedchange', { muted });
    }

    private airPlay = { available: false, active: false };

    /** Only on a change, whoever made it: a device came or went, or playback moved to or from one. */
    airPlayChanged(available: boolean, active: boolean): void {
        if (available === this.airPlay.available && active === this.airPlay.active) return;
        this.airPlay = { available, active };
        this.sink.send('airplaychange', { available, active });
    }

    /** Only on a change, whoever made it. */
    rateChanged(rate: number): void {
        if (rate === this.rate) return;
        this.rate = rate;
        this.sink.send('ratechange', { rate });
    }
}
