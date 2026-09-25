/**
 * Public contract of the player wrapper.
 *
 * The wrapper is a headless controller: it owns HLS playlist munging (angle
 * extraction, quality capping, key handling, decryption), playback policy
 * (recovery, coming-soon polling) and a framework-free state
 * store. It drives an engine through the {@link PlayerAdapter} interface —
 * hls.js on the web today, AVPlayer / ExoPlayer in a Capacitor shell later.
 *
 * Implementing projects (the media encoder app, the Luminary app, …) talk to
 * {@link PlayerController} only; they never touch the adapter or the engine.
 */

import type { ChunkBoundary } from './prefetch.js';
import type { LivePlaylistSpec } from './policy/live.js';

// Re-exported so this file reads as the whole contract: an adapter author
// implementing warmChunks() needs the boundary shape in front of them, and a
// serving layer implementing serveLive() needs the spec shape, without either
// having to go looking in the module that happens to build it.
export type { ChunkBoundary, LivePlaylistSpec };

// ---------------------------------------------------------------------------
// Source description
// ---------------------------------------------------------------------------

/** A chapter sidecar for one language (`chapters/<lang>.vtt` convention). */
export interface ChapterSidecar {
    /** BCP-47 / ISO-639 language tag, e.g. `'en'`. */
    lang: string;
    /** Human label for the track; defaults to `lang`. */
    label?: string;
    /** URL of the WebVTT file. May be LMCENC-encrypted. */
    url: string;
}

/** An out-of-band subtitle sidecar (beyond any SUBTITLES media in the master). */
export interface SubtitleSidecar {
    lang: string;
    label: string;
    /** URL of the WebVTT file. May be LMCENC-encrypted. */
    url: string;
}

/** Polling policy for a master playlist that does not exist yet. */
export interface PollPolicy {
    /** Fixed re-check interval after the immediate first check. Default 30 000. */
    intervalMs?: number;
    /** Set false to fail immediately instead of waiting. Default true. */
    enabled?: boolean;
}

/**
 * Escape hatch over the recovery ladder's tuning. Defaults are sane.
 *
 * Data, not behaviour: the controller resolves a source's overrides into a
 * complete policy and hands it to the adapter in {@link AdapterSource.recovery},
 * which runs the ladder. See {@link PlayerAdapter} for the obligation itself.
 */
export interface RecoveryPolicy {
    /** Window in which a recurring same-category error counts as recurring. Default 10 000. */
    escalationWindowMs: number;
    /** Recovery attempts before giving up. Default 3. */
    maxReloadAttempts: number;
    /** Spacing of those attempts. Default [2 000, 4 000, 8 000]. */
    reloadDelaysMs: number[];
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
    escalationWindowMs: 10_000,
    maxReloadAttempts: 3,
    reloadDelaysMs: [2_000, 4_000, 8_000],
};

/** Fill a caller's partial overrides out to a complete policy. */
export function resolveRecoveryPolicy(
    overrides?: Partial<RecoveryPolicy>,
): RecoveryPolicy {
    return { ...DEFAULT_RECOVERY_POLICY, ...overrides };
}

/** Everything the wrapper needs to present one piece of content. */
/**
 * A `thumbnails.vtt` and, through it, the sprite sheets it references.
 *
 * LMCENC-wrapped on an encrypted session, like every other `.vtt` the encoder
 * writes, so it goes through the same decrypt path as chapters. The sprite
 * *images* are not encrypted — they are ordinary JPEGs, fetched by the browser
 * as image sources.
 */
export interface ThumbnailSidecar {
    /** Absolute URL of the VTT. Sprite paths inside it resolve against its directory. */
    url: string;
}

