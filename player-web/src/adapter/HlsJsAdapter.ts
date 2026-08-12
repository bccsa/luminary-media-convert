import Hls from 'hls.js';
import type {
    ErrorData,
    HlsConfig,
    Level,
    Loader,
    LoaderCallbacks,
    LoaderConfiguration,
    LoaderContext,
    MediaPlaylist,
} from 'hls.js';
import { LUMINARY_KEY_PLACEHOLDER_URI, keyBytes } from '@luminary-media-converter/player-core';
import type {
    AdapterAudioTrack,
    AdapterCapabilities,
    AdapterErrorCategory,
    AdapterErrorPayload,
    AdapterEventMap,
    AdapterEventName,
    AdapterSource,
    AdapterTextTrack,
    AdapterVariant,
    ChunkBoundary,
    ChunkWarmOptions,
    PlayerAdapter,
    Unsubscribe,
} from '@luminary-media-converter/player-core';
import { ChunkPrefetcher } from './chunkWarming';

/** Attribute used to correlate a `<track>` element with its adapter track id. */
const TRACK_ID_ATTR = 'data-luminary-track-id';

/**
 * Thrown by {@link HlsJsAdapter.loadSource} when the browser has no Media
 * Source implementation and the source *requires* munged playback (a blob
 * master: encrypted, quality-capped or angle-pinned). The wrapper maps the
 * `code` onto `PlayerError{ code: 'unsupported-browser', fatal: true }`.
 */
export class UnsupportedBrowserError extends Error {
    readonly code = 'unsupported-browser' as const;

    constructor(message = 'This browser cannot play munged HLS content.') {
        super(message);
        this.name = 'UnsupportedBrowserError';
    }
}

/**
 * True when hls.js can drive playback here.
 *
 * hls.js's own check already prefers `ManagedMediaSource` where it exists
 * (iOS 17.1+); the second clause is a belt-and-braces feature detect so the
 * decision is never made from the user agent string.
 */
export function isHlsEngineSupported(): boolean {
    try {
        if (Hls.isSupported()) return true;
    } catch {
        /* engine unavailable in this environment */
    }
    return typeof globalThis !== 'undefined' && 'ManagedMediaSource' in globalThis;
}

/**
 * Recognizes the sentinel key URI the wrapper normalizes every AES-128
 * `URI="…"` to. Tolerates the trailing slash a URL resolver may append.
 */
function isKeyPlaceholder(url: string): boolean {
    return url === LUMINARY_KEY_PLACEHOLDER_URI || url === `${LUMINARY_KEY_PLACEHOLDER_URI}/`;
}

type LoaderConstructor = { new (config: HlsConfig): Loader<LoaderContext> };

/**
 * Wraps hls.js's loader so AES-128 key requests for the sentinel URI
 * are answered from memory with the session key bytes — synchronously, without
 * a network request and without ever minting a key blob URL. Every other
 * request (playlists, fragments, real key URLs) falls through to the base
 * loader untouched.
 */
export function createMemoryKeyLoader(
    Base: LoaderConstructor,
    getKeyBytes: () => Uint8Array | null,
): LoaderConstructor {
    return class MemoryKeyLoader extends Base {
        override load(
            context: LoaderContext,
            config: LoaderConfiguration,
            callbacks: LoaderCallbacks<LoaderContext>,
        ): void {
            if (!isKeyPlaceholder(context.url)) {
                super.load(context, config, callbacks);
                return;
            }

            this.context = context;
            const stats = this.stats;
            const key = getKeyBytes();

            if (!key || key.byteLength === 0) {
                callbacks.onError(
                    { code: 0, text: 'No session key available for the in-memory key loader' },
                    context,
                    null,
                    stats,
                );
                return;
            }

            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            stats.loading.start = stats.loading.first = stats.loading.end = now;
            stats.loaded = stats.total = key.byteLength;

            // Copy into a standalone ArrayBuffer: hls.js keeps the result.
            const data = key.slice().buffer;
            callbacks.onSuccess({ url: context.url, data, code: 200 }, stats, context, null);
        }
    };
}

function variantId(level: Pick<Level, 'height' | 'bitrate'>): string {
    return level.height ? String(level.height) : `b${level.bitrate}`;
}

function errorCategory(type: string): AdapterErrorCategory {
    if (type === Hls.ErrorTypes.NETWORK_ERROR) return 'network';
    if (type === Hls.ErrorTypes.MEDIA_ERROR) return 'media';
    return 'other';
}

export interface HlsJsAdapterOptions {
    /** Extra hls.js config merged under the adapter's own settings. */
    hlsConfig?: Partial<HlsConfig>;
}

/**
 * {@link PlayerAdapter} over hls.js driving a caller-supplied `<video>`.
 *
 * Owns intra-source ABR (`levels`/`currentLevel`), audio-track selection,
 * native `<track>` rendering and the first-line recovery primitives. All
 * policy (retries, backoff, stall detection, polling) stays in the wrapper.
 */
