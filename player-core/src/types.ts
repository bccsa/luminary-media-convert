/**
 * Public contract of the player wrapper.
 *
 * The wrapper is a headless controller: it owns HLS playlist munging (angle
 * extraction, quality capping, key handling, decryption), playback policy
 * (recovery, stall detection, coming-soon polling) and a framework-free state
 * store. It drives an engine through the {@link PlayerAdapter} interface —
 * hls.js on the web today, AVPlayer / ExoPlayer in a Capacitor shell later.
 *
 * Implementing projects (the media encoder app, the Luminary app, …) talk to
 * {@link PlayerController} only; they never touch the adapter or the engine.
 */

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

/** Escape hatch over the wrapper's recovery policy. Defaults are sane. */
export interface RecoveryPolicy {
    /** Window in which a recurring same-category error escalates to reload. Default 10 000. */
    escalationWindowMs: number;
    /** Full-reload attempts before giving up. Default 3. */
    maxReloadAttempts: number;
    /** Spacing of reload attempts. Default [2 000, 4 000, 8 000]. */
    reloadDelaysMs: number[];
    /** No-progress time that counts as a stall while playing. Default 10 000. */
    stallTimeoutMs: number;
    /** Forward nudge applied on first stall detection, in seconds. Default 0.1. */
    stallNudgeSeconds: number;
}

/** Everything the wrapper needs to present one piece of content. */
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
    };
    poll?: PollPolicy;
    recovery?: Partial<RecoveryPolicy>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
    code:
        /** AES-128/LMCENC content encountered and no keyHex was supplied. */
        | 'key-required'
        /** LMCENC payload failed to decrypt (wrong key / corrupt file). */
        | 'decrypt-failed'
        /** Response was neither LMCENC nor a recognizable playlist/VTT. */
        | 'invalid-content'
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
    /** True while the stall watchdog considers playback wedged. */
    stalled: boolean;
    currentTime: number;
    /** 0 until known. */
    duration: number;
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
    playing: void;
    pause: void;
    ended: void;
    /** Engine is buffering / waiting for data. */
    waiting: void;
    seeked: void;
    error: AdapterErrorPayload;
    'variants-updated': void;
    'audiotracks-updated': void;
}

export type AdapterEventName = keyof AdapterEventMap;

/**
 * The engine-facing contract.
 *
 * Adapters own intra-source ABR and first-line recovery primitives; ALL
 * policy (retry counts, backoff, stall detection, polling) lives in the
 * wrapper so every platform behaves identically.
 */
export interface PlayerAdapter {
    readonly capabilities: AdapterCapabilities;

    loadSource(src: AdapterSource): Promise<void>;
    destroy(): void;

    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    getCurrentTime(): number;
    getDuration(): number;
    setPlaybackRate(rate: number): void;

    getVariants(): AdapterVariant[];
    /** `'auto'` re-enables ABR. */
    setVariant(id: string | 'auto'): void;

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
 */
export interface ServeStrategy {
    /** Returns a URL serving `content` with the given MIME type. */
    serve(content: string | Uint8Array, contentType: string): string;
    /** Releases every URL handed out since the last release(). */
    release(): void;
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
    setAudioTrack(id: string): void;
    /** null = subtitles off. */
    setSubtitleTrack(id: string | null): void;
    /** Lazy-loads (fetch + decrypt + parse) and caches the language's cues. */
    setChapterTrack(id: string | null): void;

    getState(): Readonly<PlayerState>;
    /** Store subscription: called with every state snapshot change. */
    subscribe(listener: (state: Readonly<PlayerState>) => void): Unsubscribe;
    on<E extends PlayerEventName>(
        event: E,
        listener: (payload: PlayerEventMap[E]) => void,
    ): Unsubscribe;
}