export interface PlayerSource {
    /** URL of the (possibly multi-angle, possibly LMCENC-encrypted) master playlist. */
    masterUrl: string;
    /**
     * AES-128 session key as 32 hex chars. When set, it is used to decrypt
     * LMCENC playlists/VTTs and is supplied to the engine for segment
     * decryption — it wins over any key URI the playlists carry.
     */
    keyHex?: string;
    /**
     * Quality cap as a video height (720, 480, …). LOAD-TIME ONLY: the munged
     * playlist simply omits higher renditions, so neither ABR nor manual
     * selection can exceed it. Changing the cap requires a new load();
     * a playing video keeps its old cap until then. When no rendition is at
     * or below the cap, the single lowest rendition above it is kept.
     */
    maxHeight?: number;
    /** Start position in seconds for the initial load. */
    startPosition?: number;
    /** Carry the previous source's position into this load. */
    preservePosition?: boolean;
    sidecars?: {
        /**
         * Multi-lingual chapter sidecars. The wrapper supports many; an
         * implementing app is free to pass a single language.
         */
        chapters?: ChapterSidecar[];
        subtitles?: SubtitleSidecar[];
        /**
         * Sprite sheets for the scrub preview, as `thumbnails.vtt` beside the
         * master.
         *
         * Passed explicitly rather than derived from the master's prefix,
         * because a sidecar is a convention and not something the playlist
         * points at: an audio-only encode and a session created with
         * `thumbnails: false` have none, and a player that guessed the URL would
         * be requesting a 404 on every load to find that out. Supplied the same
         * way {@link PlayerSource.keyHex} is — the host knows, the player does
         * not.
         */
        thumbnails?: ThumbnailSidecar;
    };
    poll?: PollPolicy;
    recovery?: Partial<RecoveryPolicy>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Imported for use below and re-exported, so a consumer can type a preview
// without also depending on `hls/` — `player-web` draws these and has no other
// reason to know that package exists.
import type { ThumbnailSpriteCue } from '@luminary-media-converter/hls-core';
export type { ThumbnailSpriteCue };

export type Lifecycle =
    /** No source loaded. */
    | 'idle'
    /** Master playlist not published yet — "coming soon". Polling per {@link PollPolicy}. */
    | 'waiting-for-master'
    /** Munging / engine attach in progress. */
    | 'loading'
    /** Engine has the source; playback API is live. */
    | 'ready'
    /** Unrecoverable failure; see {@link PlayerState.error}. */
    | 'error'
    /** destroy() was called; the controller is inert. */
    | 'destroyed';

/** A camera angle derived from the master's `TYPE=VIDEO` rendition groups. */
export interface Angle {
    /** `GROUP-ID`, or {@link AUDIO_ONLY_ANGLE_ID} for the synthesized audio-only rendering. */
    id: string;
    name: string;
    isDefault: boolean;
}

/**
 * Pseudo-angle id for the audio-only rendering synthesized from the master's
 * audio groups. Selecting it plays a munged master with ZERO video variants —
 * no video data is downloaded at all (restricted-bandwidth use case).
 */
export const AUDIO_ONLY_ANGLE_ID = '__audio__';

/** A selectable rendition after quality capping (the engine never sees more). */
export interface Quality {
    /** Stable id: `String(height)` for video, `b<bandwidth>` for resolution-less variants. */
    id: string;
    height?: number;
    bandwidth: number;
    label: string;
}

export interface AudioTrack {
    id: string;
    lang?: string;
    label: string;
}

export interface SubtitleTrack {
    id: string;
    lang?: string;
    label: string;
    /** Whether the track came from master `TYPE=SUBTITLES` media or a sidecar file. */
    source: 'master' | 'sidecar';
}

export interface ChapterTrack {
    id: string;
    lang: string;
    label: string;
}

export interface Chapter {
    startTime: number;
    endTime: number;
    title: string;
}

/** Typed, user-presentable failure. */
export interface PlayerError {
    code: /** AES-128/LMCENC content encountered and no keyHex was supplied. */
        | 'key-required'
        /** LMCENC payload failed to decrypt (wrong key / corrupt file). */
        | 'decrypt-failed'
        /** Response was neither LMCENC nor a recognizable playlist/VTT. */
        | 'invalid-content'
        /**
         * The source is live, and the serving layer cannot keep a playlist
         * fresh — it declares no `serveLive`. Refused outright rather than
         * played from a snapshot frozen at its first read, which is the worst
         * of the available failures: it looks like playback and is not.
         */
        | 'live-unsupported'
        /** A referenced sub-playlist or sidecar failed to load. */
        | 'fetch-failed'
        /** Engine cannot play munged content in this browser (e.g. iOS < 17.1, no MSE). */
        | 'unsupported-browser'
        /** Engine reported a fatal media error that survived recovery. */
        | 'media'
        /** Network-level failure that survived recovery. */
        | 'network'
        | 'unknown';
    fatal: boolean;
    message: string;
    cause?: unknown;
}

/** Immutable snapshot published to {@link PlayerController.subscribe} listeners. */
export interface PlayerState {
    lifecycle: Lifecycle;
    playing: boolean;
    ended: boolean;
    /**
     * True while the engine reports playback stalled — stuck, not merely
     * buffering. Detection is the engine's: every engine watches its own
     * buffer far better than a wrapper sampling `currentTime` could, and
     * announces the verdict through {@link AdapterEventMap.stalled}.
     */
    stalled: boolean;
    currentTime: number;
    /** 0 until known. */
    duration: number;
    /**
     * End of the buffered range currently being played, in seconds; 0 when
     * nothing is buffered ahead or the engine does not report it.
     *
     * The range *containing* the playhead, not the furthest one the engine
     * holds — after a seek, media either side of a gap is buffered but not
     * continuous with here, and presenting it as one run would promise a viewer
     * smooth playback straight into a stall.
     */
    bufferedEnd: number;
    playbackRate: number;

