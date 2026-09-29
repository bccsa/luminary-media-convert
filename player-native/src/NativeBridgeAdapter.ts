/**
 * `player-core`'s {@link PlayerAdapter} over the native bridge — one
 * implementation for both platforms, since everything that differs between
 * AVPlayer and ExoPlayer sits behind the plugin and reaches JavaScript only as
 * {@link BridgeCapabilities}.
 *
 * The adapter contract is partly synchronous (`getCurrentTime`, `getVariants`,
 * `getAudioTracks`) and the bridge is not, so the adapter keeps a mirror fed by
 * native's events and answers from it. Every event carries the `loadId` it
 * belongs to, minted here before the call that starts the load; an event for
 * any other load is dropped, which is what keeps a slow event from the outgoing
 * engine out of the incoming source's state.
 *
 * Recovery is native's: the ladder has to run while JavaScript is frozen, so
 * there is no `recover()` here, and a fatal `error` arrives only once native has
 * spent the obligation. What does need JavaScript — rebuilding a munged source —
 * reaches the controller as `reload-requested`, either live or, when native
 * held it through a suspension, from {@link NativeBridgeAdapter.resume}.
 */

import {
    Emitter,
    type AdapterAudioTrack,
    type AdapterCapabilities,
    type AdapterEventMap,
    type AdapterEventName,
    type AdapterSource,
    type AdapterTextTrack,
    type AdapterVariant,
    type ChunkBoundary,
    type ChunkWarmOptions,
    type PlayerAdapter,
    type Unsubscribe,
} from '@luminary-media-converter/player-core';
import type { PluginListenerHandle } from '@capacitor/core';
import {
    BRIDGE_EVENT_NAMES,
    fromWireDuration,
    type BridgeEvent,
    type BridgeEventName,
    type BridgeInfo,
    type LuminaryPlayerPlugin,
    type NowPlaying,
    type Snapshot,
} from './bridge.js';
import type { AssetBatch } from './assetBatch.js';

export interface NativeBridgeAdapterOptions {
    plugin: LuminaryPlayerPlugin;
    playerId: string;
    info: BridgeInfo;
    batch: AssetBatch;
    /**
     * Where a failed fire-and-forget call is reported. The adapter contract
     * gives `pause`, `seek` and the rest no way to fail, so a rejection has
     * nowhere else to go; it is never retried.
     */
    report: (method: string, error: unknown) => void;
}

export class NativeBridgeAdapter implements PlayerAdapter {
    readonly capabilities: AdapterCapabilities;
    /**
     * Present only when native runs the warming loop: the controller calls it
     * through `?.`, so leaving it undefined is how the capability is declined.
     */
    readonly warmChunks?: (
        schedules: ChunkBoundary[][],
        options: ChunkWarmOptions,
    ) => void;

    private readonly plugin: LuminaryPlayerPlugin;
    private readonly playerId: string;
    private readonly batch: AssetBatch;
    private readonly report: (method: string, error: unknown) => void;
    private readonly emitter = new Emitter<AdapterEventMap>();
    private readonly listeners: Promise<PluginListenerHandle>[] = [];
    private readonly teardowns: Unsubscribe[] = [];

    private loadCount = 0;
    /** The load events are accepted for; null until the first. */
    private loadId: string | null = null;
    private nowPlaying: NowPlaying | undefined;
    private currentTime = 0;
    private duration = 0;
    private variants: AdapterVariant[] = [];
    private audioTracks: AdapterAudioTrack[] = [];
    private resuming: Promise<void> | null = null;
    private destroyed = false;

    constructor(options: NativeBridgeAdapterOptions) {
        this.plugin = options.plugin;
        this.playerId = options.playerId;
        this.batch = options.batch;
        this.report = options.report;

        const { capabilities } = options.info;
        this.capabilities = {
            nativeHls: false,
            keyDelivery: 'memory',
            variantSwitching: capabilities.variantSwitching,
            // Protocol v1 has no call that hands text tracks to native, so
            // there is nothing to render them with whatever native reports.
            renderText: false,
        };
        if (capabilities.chunkWarming) {
            this.warmChunks = (schedules, { leadSeconds, warmBytes }) =>
                this.warm(schedules, leadSeconds, warmBytes);
        }

        for (const name of BRIDGE_EVENT_NAMES) {
            this.listeners.push(
                this.plugin.addListener(name, (event) => this.receive(name, event)),
            );
        }
    }

