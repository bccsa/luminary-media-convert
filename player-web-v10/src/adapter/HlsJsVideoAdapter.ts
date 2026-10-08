import { Hls } from '@videojs/hlsjs-video';
import {
    DEFAULT_RECOVERY_POLICY,
    keyBytes,
    type AdapterAudioTrack,
    type AdapterCapabilities,
    type AdapterErrorCategory,
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
import { RecoveryLadder } from '../drivers/RecoveryLadder';
import type { LivePlaylistSource } from '../serve/livePlaylistUri';
import { ChunkPrefetcher } from './chunkWarming';
import { initialBandwidth, persistBandwidth } from './hlsBandwidth';
import { createLuminaryLoader, loadPolicyConfig } from './hlsLoaders';
import { HlsStallSignals } from './hlsStallSignals';
import type { HlsEngine, HlsErrorData, HlsJsConfig, HlsJsVideoElement } from './hlsTypes';

/** The MIME type that routes a source to hls.js; a blob master has no `.m3u8` to infer it from. */
const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

/**
 * Thrown by {@link HlsJsVideoAdapter.loadSource} when the browser has no Media Source
 * implementation and the source *requires* munged playback. The wrapper maps the `code` onto
 * `PlayerError{ code: 'unsupported-browser', fatal: true }`.
 */
export class UnsupportedBrowserError extends Error {
    readonly code = 'unsupported-browser' as const;

    constructor(message = 'This browser cannot play munged HLS content.') {
        super(message);
        this.name = 'UnsupportedBrowserError';
    }
}

/**
 * True when hls.js can drive playback here: it prefers `ManagedMediaSource` where that exists
 * (iOS 17.1+), and the second clause is a belt-and-braces feature detect.
 */
export function isHlsEngineSupported(): boolean {
    try {
        if (Hls.isSupported()) return true;
    } catch {
        /* engine unavailable in this environment */
    }
    return typeof globalThis !== 'undefined' && 'ManagedMediaSource' in globalThis;
}

function errorCategory(type: string): AdapterErrorCategory {
    if (type === Hls.ErrorTypes.NETWORK_ERROR) return 'network';
    if (type === Hls.ErrorTypes.MEDIA_ERROR) return 'media';
    return 'other';
}

function variantId(rendition: { height?: number | undefined; bitrate?: number | undefined }): string {
    return rendition.height ? String(rendition.height) : `b${rendition.bitrate ?? 0}`;
}

export interface HlsJsVideoAdapterOptions {
    /**
     * Who answers the `luminary://live/…` URIs a live source's munged master names — the
     * `BlobServeStrategy` handed to the controller, which minted them.
     */
    liveSource?: LivePlaylistSource;
    /** hls.js config merged under the adapter's own, for the settings a host must own. */
    hlsConfig?: HlsJsConfig;
}

/**
 * {@link PlayerAdapter} over a caller-supplied `<hlsjs-video>` element.
 *
 * The element belongs to the component that created it: a new source goes through `source`,
 * never dispose-and-recreate, so an angle switch keeps one set of DOM and chrome alive. For the
 * same reason {@link destroy} detaches what this adapter attached and stops there.
 */
export class HlsJsVideoAdapter implements PlayerAdapter {
    readonly capabilities: AdapterCapabilities = {
        nativeHls: false,
        keyDelivery: 'memory',
        variantSwitching: true,
        renderText: true,
    };

    private readonly el: HlsJsVideoElement;
    private readonly options: HlsJsVideoAdapterOptions;
    private readonly stallSignals: HlsStallSignals;
    private readonly ladder: RecoveryLadder;
    private prefetcher: ChunkPrefetcher | null = null;
    private keyBytes: Uint8Array | null = null;
    private lastSource: AdapterSource | null = null;
    /** Where forward progress is measured from: the furthest played position since the last seek. */
    private lastProgressTime = 0;
    private onVisibilityChange: (() => void) | null = null;
    private deferredSeek: (() => void) | null = null;
    private elementListeners: [string, () => void][] = [];
    private listListeners: (() => void)[] = [];
    private engine: HlsEngine | null = null;
    private stopPersistingBandwidth: (() => void) | null = null;
    private textTracks = new Map<string, HTMLTrackElement>();
    private activeTextTrackId: string | null = null;
    /** Bumped to rebuild the engine for the same source; hls.js reads its config only at construction. */
    private engineGeneration = 0;
    /**
     * The element's audio tracks still belong to the source being replaced: a track selected there
     * is loaded by an engine about to be torn down, so the list reads as empty and selections are
     * refused until the element has rebuilt it.
     */
    private audioTracksOutgoing = false;
    private listeners = new Map<AdapterEventName, Set<(payload: never) => void>>();
    private destroyed = false;
    private baseConfig: HlsJsConfig | null = null;

    constructor(el: HlsJsVideoElement, options: HlsJsVideoAdapterOptions = {}) {
        this.el = el;
        this.options = options;
        this.stallSignals = new HlsStallSignals({
            onStalled: (stalled) => this.emit('stalled', { stalled }),
        });
        // The real policy arrives with the first source; until then the published defaults.
        this.ladder = new RecoveryLadder(DEFAULT_RECOVERY_POLICY, {
            recoverInPlace: (category) => this.recover(category),
            reattach: () => this.reattach(),
            requestReload: (reason, attempt) => this.emit('reload-requested', { reason, attempt }),
            onExhausted: (payload) => this.emit('error', payload),
        });
        this.attachElementListeners();
        this.attachListListeners();
        this.attachVisibilityListener();
    }

    // -- loading ------------------------------------------------------------

    /**
     * The hls.js config, built once so every source compares equal and the engine is reused across
     * angle switches. Everything per-source is read through closures at request time.
     */
    private config(): HlsJsConfig {
        if (this.baseConfig) return this.baseConfig;
        const start = initialBandwidth(this.lastSource?.bandwidthEstimate);
        this.baseConfig = {
            ...loadPolicyConfig(),
            loader: createLuminaryLoader({
                keyBytes: () => this.keyBytes,
                liveSource: () => this.options.liveSource,
            }),
            // v10's default caps the ladder to the element's size and drops it on FPS loss; the v8
            // build capped by size × device pixel ratio and never on FPS, so match that explicitly.
            capLevelToPlayerSize: false,
            capLevelOnFPSDrop: false,
            // VHS's `enableLowInitialPlaylist`: start from the lowest rendition and climb.
            startLevel: 0,
            ...(start ? { abrEwmaDefaultEstimate: start } : {}),
            ...this.options.hlsConfig,
        };
        return this.baseConfig;
    }

    async loadSource(src: AdapterSource): Promise<void> {
        this.teardownSource();
        this.lastSource = src;
        this.keyBytes = src.keyHex ? keyBytes(src.keyHex) : null;
        this.lastProgressTime = 0;
        this.ladder.setPolicy(src.recovery);
        // Resets the ladder — except for the re-munge the ladder asked for, which arrives here and
        // must not wipe the count deciding what is left.
        this.ladder.noteSourceLoaded();

        if (!isHlsEngineSupported()) {
            if (src.isBlob) {
                const error = new UnsupportedBrowserError();
                this.emit('error', { category: 'other', fatal: true, detail: error });
                throw error;
            }
            // Best effort: hand the untouched URL to the platform player.
            this.el.src = src.url;
            return;
        }

        this.retireAudioTracks();
        this.setElementSource(src.url);
    }

    private setElementSource(url: string): void {
        this.el.source = {
            src: url,
            type: HLS_MIME_TYPE,
            engine: { hlsJs: { ...this.config(), ...(this.engineGeneration ? { engineGeneration: this.engineGeneration } : {}) } },
        };
    }

    /**
     * Re-prepare the engine against the source already attached: rung 1 of the recovery obligation,
     * and the only rung a suspended runtime could still climb.
     *
     * The element rebuilds hls.js only when its engine options change, so a generation counter is
     * folded into them: the old engine is destroyed and a new one built, which is what a re-`src`
     * amounted to on VHS. Text tracks and the warming loop survive; position and play state are
     * restored here.
     */
    async reattach(): Promise<void> {
        const src = this.lastSource;
        if (this.destroyed || !src) return;

        const seekTo = this.getCurrentTime();
        const wasPlaying = !this.el.paused;

        this.cancelDeferredSeek();
        this.retireAudioTracks();
        this.engineGeneration++;
        this.setElementSource(src.url);

        if (seekTo > 0) this.seek(seekTo);
        // A refused resume is swallowed: the picture is back either way, and the viewer can press play.
        if (wasPlaying) await this.el.play().catch(() => undefined);
    }

    // -- playback -----------------------------------------------------------

    async play(): Promise<void> {
        await this.el.play();
    }

    pause(): void {
        this.el.pause();
    }

    seek(seconds: number): void {
        this.cancelDeferredSeek();
        if (this.el.readyState === 0) {
            // Nothing to seek in yet. This is the angle-switch path: the wrapper restores the
            // previous position right after a new source, and setting currentTime now is discarded.
            const handler = (): void => {
                this.deferredSeek = null;
                this.el.removeEventListener('loadedmetadata', handler);
                this.seekNow(seconds);
            };
            this.deferredSeek = handler;
            this.el.addEventListener('loadedmetadata', handler);
            return;
        }
        this.seekNow(seconds);
    }

    /**
     * A seek moves the playhead without playback having progressed, so it moves the progress
     * baseline with it — set before `currentTime`, because the browser fires `timeupdate` for the
     * seek itself, and a restored position must not read as the recovery having worked.
     */
    private seekNow(seconds: number): void {
        this.lastProgressTime = seconds;
        this.el.currentTime = seconds;
    }

    private cancelDeferredSeek(): void {
        if (!this.deferredSeek) return;
        this.el.removeEventListener('loadedmetadata', this.deferredSeek);
        this.deferredSeek = null;
    }

    getCurrentTime(): number {
        const currentTime = this.el.currentTime;
        return typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0;
    }

    getDuration(): number {
        const duration = this.el.duration;
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
    }

    setPlaybackRate(rate: number): void {
        this.el.playbackRate = rate;
    }

    // -- variants -----------------------------------------------------------

    getVariants(): AdapterVariant[] {
        const renditions = this.el.videoRenditions;
        if (!renditions) return [];
        const variants: AdapterVariant[] = [];
        for (const rendition of renditions) {
            variants.push({
                id: variantId(rendition),
                height: rendition.height || undefined,
                bandwidth: rendition.bitrate ?? 0,
            });
        }
        return variants;
    }

    setVariant(id: string | 'auto'): void {
        const engine = this.el.engine;
        const renditions = this.el.videoRenditions;
        if (!engine || !renditions) return;

        // An id matching no current rendition resolves to auto rather than to a pin nothing
        // satisfies: a stale id is the realistic way to get here (an angle switch rebuilds the
        // ladder under a pinned quality), and auto is the only outcome that leaves a watchable picture.
        let index = -1;
        if (id !== 'auto') {
            let i = 0;
            for (const rendition of renditions) {
                if (variantId(rendition) === id) {
                    index = Number(rendition.id ?? i);
                    break;
                }
                i++;
            }
        }
        engine.nextLevel = index;
    }

    // -- audio --------------------------------------------------------------

    /**
     * Marks the element's current tracks as the outgoing source's and says so, since the wrapper
     * does not otherwise hear of a `reattach()`. An empty list is also its cue that the list will be
     * rebuilt with the stream's default selected.
     */
    private retireAudioTracks(): void {
        const tracks = this.el.audioTracks;
        if (!tracks || tracks.length === 0) return;
        this.audioTracksOutgoing = true;
        this.emit('audiotracks-updated', undefined);
    }

    getAudioTracks(): AdapterAudioTrack[] {
        const tracks = this.el.audioTracks;
        if (!tracks || this.audioTracksOutgoing) return [];
        const result: AdapterAudioTrack[] = [];
        let i = 0;
        for (const track of tracks) {
            const id = track.id || `a${i}`;
            result.push({ id, lang: track.language || undefined, label: track.label || track.language || id });
            i++;
        }
        return result;
    }

    setAudioTrack(id: string): void {
        const engine = this.el.engine;
        const tracks = this.el.audioTracks;
        // The wrapper hands its choice to the new list once that arrives.
        if (!engine || !tracks || this.audioTracksOutgoing) return;
        let i = 0;
        for (const track of tracks) {
            if ((track.id || `a${i}`) === id) {
                // The element's own list writes this through to `engine.audioTrack` and disables the others.
                track.enabled = true;
                return;
            }
            i++;
        }
    }

    // -- text ---------------------------------------------------------------

    /**
     * The `<video>` the element renders into. Subtitle `<track>`s go on it directly: the browser
     * parses the WebVTT itself, which is what v8's remote text tracks amounted to.
     */
    private mediaTarget(): HTMLVideoElement | null {
        const el = this.el as unknown as { target?: HTMLVideoElement | null; shadowRoot?: ShadowRoot | null };
        return el.target ?? el.shadowRoot?.querySelector('video') ?? null;
    }

    setTextTracks(tracks: AdapterTextTrack[]): void {
        this.removeTextTracks();
        const target = this.mediaTarget();
        if (!target) return;
        for (const track of tracks) {
            const trackEl = document.createElement('track');
            trackEl.kind = 'subtitles';
            trackEl.src = track.blobUrl;
            trackEl.label = track.label;
            if (track.lang) trackEl.srclang = track.lang;
            trackEl.id = track.id;
            target.appendChild(trackEl);
            this.textTracks.set(track.id, trackEl);
        }
        this.applyActiveTextTrack();
    }

    setActiveTextTrack(id: string | null): void {
        this.activeTextTrackId = id;
        this.applyActiveTextTrack();
    }

    private applyActiveTextTrack(): void {
        for (const [id, trackEl] of this.textTracks) {
            // `track` is absent in non-browser environments (jsdom).
            if (trackEl.track) trackEl.track.mode = id === this.activeTextTrackId ? 'showing' : 'disabled';
        }
    }

    private removeTextTracks(): void {
        for (const trackEl of this.textTracks.values()) {
            if (trackEl.track) trackEl.track.mode = 'disabled';
            trackEl.remove();
        }
        this.textTracks.clear();
    }

    // -- recovery -----------------------------------------------------------

    /**
     * Rung 0 of the ladder: hls.js's own in-place primitives, which `player-web-old` already used.
     * Reporting a repair that did nothing would have the ladder stop climbing, so a category with
     * nothing to try returns false.
     */
    recover(category: AdapterErrorCategory): boolean {
        const engine = this.el.engine;
        if (!engine) return false;
        if (category === 'media') {
            engine.recoverMediaError();
            return true;
        }
        if (category === 'network') {
            engine.startLoad();
            return true;
        }
        return false;
    }

    // -- chunk warming ------------------------------------------------------

    /**
     * Arm the warming loop for the chains the wrapper just attached, replacing whatever was running;
     * an empty schedule set means stop. The loop lives here because it is paced against this media
     * element and this platform's timers — see `PlayerAdapter.warmChunks`.
     */
    warmChunks(schedules: ChunkBoundary[][], options: ChunkWarmOptions): void {
        this.prefetcher?.stop();
        this.prefetcher = null;
        if (this.destroyed || schedules.length === 0) return;

        this.prefetcher = new ChunkPrefetcher(
            {
                // Buffer front first — that is what crosses a boundary — with the playhead as the
                // floor, so a video with nothing buffered yet still warms from where it is playing.
                getWatermark: () => {
                    const buffered = this.el.buffered;
                    const front = buffered?.length ? Number(buffered.end(buffered.length - 1)) : 0;
                    return Math.max(front, this.getCurrentTime());
                },
            },
            options
        );
        this.prefetcher.start(schedules);
    }

    // -- events -------------------------------------------------------------

    on<E extends AdapterEventName>(event: E, listener: (payload: AdapterEventMap[E]) => void): Unsubscribe {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener as (payload: never) => void);
        return () => {
            set?.delete(listener as (payload: never) => void);
        };
    }

    private emit<E extends AdapterEventName>(event: E, payload: AdapterEventMap[E]): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const listener of [...set]) {
            (listener as (value: AdapterEventMap[E]) => void)(payload);
        }
    }

    /** Element events are attached once: the element re-dispatches them across every source. */
    private attachElementListeners(): void {
        const add = (type: string, handler: () => void): void => {
            this.el.addEventListener(type, handler);
            this.elementListeners.push([type, handler]);
        };
        add('timeupdate', () => {
            const currentTime = this.getCurrentTime();
            if (currentTime > this.lastProgressTime) {
                this.lastProgressTime = currentTime;
                // Real forward progress: whatever went wrong is behind us.
                this.ladder.notePlaybackHealthy();
            }
            this.stallSignals.noteTime(currentTime);
            this.emit('timeupdate', { currentTime });
            // `progress` alone is too coarse: it fires on network activity, so the band would sit
            // still while the playhead ran through media that is already buffered.
            this.emitProgress();
        });
        // The engine is built when the source loads and replaced when its options change, so
        // everything that hangs off it is re-subscribed per load.
        add('loadstart', () => this.bindEngine(this.el.engine));
        add('durationchange', () => this.emit('durationchange', { duration: this.getDuration() }));
        add('progress', () => this.emitProgress());
        add('playing', () => this.emit('playing', undefined));
        // `play` fires before buffering completes; emitting on both keeps the UI responsive.
        add('play', () => this.emit('playing', undefined));
        add('pause', () => {
            this.stallSignals.clear();
            this.emit('pause', undefined);
        });
        add('ended', () => {
            this.stallSignals.clear();
            this.emit('ended', undefined);
        });
        add('waiting', () => this.emit('waiting', undefined));
        // Seeks the adapter did not issue (the viewer's, the engine's gap skips) move the baseline too.
        add('seeking', () => {
            this.lastProgressTime = this.getCurrentTime();
        });
        add('seeked', () => {
            this.stallSignals.resetBaseline(this.getCurrentTime());
            this.emit('seeked', undefined);
        });
    }

    /**
     * Hooks everything that lives on one hls.js instance. Fatal errors go into the ladder, not out
     * to the wrapper: by contract `error` reaches the wrapper only once every rung is spent.
     */
    private bindEngine(engine: HlsEngine | null): void {
        if (engine === this.engine) return;
        this.engine?.off(Hls.Events.ERROR, this.onEngineError);
        this.stopPersistingBandwidth?.();
        this.stopPersistingBandwidth = null;
        this.engine = engine;
        this.stallSignals.attach(engine);
        if (!engine) return;
        engine.on(Hls.Events.ERROR, this.onEngineError);
        this.stopPersistingBandwidth = persistBandwidth(engine);
    }

    private readonly onEngineError = (_event: string, data: HlsErrorData): void => {
        if (!data.fatal) return;
        this.ladder.note({ category: errorCategory(data.type), fatal: true, detail: data.error ?? data });
    };

    /**
     * Catch the state store up after the runtime was frozen. Every field the wrapper publishes is
     * pushed from an adapter event, so a suspension leaves the playhead, the buffered band and the
     * transport state showing whatever they showed when the screen locked; on resume the adapter
     * says again what is true now.
     */
    private attachVisibilityListener(): void {
        if (typeof document === 'undefined') return;
        const handler = (): void => {
            if (document.visibilityState !== 'visible') {
                this.ladder.noteSuspended();
                return;
            }
            this.emitResumeState();
        };
        this.onVisibilityChange = handler;
        document.addEventListener('visibilitychange', handler);
    }

    private emitResumeState(): void {
        if (this.destroyed) return;
        const currentTime = this.getCurrentTime();
        this.lastProgressTime = currentTime;
        this.stallSignals.resetBaseline(currentTime);

        this.emit('timeupdate', { currentTime });
        this.emit('durationchange', { duration: this.getDuration() });
        this.emitProgress();
        this.emit(this.el.paused ? 'pause' : 'playing', undefined);

        // A re-munge asked for while the runtime was frozen reached nobody.
        this.ladder.noteResumed();
    }

    /**
     * The rendition and audio-track lists outlive individual sources and engines, so their change
     * events are forwarded from one subscription each rather than re-attached per load.
     */
    private attachListListeners(): void {
        const renditions = this.el.videoRenditions;
        if (renditions) {
            const onVariants = (): void => this.emit('variants-updated', undefined);
            for (const type of ['addrendition', 'removerendition', 'change'] as const) {
                renditions.addEventListener(type, onVariants);
                this.listListeners.push(() => renditions.removeEventListener(type, onVariants));
            }
        }
        const tracks = this.el.audioTracks;
        if (tracks) {
            const onAudioTracks = (): void => {
                // Torn down: whatever the element adds next is the new source's.
                if (tracks.length === 0) this.audioTracksOutgoing = false;
                this.emit('audiotracks-updated', undefined);
            };
            for (const type of ['addtrack', 'removetrack', 'change'] as const) {
                tracks.addEventListener(type, onAudioTracks);
                this.listListeners.push(() => tracks.removeEventListener(type, onAudioTracks));
            }
        }
    }

    /**
     * How far the media is continuously buffered from where it is playing. Only the range
     * containing the playhead can be played through, so that is the one reported; nought when the
     * playhead sits in a gap, which is a stall in progress.
     */
    private emitProgress(): void {
        const buffered = this.el.buffered;
        const currentTime = this.getCurrentTime();
        for (let i = 0; buffered && i < buffered.length; i++) {
            const start = Number(buffered.start(i));
            const end = Number(buffered.end(i));
            // A hair of tolerance at the seam: the playhead routinely sits a few microseconds
            // outside the range it is actually playing from.
            if (currentTime >= start - 0.1 && currentTime <= end) {
                this.emit('progress', { bufferedEnd: end });
                return;
            }
        }
        this.emit('progress', { bufferedEnd: 0 });
    }

    /** Drops everything tied to the current source, keeping the element itself. */
    private teardownSource(): void {
        // A loop that outlives its source warms chunks nothing will play; the wrapper re-arms it
        // right after the next loadSource() resolves.
        this.prefetcher?.stop();
        this.prefetcher = null;
        this.cancelDeferredSeek();
        this.stallSignals.clear();
        this.removeTextTracks();
        this.keyBytes = null;
        this.lastSource = null;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownSource();
        this.ladder.destroy();
        this.bindEngine(null);
        if (this.onVisibilityChange && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
        }
        this.onVisibilityChange = null;
        for (const [type, handler] of this.elementListeners) this.el.removeEventListener(type, handler);
        this.elementListeners = [];
        for (const detach of this.listListeners) detach();
        this.listListeners = [];
        this.activeTextTrackId = null;
        this.listeners.clear();
        // The element is not disposed: it belongs to the component that made it.
    }
}