    angles: Angle[];
    activeAngleId: string | null;

    /** Post-cap rendition set. */
    qualities: Quality[];
    /** `'auto'` = adapter ABR chooses within the capped set. */
    activeQualityId: string | 'auto';
    /** The cap the CURRENT load was munged with, if any. */
    maxHeight?: number;

    audioTracks: AudioTrack[];
    activeAudioTrackId: string | null;

    subtitleTracks: SubtitleTrack[];
    /** null = subtitles off. */
    activeSubtitleTrackId: string | null;

    chapterTracks: ChapterTrack[];
    activeChapterTrackId: string | null;
    /** Cues of the active chapter track (loaded lazily per language). */
    chapters: Chapter[];

    /** True when the active rendering carries no video (audio-only master or pseudo-angle). */
    isAudioOnly: boolean;

    /**
     * True once a thumbnail sidecar has been fetched and parsed into at least
     * one cue.
     *
     * A UI reads this to decide whether to offer a scrub preview at all. False
     * covers every reason there might not be one — none passed, the file is
     * absent, it failed to parse — because none of them is a state a viewer can
     * act on, and all of them mean the same thing on screen.
     */
    thumbnailsReady: boolean;

    error: PlayerError | null;
}

// ---------------------------------------------------------------------------
// Controller events
// ---------------------------------------------------------------------------

export interface PlayerEventMap {
    /** Fired when coming-soon polling finds the master. */
    'master-available': void;
    'angle-changed': { angleId: string };
    error: PlayerError;
    /** A recovery attempt (in-place or reload) restored playback. */
    recovered: { attempt: number };
    destroyed: void;
}

export type PlayerEventName = keyof PlayerEventMap;

/** Unsubscribe function returned by subscribe()/on(). */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Adapter contract (implemented per engine)
// ---------------------------------------------------------------------------

export type AdapterErrorCategory = 'network' | 'media' | 'other';

export interface AdapterCapabilities {
    /**
     * True for engines that natively handle spec-compliant multi-angle HLS
     * (and thus receive the ORIGINAL master URL — the wrapper skips munging).
     * False for hls.js and every current target.
     */
    nativeHls: boolean;
    /**
     * 'memory': the adapter serves AES-128 key requests itself from
     * {@link AdapterSource.keyHex} (hls.js custom key loader, AVAsset
     * resource-loader delegate, ExoPlayer DataSource) — the wrapper never
     * mints a key blob URL and nothing key-shaped appears on the network.
     * 'url': the wrapper falls back to rewriting key URIs to a blob URL.
     */
    keyDelivery: 'memory' | 'url';
    /** Supports pinning a specific variant via setVariant(). */
    variantSwitching: boolean;
    /** Can render WebVTT text tracks handed over via setTextTracks(). */
    renderText: boolean;
}

/** What the wrapper hands the engine to play. */
export interface AdapterSource {
    /** Munged master (blob URL) — or the original URL when munging was skipped. */
    url: string;
    isBlob: boolean;
    /** Raw session key for 'memory' key delivery. */
    keyHex?: string;
    /**
     * The recovery ladder's tuning for this source, already resolved — the
     * adapter is handed decisions, never a partial bag whose defaults it would
     * have to know. Travels with the source rather than the constructor so a
     * {@link PlayerSource.recovery} override reaches the adapter that runs it.
     */
    recovery: RecoveryPolicy;
}

export interface AdapterVariant {
    id: string;
    height?: number;
    bandwidth: number;
}

export interface AdapterAudioTrack {
    id: string;
    lang?: string;
    label: string;
}

export interface AdapterTextTrack {
    id: string;
    lang?: string;
    label: string;
    /** Plaintext WebVTT served as a blob URL (already decrypted by the wrapper). */
    blobUrl: string;
}

export interface AdapterErrorPayload {
    category: AdapterErrorCategory;
    fatal: boolean;
    detail?: unknown;
}

export interface AdapterEventMap {
    timeupdate: { currentTime: number };
    durationchange: { duration: number };
    /**
     * Buffered-ahead position moved. Separate from `timeupdate` because
     * buffering continues while paused, when no time is passing to report.
     *
     * Optional in practice: an adapter that cannot report it simply never
     * emits, and the wrapper leaves `bufferedEnd` at 0.
     */
    progress: { bufferedEnd: number };
    playing: void;
    pause: void;
    ended: void;
    /** Engine is buffering / waiting for data. */
    waiting: void;
    /**
     * The engine's own verdict that playback is stuck (true) or moving again
     * (false) — not ordinary buffering, which is `waiting`. Detection belongs
     * to the engine: VHS's `PlaybackWatcher`, hls.js's gap controller and the
     * native players all watch their own buffer, and a wrapper timer sampling
     * `currentTime` cannot tell a slow request from a wedged decoder. An
     * adapter whose engine says nothing simply never emits this.
     */
    stalled: { stalled: boolean };
    seeked: void;
    /**
     * The adapter has exhausted its recovery obligation (see
     * {@link PlayerAdapter}) and playback is over. The wrapper does not retry:
     * by the time this arrives the engine's own primitive, the bounded
     * `reattach()`s and any re-munge it asked for have all been spent, so the
     * wrapper surfaces it as a fatal {@link PlayerError} and stops.
     *
     * A non-fatal payload is informational and ignored.
     */
    error: AdapterErrorPayload;
    /**
     * The adapter needs the munged source rebuilt — the one recovery step it
     * cannot perform itself, because only the wrapper knows what the source was
     * munged from (angles, quality cap, LMCENC, key).
     *
     * Requires JavaScript to be awake, so a native adapter cannot raise it
     * while the app is suspended; it holds the request and raises it on resume
     * instead of counting it as a failed attempt. `attempt` is the ladder's own
     * count, passed through to the wrapper's `recovered` event.
     */
    'reload-requested': { reason: 'wedged' | 'fatal'; attempt: number };
    'variants-updated': void;
    'audiotracks-updated': void;
}

export type AdapterEventName = keyof AdapterEventMap;

/**
 * Resolved settings for {@link PlayerAdapter.warmChunks}. Every field is
 * already decided — the wrapper owns the policy and applies its defaults, so an
 * adapter never has to know what an omitted value would have meant.
 */
export interface ChunkWarmOptions {
    /**
     * Warm the next chunk once the watermark is within this many seconds of
     * the current boundary's end. Defaults to 60 in the wrapper.
     */
    leadSeconds: number;
    /**
     * Bytes to request from the head of the next chunk — enough to make the
     * edge start pulling the object. Defaults to 65 536 in the wrapper.
     */
    warmBytes: number;
    /**
     * The `fetch` to warm with: the wrapper's own, so an auth-wrapped fetch or
     * a Capacitor HTTP shim reaches the warming requests too.
     */
    fetchImpl: typeof fetch;
    /**
     * Instrumentation sink, absent unless the host asked for it. Warming is
     * invisible by design — one small range per chunk among hundreds of media
     * requests — so this is how it is watched: schedule shape when armed,
     * every warm with its trigger context, and the failures that are swallowed.
     */
    log?: (message: string) => void;
}

/**
 * The engine-facing contract.
 *
 * Adapters own intra-source ABR, stall detection and recovery; the wrapper owns
 * munging, coming-soon polling and the state store. The dividing line is what
 * survives a suspended JavaScript runtime: a native engine keeps pulling
 * segments from its own threads while a locked screen freezes the WebView, so
 * anything that must act during playback has to live beside the engine, and
 * only what genuinely cannot — rebuilding a munged source — is asked of the
 * wrapper. `docs/suspension-safe-playback.md` is the prose version.
 *
 * ### The recovery obligation
 *
 * Before emitting `error` with `fatal: true`, an adapter MUST, using the
 * {@link RecoveryPolicy} it was handed in {@link AdapterSource.recovery}:
 *
 * 1. **Try its engine's in-place primitive once**, if it has one — hls.js
 *    `recoverMediaError()` / `startLoad()`, ExoPlayer `prepare()`. An engine
 *    with nothing to try skips this rung rather than pretending to succeed.
 * 2. **Re-attach, bounded, with backoff.** {@link reattach} against the URLs it
 *    already holds, spaced by `reloadDelaysMs` and capped at
 *    `maxReloadAttempts`, measured on a MONOTONIC clock — wall-clock time jumps
 *    across a suspension, which makes an error that recurred the instant
 *    playback resumed look like a fresh one and restarts the ladder at the
 *    wrong rung.
 * 3. **Ask for a re-munge** via `reload-requested`, for the failures a
 *    re-attach cannot fix. This one needs JavaScript, so an adapter that cannot
 *    reach it while suspended holds the request and raises it on resume rather
 *    than counting it as a failed attempt.
 *
 * Only then is the obligation spent, and `error` means exactly that.
 *
 * A platform whose engine already provides rungs 1–2 satisfies the obligation
 * with it: ExoPlayer's `LoadErrorHandlingPolicy` is precisely a
 * retry-count-plus-backoff policy, and re-implementing ours beside it would be
 * two ladders fighting. A platform with no equivalent — AVPlayer — ports the
 * reference module, `player-web-legacy/src/drivers/RecoveryLadder.ts`, which
 * is self-contained for that reason.
 */
export interface PlayerAdapter {
    readonly capabilities: AdapterCapabilities;