    /** Resolves once every bridge listener is registered, so no event is missed. */
    async ready(): Promise<void> {
        await Promise.all(this.listeners);
    }

    /** Lock-screen and notification metadata, sent with every load that follows. */
    setNowPlaying(nowPlaying: NowPlaying | undefined): void {
        this.nowPlaying = nowPlaying;
    }

    /** Runs once, on {@link destroy}. */
    onDestroy(teardown: Unsubscribe): void {
        this.teardowns.push(teardown);
    }

    // -----------------------------------------------------------------------
    // Source
    // -----------------------------------------------------------------------

    async loadSource(src: AdapterSource): Promise<void> {
        const loadId = this.beginLoad();
        await this.plugin.load({
            playerId: this.playerId,
            loadId,
            generation: this.batch.generation,
            masterUri: src.url,
            assets: this.batch.take(),
            ...(src.keyHex ? { keyHex: src.keyHex } : {}),
            recovery: src.recovery,
            ...(this.nowPlaying ? { nowPlaying: this.nowPlaying } : {}),
        });
    }

    async reattach(): Promise<void> {
        if (this.loadId === null) return;
        const loadId = this.beginLoad();
        await this.plugin.reattach({ playerId: this.playerId, loadId });
    }

    /**
     * A new `loadId`, and a mirror emptied of the outgoing source. The empty
     * track list is announced: it is how the controller learns that the engine
     * is rebuilding with its own default selected, and hands a viewer's choice
     * back once the new list arrives (`PlayerAdapter.getAudioTracks`).
     */
    private beginLoad(): string {
        const loadId = `load-${++this.loadCount}`;
        this.loadId = loadId;
        this.currentTime = 0;
        this.duration = 0;
        this.variants = [];
        this.audioTracks = [];
        this.emitter.emit('audiotracks-updated', undefined);
        return loadId;
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    async play(): Promise<void> {
        await this.plugin.play({ playerId: this.playerId });
    }

    pause(): void {
        this.send('pause', this.plugin.pause({ playerId: this.playerId }));
    }

    seek(seconds: number): void {
        // Answered at once from the mirror: the controller reads the position
        // back as soon as it has asked for it, before native can report.
        this.currentTime = seconds;
        this.send(
            'seek',
            this.plugin.seek({ playerId: this.playerId, position: seconds }),
        );
    }

    setPlaybackRate(rate: number): void {
        this.send('setRate', this.plugin.setRate({ playerId: this.playerId, rate }));
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getDuration(): number {
        return this.duration;
    }

    // -----------------------------------------------------------------------
    // Renditions and tracks
    // -----------------------------------------------------------------------

    getVariants(): AdapterVariant[] {
        return this.variants;
    }

    setVariant(id: string | 'auto'): void {
        if (!this.capabilities.variantSwitching) return;
        this.send('setVariant', this.plugin.setVariant({ playerId: this.playerId, id }));
    }

    getAudioTracks(): AdapterAudioTrack[] {
        return this.audioTracks;
    }

    setAudioTrack(id: string): void {
        // Empty until this load's list arrives, which is when a choice can
        // mean a track of this source rather than of the one outgoing.
        if (!this.audioTracks.some((track) => track.id === id)) return;
        this.send(
            'setAudioTrack',
            this.plugin.setAudioTrack({ playerId: this.playerId, id }),
        );
    }

    /**
     * Side-loaded subtitles are not rendered natively, so their files are
     * dropped before they can ride along with the next load. Subtitles the
     * master itself carries are unaffected: they are playlists of the munge,
     * and render natively.
     */
    setTextTracks(tracks: AdapterTextTrack[]): void {
        this.batch.discard(tracks.map((track) => track.blobUrl));
    }

    setActiveTextTrack(): void {}

    // -----------------------------------------------------------------------
    // Chunk warming
    // -----------------------------------------------------------------------

    /**
     * Hands the schedules to native's loop. The controller's `fetchImpl` and
     * `log` stay behind: the loop has to run while JavaScript is frozen, so it
     * warms with the platform's own HTTP stack.
     */
    private warm(
        schedules: ChunkBoundary[][],
        leadSeconds: number,
        warmBytes: number,
    ): void {
        // Nothing loaded means nothing warming, so there is nothing to stop.
        if (this.loadId === null) return;
        this.send(
            'warmChunks',
            this.plugin.warmChunks({
                playerId: this.playerId,
                loadId: this.loadId,
                schedules,
                leadSeconds,
                warmBytes,
            }),
        );
    }

    // -----------------------------------------------------------------------
    // Resume
    // -----------------------------------------------------------------------

    /**
     * Catches the controller up after JavaScript was suspended, when events
     * native emitted in the meantime may never have arrived. Re-emits the
     * position, duration, buffer and play state from native's snapshot, then
     * any `reload-requested` native held because JavaScript could not act on it.
     *
     * Call it on every return to the foreground; calls made while one is in
     * flight share it, so two signals for one resume ask native once.
     */
    resume(): Promise<void> {
        if (this.destroyed || this.loadId === null) return Promise.resolve();
        this.resuming ??= this.askResumed().finally(() => {
            this.resuming = null;
        });
        return this.resuming;
    }

    private async askResumed(): Promise<void> {
        let result;
        try {
            result = await this.plugin.resumed({ playerId: this.playerId });
        } catch (error) {
            this.report('resumed', error);
            return;
        }
        if (this.destroyed || result.loadId !== this.loadId) return;
        this.applySnapshot(result.snapshot);
        if (result.pendingReload) {
            this.emitter.emit('reload-requested', result.pendingReload);
        }
    }

    private applySnapshot(snapshot: Snapshot): void {
        this.currentTime = snapshot.currentTime;
        this.duration = fromWireDuration(snapshot.duration);
        this.emitter.emit('timeupdate', { currentTime: this.currentTime });
        this.emitter.emit('durationchange', { duration: this.duration });
        this.emitter.emit('progress', { bufferedEnd: snapshot.bufferedEnd });
        this.emitter.emit(snapshot.playing ? 'playing' : 'pause', undefined);
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    on<E extends AdapterEventName>(
        event: E,
        listener: (payload: AdapterEventMap[E]) => void,
    ): Unsubscribe {
        return this.emitter.on(event, listener);
    }

    private receive<E extends BridgeEventName>(name: E, raw: BridgeEvent<E>): void {
        if (this.destroyed) return;
        if (raw.playerId !== this.playerId || raw.loadId !== this.loadId) return;
        // Narrowed per case below; TypeScript cannot correlate `name` with
        // `raw` through a generic, so the union is recovered by hand.
        const event = raw as BridgeEvent<BridgeEventName>;

        switch (name) {
            case 'timeupdate': {
                const { currentTime } = event as BridgeEvent<'timeupdate'>;
                this.currentTime = currentTime;
                this.emitter.emit('timeupdate', { currentTime });
                return;
            }
            case 'durationchange': {
                const { duration } = event as BridgeEvent<'durationchange'>;
                this.duration = fromWireDuration(duration);
                this.emitter.emit('durationchange', { duration: this.duration });
                return;
            }
            case 'progress': {
                const { bufferedEnd } = event as BridgeEvent<'progress'>;
                this.emitter.emit('progress', { bufferedEnd });
                return;
            }
            case 'playing':
            case 'pause':
            case 'waiting':
            case 'seeked':
            case 'ended':
                this.emitter.emit(name, undefined);
                return;
            case 'stalled': {
                const { stalled } = event as BridgeEvent<'stalled'>;
                this.emitter.emit('stalled', { stalled });
                return;
            }
            case 'error': {
                const { category, fatal, code, message } =
                    event as BridgeEvent<'error'>;
                this.emitter.emit('error', {
                    category,
                    fatal,
                    detail: { code, message },
                });
                return;
            }
            case 'reload-requested': {
                const { reason, attempt } = event as BridgeEvent<'reload-requested'>;
                this.emitter.emit('reload-requested', { reason, attempt });
                return;
            }
            case 'variants-updated': {
                this.variants = (event as BridgeEvent<'variants-updated'>).variants;
                this.emitter.emit('variants-updated', undefined);
                return;
            }
            case 'audiotracks-updated': {
                this.audioTracks = (event as BridgeEvent<'audiotracks-updated'>).tracks;
                this.emitter.emit('audiotracks-updated', undefined);
                return;
            }
            // For the host component, which listens on the plugin itself.
            case 'loadedmetadata':
            case 'presentationchange':
                return;
        }
    }

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emitter.clear();
        for (const teardown of this.teardowns.splice(0)) teardown();
        for (const listener of this.listeners) {
            void listener.then((handle) => handle.remove()).catch(() => undefined);
        }
        this.send('destroy', this.plugin.destroy({ playerId: this.playerId }));
    }

    private send(method: string, call: Promise<unknown>): void {
        call.catch((error: unknown) => this.report(method, error));
    }
}
