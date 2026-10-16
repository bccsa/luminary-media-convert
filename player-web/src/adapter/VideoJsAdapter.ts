import { keyBytes } from '@luminary-media-converter/player-core';
import {
    DEFAULT_RECOVERY_POLICY,
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
import type Player from 'video.js/dist/types/player';
import type { QualityLevel, QualityLevelList } from '../types/videojs-vhs';
import { RecoveryLadder } from '../drivers/RecoveryLadder';
import { ChunkPrefetcher } from './chunkWarming';
import type { LivePlaylistSource } from '../serve/livePlaylistUri';
import { installMemoryKeyXhr } from './vhsKeyInterceptor';
import { installLivePlaylistXhr } from './vhsLivePlaylistInterceptor';
import { installByteRangeTimeout } from './vhsRequestTimeout';
import { VhsStallSignals } from './vhsStallSignals';
import { vhsHandler, vhsTech } from './vhsXhrSeam';

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
    /**
     * Who answers the `luminary://live/…` URIs a live source's munged master
     * names — the `BlobServeStrategy` handed to the controller, which minted
     * them. Without one, a live source still loads (the strategy decides
     * that) but VHS cannot fetch its media playlists.
     */
    liveSource?: LivePlaylistSource;
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
    private readonly liveSource: LivePlaylistSource | undefined;
    private prefetcher: ChunkPrefetcher | null = null;
    private keyBytes: Uint8Array | null = null;
    private sourceHookHandlers: [string, () => void][] = [];
    private readonly stallSignals: VhsStallSignals;
    private readonly ladder: RecoveryLadder;
    /** The source currently attached — what {@link reattach} re-prepares against. */
    private lastSource: AdapterSource | null = null;
    /**
     * What this adapter last handed `player.src()`, so that video.js's record of
     * its source can be put back when video.js loses it. Null while no source
     * is attached.
     */
    private playerSource: { src: string; type?: string } | null = null;
    /** Puts back the player's own `load()`; see {@link guardLoad}. */
    private restoreLoad: (() => void) | null = null;
    /** Where forward progress is measured from: the furthest played position since the last seek. */
    private lastProgressTime = 0;
    private onVisibilityChange: (() => void) | null = null;
    private remoteTextTracks = new Map<string, RemoteTextTrackElement>();
    private activeTextTrackId: string | null = null;
    /**
     * The engine's audio tracks still belong to the source being replaced.
     *
     * video.js swaps sources a tick after `src()`, and until then the outgoing
     * VHS handler is alive with its tracks in the list. A track selected there
     * is loaded by that handler, from a playlist URL the wrapper revoked when
     * the new load began; the request fails, VHS falls back to the stream's
     * default, and the default is what gets carried into the new source. So the
     * list reads as empty, and selections are refused, until video.js has torn
     * it down.
     */
    private audioTracksOutgoing = false;
    private deferredSeek: (() => void) | null = null;
    private playerListeners: [string, () => void][] = [];
    private listListeners: (() => void)[] = [];
    private listeners = new Map<AdapterEventName, Set<(payload: never) => void>>();
    private destroyed = false;

    constructor(player: Player, options: VideoJsAdapterOptions = {}) {
        this.player = player;
        this.liveSource = options.liveSource;
        this.capabilities = {
            nativeHls: false,
            keyDelivery: options.keyDelivery ?? 'memory',
            variantSwitching: true,
            renderText: true,
        };
        this.stallSignals = new VhsStallSignals({
            onStalled: (stalled) => this.emit('stalled', { stalled }),
            // VHS nudged three times and the engine did not move. That is a
            // wedge, not a transient fault, and it goes to the ladder like any
            // other — which will re-attach before asking anyone to re-munge.
            onWedged: (detail) =>
                this.ladder.note(
                    { category: 'media', fatal: true, detail },
                    'wedged',
                ),
        });
        // The real policy arrives with the first source; until then the
        // published defaults, so an error before any load still climbs sanely.
        this.ladder = new RecoveryLadder(DEFAULT_RECOVERY_POLICY, {
            recoverInPlace: (category) => this.recover(category),
            reattach: () => this.reattach(),
            requestReload: (reason, attempt) =>
                this.emit('reload-requested', { reason, attempt }),
            onExhausted: (payload) => this.emit('error', payload),
        });
        this.attachPlayerListeners();
        this.attachListListeners();
        this.attachVisibilityListener();
        this.guardLoad();
        this.stallSignals.attach(vhsTech(this.player));
    }

    // -- loading ------------------------------------------------------------

    async loadSource(src: AdapterSource): Promise<void> {
        this.teardownSource();
        this.lastSource = src;
        this.keyBytes = src.keyHex ? keyBytes(src.keyHex) : null;
        this.lastProgressTime = 0;
        this.ladder.setPolicy(src.recovery);
        // Resets the ladder — except for the re-munge the ladder asked for,
        // which arrives here and must not wipe the count deciding what is left.
        this.ladder.noteSourceLoaded();

        this.dropCarriedTextTracks();

        if (!isVideoJsEngineSupported()) {
            if (src.isBlob) {
                // Munged content (encrypted / capped / angle-pinned) simply
                // cannot be played without MSE — surface it, do not guess.
                const error = new UnsupportedBrowserError();
                this.emit('error', { category: 'other', fatal: true, detail: error });
                throw error;
            }
            // Best effort: hand the untouched URL to the platform player.
            this.playerSource = { src: src.url };
            this.player.src({ ...this.playerSource });
            return;
        }

        this.armSourceHooks();
        this.retireAudioTracks();
        this.playerSource = { src: src.url, type: HLS_MIME_TYPE };
        this.player.src({ ...this.playerSource });
        // Deliberately not awaiting readiness: the wrapper drives playback off
        // adapter events, and a load that never becomes ready is an error, not
        // a promise to hang on.
    }

    /**
     * Re-prepare the engine against the source already attached: rung 1 of the
     * recovery obligation, and the only rung a suspended runtime could still
     * climb, since nothing outside this adapter is involved.
     *
     * A re-src is what recovery has always amounted to on VHS — the wrapper's
     * old reload re-munged first, but for an unchanged selection that produced
     * byte-identical playlists behind fresh URLs, so only the engine being
     * rebuilt ever mattered. Video.js's own `reloadSourceOnError` plugin is the
     * reference for the mechanics (capture the position, re-src, restore on
     * `loadedmetadata`, play); it is not the implementation, because it has no
     * attempt cap and a wall-clock interval, so it would retry a permanent
     * failure every thirty seconds for as long as the page is open.
     *
     * What must survive: the remote text tracks (added with manual cleanup,
     * they outlive a `src()`) and the warming loop (the chunk chains have not
     * changed). What must be re-armed: the VHS seam wrappers, since a re-src
     * builds a fresh handler with a fresh request factory.
     */
    async reattach(): Promise<void> {
        const src = this.lastSource;
        if (this.destroyed || !src) return;

        const seekTo = this.getCurrentTime();
        const wasPlaying = !this.player.paused();

        this.cancelDeferredSeek();
        this.armSourceHooks();
        this.retireAudioTracks();
        this.playerSource = { src: src.url, type: HLS_MIME_TYPE };
        this.player.src({ ...this.playerSource });

        if (seekTo > 0) this.seek(seekTo);
        // `play()` answers `undefined` on techs with no promise support, so the
        // optional call — the same idiom `keepAlive` uses. A refused resume is
        // swallowed: the picture is back either way, and the viewer can press play.
        if (wasPlaying) await this.player.play()?.catch(() => undefined);
    }

    /**
     * Wrap the request factory of the handler the next `src()` is about to
     * create: the byte-range timeout backstop always, in-memory key delivery
     * when this adapter has claimed that job, and live playlist refresh when a
     * live source was supplied. `xhr-hooks-ready` is
     * fired from `handleSource` the moment the handler exists — before any
     * playlist request goes out — and `loadstart` is the fallback for a source
     * VHS is not handling, where there is nothing to wrap.
     *
     * The wrappers are never uninstalled: they live and die with the handler
     * they wrap, and every handler is disposed by the transition that replaces
     * it. See `teardownSource` for why that is the point. So the key is the one
     * this source was given, captured here, rather than whatever the adapter
     * holds by the time a late request for it arrives.
     *
     * Coming back from YouTube, the handler cannot be reached when it is
     * announced. video.js builds the new Html5 tech with the source already in
     * hand, its constructor sets it, and VHS fires `xhr-hooks-ready` from in
     * there — before the player has been given the tech that holds the
     * handler. Wrapping then found nothing, and every `luminary://` request of
     * that source went to the network: a live source's playlists, an encrypted
     * one's key. The handler is reachable a microtask later, and the one request
     * out by then is the master's, which no wrapper answers.
     */
    private armSourceHooks(): void {
        this.disarmSourceHooks();
        const keyBytes = this.keyBytes;
        const wrap = (): void => {
            installByteRangeTimeout(this.player);
            if (this.capabilities.keyDelivery === 'memory') {
                installMemoryKeyXhr(this.player, () => keyBytes);
            }
            if (this.liveSource) {
                installLivePlaylistXhr(this.player, this.liveSource);
            }
        };
        const install = (): void => {
            this.disarmSourceHooks();
            if (vhsHandler(this.player)) wrap();
            else queueMicrotask(wrap);
        };
        const onHooksReady = (): void => {
            this.clearReplacedSources();
            install();
        };
        this.sourceHookHandlers = [
            ['xhr-hooks-ready', onHooksReady],
            ['loadstart', install],
        ];
        for (const [event, handler] of this.sourceHookHandlers) {
            this.player.one(event, handler);
        }
    }

    private disarmSourceHooks(): void {
        for (const [event, handler] of this.sourceHookHandlers) {
            this.player.off(event, handler);
        }
        this.sourceHookHandlers = [];
    }

    /**
     * Drops the text tracks another tech is carrying, before a source hands the
     * player back to Html5.
     *
     * video.js carries text tracks from one tech to the next as JSON, cues and
     * all, and puts the cues back with `addCue` — which a native text track,
     * as Safari's are, refuses when handed a plain object. So VHS's metadata
     * track, filled by an HLS source and carried through YouTube, threw in the
     * middle of the swap back to Html5. The swap was never finished: the tech
     * was left without its event wiring, `changingSrc_` stayed set, and every
     * play after it waited on a load that had already happened. The tracks
     * belong to a source long gone; this one's are added after it loads.
     */
    private dropCarriedTextTracks(): void {
        if ((this.player as unknown as { techName_?: string }).techName_ === 'Html5') return;
        const tech = vhsTech(this.player) as { clearTracks?(types: string): void } | null;
        tech?.clearTracks?.('text');
    }

    /**
     * Takes the outgoing handler's `<source>` elements off the media element,
     * before the handler replacing it adds its own.
     *
     * On Safari and iOS, VHS attaches its MediaSource through `<source>`
     * elements — its own URL, and the playlist's for AirPlay — rather than
     * `src`, and never removes them. An element already playing does not look
     * at a `<source>` added to it, so each new source's were stacked behind the
     * last one's and never chosen: an angle switch, the audio toggle, a
     * recovery re-attach or a new load played the old stream out to its end
     * and stopped. `xhr-hooks-ready` falls between the two, with the old handler
     * disposed and the new one not yet attached. A tech built for this source,
     * on the way back from YouTube, has a fresh element, and is not reachable
     * at this point anyway.
     */
    private clearReplacedSources(): void {
        const tech = vhsTech(this.player) as { el?(): Element | null; reset?(): void } | null;
        if (!tech?.el?.()?.querySelector('source')) return;
        // The Html5 tech's own reset: every `<source>` and the `src` removed,
        // and the element reloaded empty.
        tech.reset?.();
    }

    /**
     * Puts video.js's record of its source back to the one this adapter set,
     * when video.js has lost it.
     *
     * video.js keeps that record (`currentSource()`) and trusts it: `play()`
     * refuses to start without one, and `load()` rebuilds the engine from it.
     * It rewrites it from every `sourceset` the tech reports once no source
     * change is under way, skipping VHS's MediaSource URL only when the
     * player's own source is not a blob — a guess that fails for a munged
     * master, which always is one. A tech built on the way back from YouTube
     * reports, once it is ready, the empty source it started with, so the
     * record became empty, and in Safari every play that followed rebuilt the
     * engine from nothing: "No compatible source was found for this media".
     */
    private keepSourceRecorded(): void {
        const source = this.playerSource;
        // video.js types `currentSource()` as a Tech; it is a source object.
        const recorded = this.player.currentSource() as unknown as { src?: string };
        if (!source || recorded.src === source.src) return;
        (this.player as unknown as { updateSourceCaches_(source: object): void })
            .updateSourceCaches_({ ...source });
    }

    /**
     * Makes video.js's `load()` do nothing while this adapter plays a source
     * through VHS.
     *
     * For a VHS source, `load()` is `src(currentSource())`: the engine rebuilt
     * from video.js's record of the source, behind this adapter. Safari calls
     * it from `play()` whenever a source change is under way — priming the
     * element, which is native playback's concern — and a switch that resumes
     * playback, whether an angle, the audio toggle or a recovery re-attach,
     * plays right after its own `src()`. The rebuilt handler was one this
     * adapter never wrapped, so its key and live-playlist requests went to the
     * network and playback stopped. Declining loses nothing: video.js has
     * already queued that `play()` for the source's `loadstart`. A source
     * played natively keeps video.js's own `load()`.
     */
    private guardLoad(): void {
        const player = this.player;
        const hadOwn = Object.prototype.hasOwnProperty.call(player, 'load');
        const original = player.load;
        player.load = () => {
            if (this.playerSource?.type === HLS_MIME_TYPE) return;
            original?.call(player);
        };
        this.restoreLoad = () => {
            if (hadOwn) player.load = original;
            else delete (player as { load?: unknown }).load;
        };
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
                this.seekNow(seconds);
            };
            this.deferredSeek = handler;
            this.player.one('loadedmetadata', handler);
            return;
        }
        this.seekNow(seconds);
    }

    /**
     * A seek moves the playhead without playback having progressed, so it moves
     * the progress baseline with it. Set before `currentTime`, because the
     * browser fires `timeupdate` for the seek itself — and a position restored
     * after a re-munge must not read as the recovery having worked.
     */
    private seekNow(seconds: number): void {
        this.lastProgressTime = seconds;
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

    /**
     * Marks the engine's current tracks as the outgoing source's — see
     * {@link audioTracksOutgoing} — and says so, since the wrapper does not
     * otherwise hear of a `reattach()`. An empty list is also its cue that the
     * list will be rebuilt with the stream's default selected.
     */
    private retireAudioTracks(): void {
        const tracks = this.audioTrackList();
        if (!tracks || tracks.length === 0) return;
        this.audioTracksOutgoing = true;
        this.emit('audiotracks-updated', undefined);
    }

    getAudioTracks(): AdapterAudioTrack[] {
        const tracks = this.audioTrackList();
        if (!tracks || this.audioTracksOutgoing) return [];
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
        // The wrapper hands its choice to the new list once that arrives.
        if (!tracks || this.audioTracksOutgoing) return;
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
     * exhausted its own retries by the time an error surfaces, and its stall
     * handling ({@link VhsStallSignals}) has already nudged — so rung 0 of the
     * ladder is declined and it goes straight to {@link reattach}.
     *
     * Saying so plainly matters: reporting a repair that did nothing would have
     * the ladder believe it and stop climbing.
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
            const currentTime = this.getCurrentTime();
            if (currentTime > this.lastProgressTime) {
                this.lastProgressTime = currentTime;
                // Real forward progress: whatever went wrong is behind us.
                this.ladder.notePlaybackHealthy();
            }
            this.stallSignals.noteTime(currentTime);
            this.emit('timeupdate', { currentTime });
            // `progress` alone is too coarse: it fires on network activity, so
            // the band would sit still while the playhead ran through media
            // that is already buffered.
            this.emitProgress();
        });
        // The tech is created with the first source and can be swapped by a
        // later one (YouTube), so the stall verdicts are re-subscribed per load.
        add('loadstart', () => this.stallSignals.attach(vhsTech(this.player)));
        add('sourceset', () => this.keepSourceRecorded());
        add('durationchange', () => this.emit('durationchange', { duration: this.getDuration() }));
        add('progress', () => this.emitProgress());
        add('playing', () => this.emit('playing', undefined));
        // `play` fires before buffering completes; emitting on both keeps the
        // UI responsive. Consumers treat `playing` as idempotent.
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
        // Seeks the adapter did not issue (the viewer's, VHS's gap skips) move
        // the baseline too. `seeking` precedes the seek's `timeupdate`.
        add('seeking', () => {
            this.lastProgressTime = this.getCurrentTime();
        });
        add('seeked', () => {
            this.stallSignals.resetBaseline(this.getCurrentTime());
            this.emit('seeked', undefined);
        });
        add('error', () => {
            const error = this.player.error();
            // Into the ladder, not out to the wrapper: by contract `error`
            // reaches the wrapper only once every rung has been spent, and
            // that is the ladder's call to make, not this listener's.
            this.ladder.note({
                category: errorCategory(error?.code),
                fatal: true,
                detail: error ?? undefined,
            });
        });
    }

    /**
     * Catch the state store up after the runtime was frozen.
     *
     * Every field the wrapper publishes is pushed from an adapter event, so a
     * suspension leaves the playhead, the buffered band and the transport state
     * showing whatever they showed when the screen locked. Rather than give the
     * wrapper a pull API for one moment, the adapter re-emits what it already
     * emits — the store corrects itself through the path it uses the rest of
     * the time, and every platform states this the same way: on resume, say
     * again what is true now.
     *
     * A native adapter hangs this on its own lifecycle callbacks; on the web
     * the equivalent signal is the page becoming visible again.
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
        this.emit(this.player.paused() ? 'pause' : 'playing', undefined);

        // A re-munge asked for while the runtime was frozen reached nobody.
        this.ladder.noteResumed();
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
            const onAudioTracks = (): void => {
                // Torn down: whatever video.js adds next is the new source's.
                if (tracks.length === 0) this.audioTracksOutgoing = false;
                this.emit('audiotracks-updated', undefined);
            };
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
        this.disarmSourceHooks();
        // The seam wrappers stay on the handler they wrap. It outlives this call:
        // video.js disposes it only once the next src() lands, the tech is swapped
        // for YouTube, or the player is disposed — all later, and a YouTube switch
        // first waits for the tech to load. A live source refreshes its playlists
        // all the while, and handing the handler its raw factory back sends
        // luminary://live/… over a real XHR, which the browser refuses and VHS
        // answers by excluding one rendition after another. Wrapped, it is
        // answered to the last: keys with the bytes it was given, live playlists
        // as the serving layer decides.
        this.stallSignals.clear();
        this.removeRemoteTextTracks();
        this.keyBytes = null;
        this.lastSource = null;
        this.playerSource = null;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.teardownSource();
        this.ladder.destroy();
        this.stallSignals.detach();
        if (this.onVisibilityChange && typeof document !== 'undefined') {
            document.removeEventListener(
                'visibilitychange',
                this.onVisibilityChange,
            );
        }
        this.onVisibilityChange = null;
        this.detachPlayerListeners();
        this.detachListListeners();
        this.restoreLoad?.();
        this.restoreLoad = null;
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