    loadSource(src: AdapterSource): Promise<void>;
    destroy(): void;

    /**
     * Re-prepare the engine against the source it already holds — no munge, no
     * wrapper involvement, nothing that needs JavaScript beyond the adapter
     * itself. Rung 2 of the recovery obligation above.
     *
     * The munge is deterministic for an unchanged selection: narrowing and
     * capping are pure and the playlists come back byte-identical, so a full
     * reload would produce the same text behind a fresh set of URLs. All the
     * value is in the engine being re-created, which is what this does. Keeping
     * them separate is what lets a backgrounded native player recover on its
     * own, and a re-munge is then reserved for what genuinely changes the
     * source: an angle switch, a quality cap, a live refresh.
     *
     * Position and play state are the adapter's to restore, and whatever the
     * adapter attached to the source — text tracks, key delivery, a warming
     * loop — must survive or be re-armed, since the source has not changed.
     * A no-op is correct when nothing has been loaded yet.
     */
    reattach(): Promise<void>;

    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    getCurrentTime(): number;
    getDuration(): number;
    setPlaybackRate(rate: number): void;

    getVariants(): AdapterVariant[];
    /** `'auto'` re-enables ABR. */
    setVariant(id: string | 'auto'): void;

    /**
     * The engine's audio tracks; empty while it has none.
     *
     * A list the engine rebuilds — for a new source, or for its own
     * `reattach()` — must be seen empty in between: already empty when
     * `loadSource` resolves, or announced with `audiotracks-updated` as it
     * empties. The engine selects its own default in the list it builds, and
     * that empty moment is how the wrapper knows to hand a viewer's choice
     * back into it.
     */
    getAudioTracks(): AdapterAudioTrack[];
    setAudioTrack(id: string): void;