export class HlsJsAdapter implements PlayerAdapter {
    readonly capabilities: AdapterCapabilities = {
        nativeHls: false,
        keyDelivery: 'memory',
        variantSwitching: true,
        renderText: true,
    };

    private readonly video: HTMLVideoElement;
    private readonly hlsConfig: Partial<HlsConfig>;
    private hls: Hls | null = null;
    private prefetcher: ChunkPrefetcher | null = null;
    private keyBytes: Uint8Array | null = null;
    private trackEls: HTMLTrackElement[] = [];
    private activeTextTrackId: string | null = null;
    private mediaListeners: [string, EventListener][] = [];
    private listeners = new Map<AdapterEventName, Set<(payload: never) => void>>();
    private destroyed = false;

    constructor(video: HTMLVideoElement, options: HlsJsAdapterOptions = {}) {
        this.video = video;
        this.hlsConfig = options.hlsConfig ?? {};
    }

    // -- loading ------------------------------------------------------------

    async loadSource(src: AdapterSource): Promise<void> {
        this.teardownEngine();
        this.keyBytes = src.keyHex ? keyBytes(src.keyHex) : null;

        if (!isHlsEngineSupported()) {
            if (src.isBlob) {
                // Munged content (encrypted / capped / angle-pinned) simply
                // cannot be played without MSE — surface it, do not guess.
                const error = new UnsupportedBrowserError();
                this.emit('error', { category: 'other', fatal: true, detail: error });
                throw error;
            }
            // Best effort: hand the untouched URL to the platform player.
            this.video.src = src.url;
            this.attachMediaListeners();
            return;
        }

        const baseLoader = (this.hlsConfig.loader ?? Hls.DefaultConfig.loader) as LoaderConstructor;
        const hls = new Hls({
            preferManagedMediaSource: true,
            ...this.hlsConfig,
            loader: createMemoryKeyLoader(baseLoader, () => this.keyBytes),
        });
        this.hls = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, this.onVariantsUpdated);
        hls.on(Hls.Events.LEVELS_UPDATED, this.onVariantsUpdated);
        hls.on(Hls.Events.LEVEL_SWITCHED, this.onVariantsUpdated);
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, this.onAudioTracksUpdated);
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, this.onAudioTracksUpdated);
        hls.on(Hls.Events.ERROR, this.onHlsError);

        this.attachMediaListeners();
        hls.attachMedia(this.video);
        hls.loadSource(src.url);
    }

    private onVariantsUpdated = (): void => {
        this.emit('variants-updated', undefined);
    };

    private onAudioTracksUpdated = (): void => {
        this.emit('audiotracks-updated', undefined);
    };

    private onHlsError = (_event: unknown, data: ErrorData): void => {
        const payload: AdapterErrorPayload = {
            category: errorCategory(data.type),
            fatal: Boolean(data.fatal),
            detail: data,
        };
        this.emit('error', payload);
    };

    // -- playback -----------------------------------------------------------

    async play(): Promise<void> {
        await this.video.play();
    }

    pause(): void {
        this.video.pause();
    }

    seek(seconds: number): void {
        this.video.currentTime = seconds;
    }

    getCurrentTime(): number {
        return Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    }

    getDuration(): number {
        const duration = this.video.duration;
        return Number.isFinite(duration) ? duration : 0;
    }

    setPlaybackRate(rate: number): void {
        this.video.playbackRate = rate;
    }

    // -- variants -----------------------------------------------------------

    getVariants(): AdapterVariant[] {
        const levels = this.hls?.levels ?? [];
        return levels.map((level) => ({
            id: variantId(level),
            height: level.height || undefined,
            bandwidth: level.bitrate,
        }));
    }

    setVariant(id: string | 'auto'): void {
        if (!this.hls) return;
        if (id === 'auto') {
            this.hls.currentLevel = -1;
            return;
        }
        const index = this.hls.levels.findIndex((level) => variantId(level) === id);
        if (index >= 0) this.hls.currentLevel = index;
    }

    // -- audio --------------------------------------------------------------

    getAudioTracks(): AdapterAudioTrack[] {
        const tracks: MediaPlaylist[] = this.hls?.audioTracks ?? [];
        return tracks.map((track) => ({
            id: String(track.id),
            lang: track.lang,
            label: track.name,
        }));
    }

    setAudioTrack(id: string): void {
        if (!this.hls) return;
        const track = this.hls.audioTracks.find((candidate) => String(candidate.id) === id);
        if (track) this.hls.audioTrack = track.id;
    }

    // -- text ---------------------------------------------------------------

    setTextTracks(tracks: AdapterTextTrack[]): void {
        this.removeTrackElements();
        for (const track of tracks) {
            const el = this.video.ownerDocument.createElement('track');
            el.kind = 'subtitles';
            el.src = track.blobUrl;
            el.label = track.label;
            if (track.lang) el.srclang = track.lang;
            el.setAttribute(TRACK_ID_ATTR, track.id);
            this.video.appendChild(el);
            this.trackEls.push(el);
        }
        this.applyActiveTextTrack();
    }

    setActiveTextTrack(id: string | null): void {
        this.activeTextTrackId = id;
        this.applyActiveTextTrack();
    }

    private applyActiveTextTrack(): void {
        for (const el of this.trackEls) {
            const active = el.getAttribute(TRACK_ID_ATTR) === this.activeTextTrackId;
            // `track` is absent in non-browser environments (jsdom).
            const textTrack: TextTrack | undefined = el.track;
            if (textTrack) textTrack.mode = active ? 'showing' : 'disabled';
        }
    }

    private removeTrackElements(): void {
        for (const el of this.trackEls) el.remove();
        this.trackEls = [];
    }

    // -- recovery -----------------------------------------------------------

    recover(category: AdapterErrorCategory): boolean {
        if (!this.hls) return false;
        if (category === 'media') {
            this.hls.recoverMediaError();
            return true;
        }
        if (category === 'network') {
            this.hls.startLoad();
            return true;
        }
        return false;
    }

    // -- chunk warming ------------------------------------------------------

    /**
     * Arm the warming loop for the chains the wrapper just attached, replacing
     * whatever was running before; an empty schedule set means stop (the
     * wrapper's way of saying the source is gone or warming is off).
     *
     * The loop lives here rather than in the wrapper because it is paced
     * against this media element and this platform's timers — see
     * `PlayerAdapter.warmChunks` for the contract a native adapter reimplements.
     */
    warmChunks(schedules: ChunkBoundary[][], options: ChunkWarmOptions): void {
        this.prefetcher?.stop();
        this.prefetcher = null;
        if (this.destroyed || schedules.length === 0) return;

        this.prefetcher = new ChunkPrefetcher(
            {
                // Buffer front first — that is what crosses a boundary — with
                // the playhead as the floor, so a video with nothing buffered
                // yet still warms from where it is playing.
                getWatermark: () => {
                    const buffered = this.video.buffered;
                    return Math.max(
                        buffered.length ? buffered.end(buffered.length - 1) : 0,
                        this.video.currentTime,
                    );
                },
            },
            options,
        );
        this.prefetcher.start(schedules);
    }

    // -- events -------------------------------------------------------------

    on<E extends AdapterEventName>(
        event: E,
        listener: (payload: AdapterEventMap[E]) => void,
    ): Unsubscribe {
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

    private attachMediaListeners(): void {
        if (this.mediaListeners.length > 0) return;
        const add = (type: string, handler: EventListener): void => {
            this.video.addEventListener(type, handler);
            this.mediaListeners.push([type, handler]);
        };
        add('timeupdate', () => {
            this.emit('timeupdate', { currentTime: this.getCurrentTime() });
            // `progress` alone is too coarse: it fires on network activity, so
            // the band would sit still while the playhead ran through media
            // that is already buffered.
            this.emitProgress();
        });
        add('durationchange', () => this.emit('durationchange', { duration: this.getDuration() }));
        add('progress', () => this.emitProgress());
        add('playing', () => this.emit('playing', undefined));
        // `play` fires before buffering completes; emitting on both keeps the
        // UI responsive. Consumers treat `playing` as idempotent.
        add('play', () => this.emit('playing', undefined));
        add('pause', () => this.emit('pause', undefined));
        add('ended', () => this.emit('ended', undefined));
        add('waiting', () => this.emit('waiting', undefined));
        add('seeked', () => this.emit('seeked', undefined));
    }

    /**
     * How far the media is continuously buffered from where it is playing.
     *
     * `buffered` holds one range per contiguous run, and a seek leaves gaps: the
     * furthest range may sit well ahead of the playhead with nothing between.
     * Only the range containing the playhead can be played through, so that is
     * the one reported — anything else draws a promise the engine cannot keep.
     * Nought when the playhead sits in a gap, which is a stall in progress.
     */
    private emitProgress(): void {
        const { buffered, currentTime } = this.video;
        for (let i = 0; i < buffered.length; i++) {
            // A hair of tolerance at the seam: the playhead routinely sits a
            // few microseconds outside the range it is actually playing from.
            if (currentTime >= buffered.start(i) - 0.1 && currentTime <= buffered.end(i)) {
                this.emit('progress', { bufferedEnd: buffered.end(i) });
                return;
            }
        }
        this.emit('progress', { bufferedEnd: 0 });
    }

    private detachMediaListeners(): void {
        for (const [type, handler] of this.mediaListeners) {
            this.video.removeEventListener(type, handler);
        }
        this.mediaListeners = [];
    }

    /** Tears the engine down but keeps registered adapter listeners alive. */
    private teardownEngine(): void {
        // A loop that outlives its source warms chunks nothing will play; the
        // wrapper re-arms it right after the next loadSource() resolves.
        this.prefetcher?.stop();
        this.prefetcher = null;
        this.detachMediaListeners();
        this.removeTrackElements();
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.keyBytes = null;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownEngine();
        this.activeTextTrackId = null;
        this.listeners.clear();
        this.video.removeAttribute('src');
    }
}
