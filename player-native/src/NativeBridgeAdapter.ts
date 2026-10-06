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
 *
 * Native full-screen has its own audio and speed menus, and the adapter
 * contract has no event that tells the controller what a viewer chose there.
 * So the adapter tells them apart from echoes of its own calls and hands them
 * to {@link NativeBridgeAdapter.onViewerChoice}, the way `player-web`'s
 * component relays video.js's menus.
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
    LIVE_URI_PREFIX,
    type InlineFrame,
    assetUri,
    fromWireDuration,
    type BridgeEvent,
    type BridgeEventName,
    type BridgeInfo,
    type LuminaryPlayerPlugin,
    type NowPlaying,
    type Snapshot,
} from './bridge.js';
import type { AssetBatch } from './assetBatch.js';

/** A choice the viewer made in native UI, which the controller has not heard of. */
export type ViewerChoice = { kind: 'audio'; id: string } | { kind: 'rate'; rate: number };

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
    /** Native can draw the video in the page, in the frame {@link setInlineFrame} names. */
    readonly inlineVideo: boolean;
    /** Native mutes through {@link setMuted}. */
    readonly muting: boolean;
    /** Native shows and selects the master's subtitles. */
    readonly subtitleSelection: boolean;
    /** Native can start picture in picture. */
    readonly pictureInPicture: boolean;
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
    private readonly choiceListeners = new Set<(choice: ViewerChoice) => void>();

    private loadCount = 0;
    /** The load events are accepted for; null until the first. */
    private loadId: string | null = null;
    private nowPlaying: NowPlaying | undefined;
    private currentTime = 0;
    private duration = 0;
    private variants: AdapterVariant[] = [];
    private audioTracks: AdapterAudioTrack[] = [];
    /** The selection native last reported for this load. */
    private nativeAudioId: string | null = null;
    /**
     * A `setAudioTrack` sent and not yet reported back. Native reports every
     * change, its own and the viewer's, so until this one comes back a change
     * is taken for a step towards it rather than for a viewer's choice.
     */
    private requestedAudioId: string | null = null;
    /** Native's rate. It outlives a load, so a load does not reset it. */
    private nativeRate = 1;
    /** A `setRate` sent and not yet reported back; see {@link requestedAudioId}. */
    private requestedRate: number | null = null;
    private resuming: Promise<void> | null = null;
    private destroyed = false;

    constructor(options: NativeBridgeAdapterOptions) {
        this.plugin = options.plugin;
        this.playerId = options.playerId;
        this.batch = options.batch;
        this.report = options.report;

        const { capabilities } = options.info;
        this.inlineVideo = capabilities.inlineVideo === true;
        this.muting = capabilities.muting === true;
        this.subtitleSelection = capabilities.subtitleSelection === true;
        this.pictureInPicture = capabilities.pictureInPicture === true;
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

    /**
     * Shows the video in `frame` (the web view's coordinates, CSS pixels), or hides it. A no-op
     * where native does not draw inline: the call would be refused.
     */
    setInlineFrame(frame: InlineFrame | null): void {
        if (!this.inlineVideo || this.destroyed) return;
        this.send(
            'setInlineFrame',
            this.plugin.setInlineFrame({ playerId: this.playerId, ...(frame ? { frame } : {}) }),
        );
    }

    /** Lock-screen and notification metadata, sent with every load that follows. */
    setNowPlaying(nowPlaying: NowPlaying | undefined): void {
        this.nowPlaying = nowPlaying;
    }

    /**
     * Hears the choices a viewer makes in native UI: an audio language or a
     * speed. The controller has to adopt them (`setAudioTrack`,
     * `setPlaybackRate`), or its state and the next attach would undo them.
     */
    onViewerChoice(listener: (choice: ViewerChoice) => void): Unsubscribe {
        this.choiceListeners.add(listener);
        return () => this.choiceListeners.delete(listener);
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
            masterUri: this.masterUriFor(src.url),
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
     * What native is asked to load. A live source that is one media playlist has no master to
     * name, and native takes a `luminary://asset/` master only: it is wrapped in a one-variant
     * master whose variant is the live address, which native resolves on its own.
     */
    private masterUriFor(url: string): string {
        if (!url.startsWith(LIVE_URI_PREFIX)) return url;
        const uri = assetUri(this.batch.generation, 0, 'm3u8');
        this.batch.add({
            uri,
            contentType: 'application/vnd.apple.mpegurl',
            text: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${url}\n`,
        });
        return uri;
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
        this.nativeAudioId = null;
        this.requestedAudioId = null;
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
        // Native already plays at it: the viewer chose it there, and this is
        // the controller adopting that choice.
        if (this.requestedRate === null && rate === this.nativeRate) return;
        this.requestedRate = rate;
        this.plugin.setRate({ playerId: this.playerId, rate }).catch((error: unknown) => {
            if (this.requestedRate === rate) this.requestedRate = null;
            this.report('setRate', error);
        });
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
        // Already selected there, as with the rate.
        if (this.requestedAudioId === null && id === this.nativeAudioId) return;
        this.requestedAudioId = id;
        this.plugin.setAudioTrack({ playerId: this.playerId, id }).catch((error: unknown) => {
            if (this.requestedAudioId === id) this.requestedAudioId = null;
            this.report('setAudioTrack', error);
        });
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

    /**
     * Native renders the subtitles the master carries, so the choice goes there; side-loaded ones
     * are not rendered natively. The id is the master's `m:<group>:<name or language>`, and what
     * native matches is that last part, the label the menu shows.
     */
    setActiveTextTrack(id: string | null): void {
        if (!this.subtitleSelection || this.destroyed) return;
        const label = id === null ? null : id.split(':').slice(2).join(':');
        if (id !== null && !id.startsWith('m:')) return;
        this.send(
            'setSubtitleTrack',
            this.plugin.setSubtitleTrack({ playerId: this.playerId, ...(label ? { label } : {}) }),
        );
    }

    /** Mutes or unmutes. A no-op where native cannot: the call would be refused. */
    setMuted(muted: boolean): void {
        if (!this.muting || this.destroyed) return;
        this.send('setMuted', this.plugin.setMuted({ playerId: this.playerId, muted }));
    }

    /** Starts picture in picture from the picture that is showing. */
    startPictureInPicture(): void {
        if (!this.pictureInPicture || this.destroyed) return;
        this.send('startPictureInPicture', this.plugin.startPictureInPicture({ playerId: this.playerId }));
    }

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
        // Native has applied every call made before this one. An answer to them
        // that was lost while suspended must not hold back the viewer's next
        // choice for good.
        this.requestedAudioId = null;
        this.requestedRate = null;
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
        if (raw.playerId !== this.playerId) return;
        // The rate is the player's, not a load's: a change native made just
        // before a load is stamped with the outgoing load, and dropping it
        // would strand the request it answers, after which every pick the
        // viewer makes would be taken for a step towards that request.
        if (name === 'ratechange') {
            this.rateChanged((raw as BridgeEvent<'ratechange'>).rate);
            return;
        }
        if (raw.loadId !== this.loadId) return;
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
                const { tracks, activeId } = event as BridgeEvent<'audiotracks-updated'>;
                const previous = this.audioTracks;
                const previousId = this.nativeAudioId;
                this.audioTracks = tracks;
                this.nativeAudioId = activeId;
                this.emitter.emit('audiotracks-updated', undefined);
                if (this.requestedAudioId !== null) {
                    if (activeId === this.requestedAudioId) this.requestedAudioId = null;
                    return;
                }
                // A new list comes with the engine's own default selected,
                // which nobody chose; only a move within the same list is a pick.
                // From nothing to something is native settling on its default, as it does after
                // a load or a reattach, not a pick.
                if (
                    activeId !== null &&
                    previousId !== null &&
                    activeId !== previousId &&
                    sameIds(previous, tracks)
                ) {
                    this.choose({ kind: 'audio', id: activeId });
                }
                return;
            }
            // For the host component, which listens on the plugin itself.
            case 'loadedmetadata':
            case 'presentationchange':
            case 'ratechange':
            case 'mutedchange':
                return;
        }
    }

    private rateChanged(rate: number): void {
        this.nativeRate = rate;
        if (this.requestedRate !== null) {
            if (rate === this.requestedRate) this.requestedRate = null;
            return;
        }
        this.choose({ kind: 'rate', rate });
    }

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------

    private choose(choice: ViewerChoice): void {
        for (const listener of [...this.choiceListeners]) listener(choice);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emitter.clear();
        this.choiceListeners.clear();
        // A host's teardown that throws must not keep native playing.
        for (const teardown of this.teardowns.splice(0)) {
            try {
                teardown();
            } catch (error) {
                this.report('destroy', error);
            }
        }
        for (const listener of this.listeners) {
            void listener.then((handle) => handle.remove()).catch(() => undefined);
        }
        this.send('destroy', this.plugin.destroy({ playerId: this.playerId }));
    }

    private send(method: string, call: Promise<unknown>): void {
        call.catch((error: unknown) => this.report(method, error));
    }
}

function sameIds(a: readonly AdapterAudioTrack[], b: readonly AdapterAudioTrack[]): boolean {
    return a.length > 0 && a.length === b.length && a.every((track, i) => track.id === b[i]?.id);
}