    setTextTracks(tracks: AdapterTextTrack[]): void;
    setActiveTextTrack(id: string | null): void;

    /**
     * Attempt an in-place recovery for the given error category
     * (e.g. hls.js recoverMediaError()/startLoad()). Return false when the
     * engine has nothing to try — the wrapper will escalate to a reload.
     */
    recover?(category: AdapterErrorCategory): boolean;

    /**
     * Warm the chunk objects playback is about to need.
     *
     * Byte-range output packs many segments into a few large chunk objects
     * (all renditions of an angle share one chain, the audio groups share
     * another). A delivery edge forwards a requested range immediately while
     * backhauling the whole object behind it, so the FIRST request into a
     * chunk is the slow one. Asking for a few kilobytes of the next chunk
     * shortly before the engine crosses into it starts that backhaul early.
     *
     * The wrapper calls this on every source attach — initial load, angle
     * switch, recovery reload — with the schedules for the chains that attach
     * will actually pull, and calls it with an EMPTY array to mean *stop*
     * (source torn down, warming disabled, or output with no byte ranges).
     * Implementing it is optional; an adapter that omits it simply never warms.
     *
     * Normative semantics — an implementation MUST:
     *
     * 1. **Sample the buffer front, with the playhead as the floor**:
     *    `max(bufferedEnd, currentTime)` off the adapter's OWN media element.
     *    A playhead-only trigger is wrong: the engine buffers tens of seconds
     *    ahead and crosses the boundary long before the viewer reaches it, so
     *    the warm would land after the cold request it exists to prevent.
     * 2. **Warm on approach**: for each schedule, find the boundary containing
     *    the watermark; when its `end` minus the watermark is at or under
     *    `leadSeconds`, warm the NEXT boundary — but only if that boundary's
     *    `url` differs, since a run continuing in the same object needs
     *    nothing. The first chunk is never warmed: the engine's own start-up
     *    requests fetch it.
     * 3. **Warm each URL at most once per attached source**, marking it warmed
     *    BEFORE the request goes out — two ticks must not both fire — and
     *    never retrying a failure. The engine's own request is the fallback,
     *    later and slower, which is the un-warmed status quo anyway.
     * 4. **Request `Range: bytes=0-<warmBytes - 1>` through `fetchImpl`**, read
     *    the body to completion and discard it. The bytes are ciphertext that
     *    is never decrypted, parsed, cached or handed to the engine — reading
     *    them only completes the request.
     * 5. **Swallow every failure.** Warming is advisory in both directions: it
     *    must not block a load, surface an error, or change what the viewer
     *    sees. Report failures to `log` and move on.
     * 6. **Keep ticking while paused.** A static watermark fetches nothing by
     *    itself, and a player parked just short of a boundary gets its next
     *    chunk warmed before the viewer presses play again.
     * 7. **Sample about once a second.** Boundaries are tens of seconds apart;
     *    finer sampling buys nothing.
     * 8. **Stop** on an empty-schedules call, when a new source replaces the
     *    current one, and on `destroy()` — a loop outliving its source warms
     *    chunks nothing is going to play. It MAY also stop once every warmable
     *    boundary (each whose `url` differs from the one before it, a chain's
     *    first excepted) has been warmed: rule 3 leaves nothing more to do.
     *
     * The loop is deliberately adapter work rather than wrapper work: a JS
     * interval is throttled — or suspended outright — once the page or app is
     * backgrounded, which is exactly when a native player carries on playing.
     * A native adapter therefore re-implements the pacing loop beside its own
     * player (AVPlayer, ExoPlayer) instead of reusing a JS timer across the
     * bridge; the schedules themselves are plain data and serialize fine.
     *
     * Reference implementation:
     * `player-web-legacy/src/adapter/chunkWarming.ts` (`ChunkPrefetcher`),
     * wired up in `player-web-legacy/src/adapter/VideoJsAdapter.ts`. Prose
     * versions, for porting: `docs/chunk-warming.md` for the loop itself, and
     * `docs/suspension-safe-playback.md` for the rule it is one case of.
     */
    warmChunks?(schedules: ChunkBoundary[][], options: ChunkWarmOptions): void;

