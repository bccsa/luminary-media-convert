import { keyBytes } from '@luminary-media-converter/player-core';
import type {
    AdapterAudioTrack,
    AdapterCapabilities,
    AdapterErrorCategory,
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
import type Player from 'video.js/dist/types/player';
import type { QualityLevel, QualityLevelList } from '../types/videojs-vhs';
import { ChunkPrefetcher } from './chunkWarming';
import { installMemoryKeyXhr } from './vhsKeyInterceptor';

/** The MIME type that routes a source to VHS rather than to the native tech. */
const HLS_MIME_TYPE = 'application/x-mpegURL';

/**
 * Thrown by {@link VideoJsAdapter.loadSource} when the browser has no Media
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
 * True when VHS can drive playback here.
 *
 * The player runs with `overrideNative: true`, so VHS — and therefore a Media
 * Source — is what plays every source, Safari included. `ManagedMediaSource` is
 * the iOS 17.1+ form of the same thing. Feature-detected rather than inferred
 * from the user agent string.
 */
export function isVideoJsEngineSupported(): boolean {
    if (typeof globalThis === 'undefined') return false;
    return 'MediaSource' in globalThis || 'ManagedMediaSource' in globalThis;
}

/** One entry of `player.audioTracks()`; video.js's own types name none of these. */
interface VjsAudioTrack {
    id?: string;
    label?: string;
    language?: string;
    enabled: boolean;
}

/** `player.audioTracks()`: array-like, and an event target for track changes. */
interface VjsAudioTrackList {
    readonly length: number;
    [index: number]: VjsAudioTrack | undefined;
    on(type: string, fn: () => void): void;
    off(type: string, fn: () => void): void;
}

/** The element `player.addRemoteTextTrack()` hands back. */
type RemoteTextTrackElement = ReturnType<Player['addRemoteTextTrack']>;

function variantId(level: Pick<QualityLevel, 'height' | 'bitrate'>): string {
    return level.height ? String(level.height) : `b${level.bitrate ?? 0}`;
}

/**
 * `MediaError` codes, which are all video.js surfaces for an engine failure.
 * VHS retries internally long before one reaches the player, so anything that
 * gets here is already terminal.
 */
function errorCategory(code: number | undefined): AdapterErrorCategory {
    if (code === 2) return 'network';
    if (code === 3 || code === 4) return 'media';
    return 'other';
}

export interface VideoJsAdapterOptions {
    /**
     * How AES-128 keys reach the engine. `'memory'` (the default) wraps VHS's
     * request factory and answers the sentinel key URI from the session key, so
     * nothing key-shaped is ever fetched or turned into a blob URL. `'url'`
     * declines that job and lets the wrapper mint a key blob URL instead — the
     * documented fallback if the VHS seam ever breaks.
     */
    keyDelivery?: 'memory' | 'url';
}

/**
 * {@link PlayerAdapter} over a caller-supplied video.js 8 player.
 *
 * The player instance belongs to the component that created it: a new source
 * goes through `player.src(...)`, never through dispose-and-recreate, so an
 * angle switch keeps one set of DOM, plugins and control bar alive. For the
 * same reason {@link destroy} detaches everything this adapter attached and
 * stops there — disposing is the component's call, after the controller has
 * gone.
 */
export class VideoJsAdapter implements PlayerAdapter {
    readonly capabilities: AdapterCapabilities;

    private readonly player: Player;
    private prefetcher: ChunkPrefetcher | null = null;
    private keyBytes: Uint8Array | null = null;
    private uninstallKeyXhr: (() => void) | null = null;
    private keyInstallHandlers: [string, () => void][] = [];
    private remoteTextTracks = new Map<string, RemoteTextTrackElement>();
    private activeTextTrackId: string | null = null;
    private deferredSeek: (() => void) | null = null;
    private playerListeners: [string, () => void][] = [];
    private listListeners: (() => void)[] = [];
    private listeners = new Map<AdapterEventName, Set<(payload: never) => void>>();
    private destroyed = false;

    constructor(player: Player, options: VideoJsAdapterOptions = {}) {
        this.player = player;
        this.capabilities = {
            nativeHls: false,
            keyDelivery: options.keyDelivery ?? 'memory',
            variantSwitching: true,
            renderText: true,
        };
        this.attachPlayerListeners();
        this.attachListListeners();
    }

    // -- loading ------------------------------------------------------------

    async loadSource(src: AdapterSource): Promise<void> {
        this.teardownSource();
        this.keyBytes = src.keyHex ? keyBytes(src.keyHex) : null;

        if (!isVideoJsEngineSupported()) {
            if (src.isBlob) {
                // Munged content (encrypted / capped / angle-pinned) simply
                // cannot be played without MSE — surface it, do not guess.
                const error = new UnsupportedBrowserError();
                this.emit('error', { category: 'other', fatal: true, detail: error });
                throw error;
            }
            // Best effort: hand the untouched URL to the platform player.
            this.player.src({ src: src.url });
            return;
        }

        if (this.capabilities.keyDelivery === 'memory') this.armKeyInstall();
        this.player.src({ src: src.url, type: HLS_MIME_TYPE });
        // Deliberately not awaiting readiness: the wrapper drives playback off
        // adapter events, and a load that never becomes ready is an error, not
        // a promise to hang on.
    }

    /**
     * Wrap the request factory of the handler the next `src()` is about to
     * create. `xhr-hooks-ready` is fired from `handleSource` the moment it
     * exists — before any playlist request goes out — and `loadstart` is the
     * fallback for a source VHS is not handling, where there is nothing to wrap
     * and nothing that would ask for a key.
     */
    private armKeyInstall(): void {
        this.disarmKeyInstall();
        const install = (): void => {
            this.disarmKeyInstall();
            this.uninstallKeyXhr = installMemoryKeyXhr(this.player, () => this.keyBytes);
        };
        this.keyInstallHandlers = [
            ['xhr-hooks-ready', install],
            ['loadstart', install],
        ];
        for (const [event, handler] of this.keyInstallHandlers) {
            this.player.one(event, handler);
        }
    }

    private disarmKeyInstall(): void {
        for (const [event, handler] of this.keyInstallHandlers) {
            this.player.off(event, handler);
        }
        this.keyInstallHandlers = [];
    }

    // -- playback -----------------------------------------------------------

    async play(): Promise<void> {
        await this.player.play();
    }

    pause(): void {
        this.player.pause();
    }

    seek(seconds: number): void {
        this.cancelDeferredSeek();
        if (this.player.readyState() === 0) {
            // Nothing to seek in yet. This is the angle-switch path: the
            // wrapper restores the previous position immediately after a
            // re-src, and setting currentTime now would be discarded.
            const handler = (): void => {
                this.deferredSeek = null;
                this.player.currentTime(seconds);
            };
            this.deferredSeek = handler;
            this.player.one('loadedmetadata', handler);
            return;
        }
        this.player.currentTime(seconds);
    }

    private cancelDeferredSeek(): void {
        if (!this.deferredSeek) return;
        this.player.off('loadedmetadata', this.deferredSeek);
        this.deferredSeek = null;
    }

    getCurrentTime(): number {
        const currentTime = this.player.currentTime();
        return typeof currentTime === 'number' && Number.isFinite(currentTime) ? currentTime : 0;
    }

    getDuration(): number {
        const duration = this.player.duration();
        return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
    }

    setPlaybackRate(rate: number): void {
        this.player.playbackRate(rate);
    }

    // -- variants -----------------------------------------------------------

    /**
     * `videojs-contrib-quality-levels` ships inside video.js, so this is present
     * in every real player — but not in a hand-rolled test double, hence the
     * feature check rather than a bare call.
     */
    private qualityLevelList(): QualityLevelList | null {
        try {
            if (typeof this.player.qualityLevels !== 'function') return null;
            return this.player.qualityLevels() ?? null;
        } catch {
            return null;
        }
    }

    getVariants(): AdapterVariant[] {
        const levels = this.qualityLevelList();
        if (!levels) return [];
        const variants: AdapterVariant[] = [];
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            if (!level) continue;
            variants.push({
                id: variantId(level),
                height: level.height || undefined,
                bandwidth: level.bitrate ?? 0,
            });
        }
        return variants;
    }

    setVariant(id: string | 'auto'): void {
        const levels = this.qualityLevelList();
        if (!levels) return;

        // What to pin, or null for "let ABR choose". An id matching no current
        // level resolves to null rather than to a pin nothing satisfies:
        // disabling every level is not a way to say "none of these" — VHS keeps
        // playing from whichever representation it happens to hold, with ABR
        // unable to move off it. A stale id is the realistic way to get here
        // (an angle switch rebuilds the ladder under a pinned quality), and
        // behaving as auto is the only outcome that leaves a watchable picture.
        let pinned: string | null = null;
        for (let i = 0; id !== 'auto' && i < levels.length; i++) {
            const level = levels[i];
            if (level && variantId(level) === id) {
                pinned = id;
                break;
            }
        }

        // VHS has no "pin this one" switch: ABR picks among the levels left
        // enabled, so pinning is enabling exactly one of them.
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            if (!level) continue;
            level.enabled = pinned === null || variantId(level) === pinned;
        }
    }

    // -- audio --------------------------------------------------------------

    private audioTrackList(): VjsAudioTrackList | null {
        try {
            if (typeof this.player.audioTracks !== 'function') return null;
            return (this.player.audioTracks() as unknown as VjsAudioTrackList | undefined) ?? null;
        } catch {
            return null;
        }
    }

    getAudioTracks(): AdapterAudioTrack[] {
        const tracks = this.audioTrackList();
        if (!tracks) return [];
        const result: AdapterAudioTrack[] = [];
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (!track) continue;
            result.push({
                id: audioTrackId(track, i),
                lang: track.language || undefined,
                label: track.label || track.language || audioTrackId(track, i),
            });
        }
        return result;
    }

    setAudioTrack(id: string): void {
        const tracks = this.audioTrackList();
        if (!tracks) return;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (!track) continue;
            // Only the match is touched: the list itself disables the others,
            // and writing false first would leave a frame with no audio track.
            if (audioTrackId(track, i) === id) track.enabled = true;
        }
    }

    // -- text ---------------------------------------------------------------

    setTextTracks(tracks: AdapterTextTrack[]): void {
        this.removeRemoteTextTracks();
        for (const track of tracks) {
            const el = this.player.addRemoteTextTrack(
                {
                    kind: 'subtitles',
                    src: track.blobUrl,
                    label: track.label,
                    srclang: track.lang,
                    id: track.id,
                },
                // Manual cleanup: these belong to the source, and the adapter
                // takes them away itself on the next load.
                true,
            );
            this.remoteTextTracks.set(track.id, el);
        }
        this.applyActiveTextTrack();
    }

    setActiveTextTrack(id: string | null): void {
        this.activeTextTrackId = id;
        this.applyActiveTextTrack();
    }

    private applyActiveTextTrack(): void {
        for (const [id, el] of this.remoteTextTracks) {
            // `track` is absent in non-browser environments (jsdom).
            const textTrack = (el as { track?: TextTrack }).track;
            if (textTrack) textTrack.mode = id === this.activeTextTrackId ? 'showing' : 'disabled';
        }
    }

    private removeRemoteTextTracks(): void {
        for (const el of this.remoteTextTracks.values()) {
            this.player.removeRemoteTextTrack(el as unknown as object);
        }
        this.remoteTextTracks.clear();
    }

    // -- recovery -----------------------------------------------------------

    /**
     * Always false. VHS exposes no in-place recovery primitive — it has already
     * exhausted its own retries by the time an error surfaces — so the wrapper
     * escalates straight to a reload through {@link loadSource}, which re-srcs
     * the player. That re-src *is* the recovery.
     */
    recover(_category: AdapterErrorCategory): boolean {
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
                    const buffered = this.player.buffered();
                    const front = buffered?.length
                        ? Number(buffered.end(buffered.length - 1))
                        : 0;
                    return Math.max(front, this.getCurrentTime());
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

    /**
     * Player events are attached once, in the constructor: video.js re-emits
     * them across every `src()`, so nothing has to be re-wired per source.
     */
    private attachPlayerListeners(): void {
        const add = (type: string, handler: () => void): void => {
            this.player.on(type, handler);
            this.playerListeners.push([type, handler]);
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
        add('error', () => {
            const error = this.player.error();
            this.emit('error', {
                category: errorCategory(error?.code),
                // Everything that reaches the player element is terminal: VHS
                // has already spent its own retries getting here.
                fatal: true,
                detail: error ?? undefined,
            });
        });
    }

    private detachPlayerListeners(): void {
        for (const [type, handler] of this.playerListeners) {
            this.player.off(type, handler);
        }
        this.playerListeners = [];
    }

    /**
     * The quality-level and audio-track lists outlive individual sources, so
     * their change events are forwarded from one subscription each rather than
     * re-attached per load.
     */
    private attachListListeners(): void {
        const levels = this.qualityLevelList();
        if (levels) {
            const onVariants = (): void => this.emit('variants-updated', undefined);
            for (const type of ['addqualitylevel', 'change']) {
                levels.on(type, onVariants);
                this.listListeners.push(() => levels.off(type, onVariants));
            }
        }

        const tracks = this.audioTrackList();
        if (tracks) {
            const onAudioTracks = (): void => this.emit('audiotracks-updated', undefined);
            for (const type of ['addtrack', 'removetrack', 'change']) {
                tracks.on(type, onAudioTracks);
                this.listListeners.push(() => tracks.off(type, onAudioTracks));
            }
        }
    }

    private detachListListeners(): void {
        for (const detach of this.listListeners) detach();
        this.listListeners = [];
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
        const buffered = this.player.buffered();
        const currentTime = this.getCurrentTime();
        for (let i = 0; buffered && i < buffered.length; i++) {
            const start = Number(buffered.start(i));
            const end = Number(buffered.end(i));
            // A hair of tolerance at the seam: the playhead routinely sits a
            // few microseconds outside the range it is actually playing from.
            if (currentTime >= start - 0.1 && currentTime <= end) {
                this.emit('progress', { bufferedEnd: end });
                return;
            }
        }
        this.emit('progress', { bufferedEnd: 0 });
    }

    /** Drops everything tied to the current source, keeping the player itself. */
    private teardownSource(): void {
        // A loop that outlives its source warms chunks nothing will play; the
        // wrapper re-arms it right after the next loadSource() resolves.
        this.prefetcher?.stop();
        this.prefetcher = null;
        this.cancelDeferredSeek();
        this.disarmKeyInstall();
        this.uninstallKeyXhr?.();
        this.uninstallKeyXhr = null;
        this.removeRemoteTextTracks();
        this.keyBytes = null;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownSource();
        this.detachPlayerListeners();
        this.detachListListeners();
        this.activeTextTrackId = null;
        this.listeners.clear();
        // The player is not disposed: it belongs to the component that made it,
        // which tears it down after the controller has finished with it.
    }
}

/** Stable id for an audio track; video.js leaves `id` empty on some techs. */
function audioTrackId(track: VjsAudioTrack, index: number): string {
    return track.id || `a${index}`;
}