    on<E extends AdapterEventName>(
        event: E,
        listener: (payload: AdapterEventMap[E]) => void,
    ): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Serve strategy (how munged text reaches the engine)
// ---------------------------------------------------------------------------

/**
 * Isolates "turn munged text into something the engine can load".
 * Web: object/blob URLs. Native shells: a loopback server or file URIs.
 *
 * Required by {@link PlayerControllerOptions} rather than defaulted, and the
 * reason is the native port: a shell that forgot to supply one used to be
 * handed `blob:` URLs silently, which its player cannot read at all. A missing
 * serving layer is now a compile error in the one place it can still be fixed.
 */
export interface ServeStrategy {
    /** Returns a URL serving `content` with the given MIME type. */
    serve(content: string | Uint8Array, contentType: string): string;
    /** Releases every URL handed out since the last release(). */
    release(): void;
    /**
     * Serve a LIVE media playlist: return a URL that re-resolves on every
     * engine request, refreshing itself per {@link LivePlaylistSpec}.
     *
     * Its presence IS the live capability — a strategy cannot claim what it
     * has not implemented, the way a boolean flag would let it — and its
     * absence is what makes the pipeline refuse a live source rather than serve
     * a snapshot that will never change again.
     *
     * What happens behind the returned URL is the strategy's business and never
     * the controller's: fetch, sniff for LMCENC, decrypt, rewrite, respond, on
     * whatever cadence the spec names. That is the whole point — on a native
     * shell it has to happen while JavaScript is frozen.
     */
    serveLive?(spec: LivePlaylistSpec): string;
}

// ---------------------------------------------------------------------------
// Controller surface
// ---------------------------------------------------------------------------

/**
 * The controller surface implementing projects and UI components code
 * against. The concrete class is {@link ../controller!PlayerController};
 * tests substitute fakes of this interface.
 */
export interface PlayerControllerApi {
    load(source: PlayerSource): Promise<void>;
    destroy(): void;

    play(): Promise<void>;
    pause(): void;
    togglePlay(): void;
    seek(seconds: number): void;
    setPlaybackRate(rate: number): void;

    /** Re-munges and reloads, preserving position and play state. */
    setAngle(id: string): Promise<void>;
    /** Pins a rendition within the capped set; `'auto'` re-enables ABR. No reload. */
    setQuality(id: string | 'auto'): void;
    /**
     * Selects an audio track and keeps it selected until the next `load()`.
     * An angle switch, the audio toggle and a recovery re-attach each rebuild
     * the engine's track list with the stream's default in it; the choice is
     * handed back every time.
     */
    setAudioTrack(id: string): void;
    /** null = subtitles off. */
    setSubtitleTrack(id: string | null): void;
    /** Lazy-loads (fetch + decrypt + parse) and caches the language's cues. */
    setChapterTrack(id: string | null): void;

    /**
     * The sprite frame covering `seconds`, or null when there is none.
     *
     * A call rather than state: a scrub asks per pointer move, and nothing else
     * in a UI reacts to the answer — publishing it through the store would wake
     * every subscriber on every mouse move. Check
     * {@link PlayerState.thumbnailsReady} to decide whether to offer a preview
     * at all.
     */
    thumbnailAt(seconds: number): ThumbnailSpriteCue | null;

    getState(): Readonly<PlayerState>;
    /** Store subscription: called with every state snapshot change. */
    subscribe(listener: (state: Readonly<PlayerState>) => void): Unsubscribe;
    on<E extends PlayerEventName>(
        event: E,
        listener: (payload: PlayerEventMap[E]) => void,
    ): Unsubscribe;
}
