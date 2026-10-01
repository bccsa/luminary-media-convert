/**
 * The native player bridge, protocol v1: the contract between JavaScript and
 * the native `LuminaryPlayer` plugin on iOS (AVPlayer) and Android (ExoPlayer).
 *
 * This file is the single source of truth. Each native side mirrors these
 * types by hand (`BridgeTypes`), and `conformance/*.json` is their executable
 * form: a change here bumps {@link PROTOCOL_VERSION} if it breaks anything, and
 * lands with both mirrors and a matching scenario in the same change. v1 is
 * frozen: anything that breaks it is v2.
 *
 * ### Conventions
 *
 * - Time is seconds as a double; rates are doubles; a key is 32 hex characters,
 *   the same form as `PlayerSource.keyHex`.
 * - `playerId` comes from {@link LuminaryPlayerPlugin.create}. JavaScript mints
 *   a `loadId` for every `load` / `reattach`, and every event carries both, so a
 *   stale event can be dropped without waiting for a native id to arrive.
 * - `generation` is one controller `load()`; see {@link ASSET_URI_PREFIX}.
 * - Native applies each player's commands in arrival order.
 * - Native rejects only with a {@link BridgeErrorCode}.
 * - Payloads are JSON. A value JSON cannot carry (`Infinity`, `NaN`) never
 *   crosses: an unbounded duration travels as `null`.
 */

import type { PluginListenerHandle } from '@capacitor/core';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    type AdapterAudioTrack,
    type AdapterErrorCategory,
    type AdapterVariant,
    type ChunkBoundary,
    type RecoveryPolicy,
} from '@luminary-media-converter/player-core';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// URI scheme: what native answers
// ---------------------------------------------------------------------------

/**
 * `luminary://asset/<generation>/<n>.<ext>` — munged text JavaScript sent with
 * `load` or `putAssets`, answered from memory with its `contentType`.
 *
 * - A missing asset fails as not-found and is never retried.
 * - A request may ask for data alone, without asking for the content type —
 *   AVFoundation asks for an audio playlist again that way — and is answered
 *   the same.
 * - A generation is never evicted while in use. Within one generation the
 *   munge reuses media-playlist URLs: a switch sends a new master plus the
 *   playlists of an angle not shown before, and a return to one only the
 *   master. After `releaseAssets`, a generation is purged once a load of a
 *   newer one has taken over.
 * - In-memory answers must not count toward the engine's bandwidth estimate.
 */
export const ASSET_URI_PREFIX = 'luminary://asset/';

/**
 * `luminary://key` — exactly 16 bytes of the current key, from memory. With no
 * key it fails with `key-required`. The key is zeroed on destroy or replace,
 * and never logged.
 */
export const KEY_URI = LUMINARY_KEY_PLACEHOLDER_URI;

/**
 * `luminary://live/<n>` — a live playlist registered by `putLive`, re-read on
 * every engine request with no timer of its own. A released address is never
 * answered: the request is left open until the engine cancels it. Only when
 * {@link BridgeCapabilities.live} is true.
 *
 * `https://…` URIs are not the bridge's concern: the engine fetches them.
 */
export const LIVE_URI_PREFIX = 'luminary://live/';

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

export const BRIDGE_ERROR_CODES = [
    /** The capability the call needs is false. */
    'unsupported',
    /** No player with that `playerId`. */
    'unknown-player',
    /** The generation is older than the player's current one. */
    'stale-generation',
    /** An argument failed validation. */
    'invalid-argument',
    /** The two sides disagree on {@link PROTOCOL_VERSION}. */
    'protocol-mismatch',
    /** The engine itself failed. */
    'engine',
] as const;

/** The only codes native passes to `call.reject(message, code)`. */
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface BridgeCapabilities {
    /** Pins a rendition through `setVariant`. Engine-inherent: may differ per platform. */
    variantSwitching: boolean;
    /** Engine-inherent: may differ per platform. */
    pictureInPicture: boolean;
    /** Renders side-loaded VTT subtitles. Parity-gated; false in v1. */
    renderText: boolean;
    /** Answers `luminary://live/<n>` through `putLive`. Parity-gated. */
    live: boolean;
    /** Runs the warming loop through `warmChunks`. Parity-gated. */
    chunkWarming: boolean;
    /** Keeps playing with the screen locked. Parity-gated. */
    backgroundAudio: boolean;
    /** 1 in v1: a second `create` destroys the first player. */
    maxPlayers: number;
}

export interface BridgeInfo {
    protocolVersion: number;
    platform: 'ios' | 'android';
    capabilities: BridgeCapabilities;
}

/** One served asset. Text travels as text, never base64. */
export interface BridgeAsset {
    /** `luminary://asset/<generation>/<n>.<ext>` */
    uri: string;
    /**
     * `application/vnd.apple.mpegurl` or `text/vtt`. A MIME type, which native
     * maps to whatever its loader reports: a UTI on iOS (`UTType(mimeType:)`).
     */
    contentType: string;
    text: string;
}

/** Lock-screen and notification metadata. */
export interface NowPlaying {
    title: string;
    subtitle?: string;
    artworkUrl?: string;
}

/** `LivePlaylistSpec` as data: the key travels as hex, like `keyHex`. */
export interface BridgeLiveSpec {
    url: string;
    baseUrl: string;
    keyUri?: string;
    keyHex?: string;
    refreshSec: number;
}

export interface CreateOptions {
    /** Native rejects `protocol-mismatch` when this is not its own version. */
    protocolVersion: number;
    /** Remote-command and notification skips. */
    skipBackSeconds: number;
    skipForwardSeconds: number;
}

export interface LoadArgs {
    playerId: string;
    loadId: string;
    generation: number;
    /** `luminary://asset/…` */
    masterUri: string;
    /** Assets of this generation not yet sent; the rest arrived through `putAssets`. */
    assets: BridgeAsset[];
    keyHex?: string;
    startPosition?: number;
    /** Resolved by `player-core`: native applies it, never defaults it. */
    recovery: RecoveryPolicy;
    nowPlaying?: NowPlaying;
    /** Reserved; unused in v1. */
    requestHeaders?: Record<string, string>;
}

export interface Snapshot {
    currentTime: number;
    /** 0 until known; `null` while unbounded (live). */
    duration: number | null;
    bufferedEnd: number;
    playing: boolean;
}

export interface ResumeResult {
    /** The load the snapshot describes; an answer for an older one is ignored. */
    loadId: string;
    snapshot: Snapshot;
    /** A `reload-requested` held while JavaScript was suspended. */
    pendingReload?: { reason: 'wedged' | 'fatal'; attempt: number };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The plugin surface.
 *
 * Order of calls: `getInfo` → `reset` → `create` → (`load` | `reattach` |
 * transport)* → `destroy`.
 */
export interface LuminaryPlayerPlugin {
    getInfo(): Promise<BridgeInfo>;
    /** Destroys every player, including those left by an earlier JS context. */
    reset(): Promise<void>;
    create(options: CreateOptions): Promise<{ playerId: string }>;
    /**
     * Stores `assets` under `generation`, sets the key, and hands the engine
     * `masterUri`. Rejects `stale-generation` for an older generation.
     */
    load(args: LoadArgs): Promise<void>;
    /** Assets served after the load, or ahead of the next one in the same generation. */
    putAssets(args: {
        playerId: string;
        generation: number;
        assets: BridgeAsset[];
    }): Promise<void>;
    /** `unsupported` unless `live`. */
    putLive(args: {
        playerId: string;
        generation: number;
        uri: string;
        spec: BridgeLiveSpec;
    }): Promise<void>;
    /** Marks a generation (assets and live specs) for purging; see {@link ASSET_URI_PREFIX}. */
    releaseAssets(args: { playerId: string; generation: number }): Promise<void>;
    /** Rebuilds the engine from the assets it holds, restoring position, rate and tracks. */
    reattach(args: { playerId: string; loadId: string }): Promise<void>;
    /** After `ended`, restarts from 0 and emits `seeked`, as a media element does. */
    play(args: { playerId: string }): Promise<void>;
    pause(args: { playerId: string }): Promise<void>;
    /** `exact` defaults to false, which lets the engine snap to a keyframe. */
    seek(args: { playerId: string; position: number; exact?: boolean }): Promise<void>;
    setRate(args: { playerId: string; rate: number }): Promise<void>;
    /** `'auto'` restores ABR. `unsupported` unless `variantSwitching`. */
    setVariant(args: { playerId: string; id: string }): Promise<void>;
    setAudioTrack(args: { playerId: string; id: string }): Promise<void>;
    /** `unsupported` unless `chunkWarming`. Empty `schedules` stops the loop. */
    warmChunks(args: {
        playerId: string;
        loadId: string;
        schedules: ChunkBoundary[][];
        leadSeconds: number;
        warmBytes: number;
    }): Promise<void>;
    enterFullscreen(args: { playerId: string }): Promise<void>;
    /** Pauses, unless the current item has no video track (audio-only). */
    exitFullscreen(args: { playerId: string }): Promise<void>;
    /** Called on every return to the foreground; see {@link ResumeResult}. */
    resumed(args: { playerId: string }): Promise<ResumeResult>;
    /** Idempotent. No event for this player follows it. */
    destroy(args: { playerId: string }): Promise<void>;
    addListener<E extends BridgeEventName>(
        event: E,
        listener: (event: BridgeEvent<E>) => void,
    ): Promise<PluginListenerHandle>;
}

// ---------------------------------------------------------------------------
// Events: what native emits
// ---------------------------------------------------------------------------

/**
 * Event payloads. The adapter events keep their `AdapterEventMap` names; each
 * rule is an obligation on the native side.
 */
export interface BridgeEventMap {
    /** 4 Hz while playing, plus once on seek and once on pause. */
    timeupdate: { currentTime: number };
    /**
     * On change, in whole milliseconds: an engine refines the duration as it
     * loads, and the sub-millisecond part is not a change. 0 until known;
     * `null` while unbounded (live).
     */
    durationchange: { duration: number | null };
    /** At most 1 Hz. The end of the buffered range containing the playhead. */
    progress: { bufferedEnd: number };
    /** On transition. */
    playing: Record<string, never>;
    pause: Record<string, never>;
    waiting: Record<string, never>;
    seeked: Record<string, never>;
    ended: Record<string, never>;
    /** Only on the engine's own verdict, never from a timer. */
    stalled: { stalled: boolean };
    /** `fatal` only once the recovery obligation in `PlayerAdapter` is spent. */
    error: {
        category: AdapterErrorCategory;
        fatal: boolean;
        code: string;
        message: string;
    };
    /** Held while suspended, and returned by `resumed()` instead. */
    'reload-requested': { reason: 'wedged' | 'fatal'; attempt: number };
    /** The whole list travels with the event. Always empty unless `variantSwitching`. */
    'variants-updated': { variants: AdapterVariant[] };
    /**
     * An empty list first on every `load` / `reattach`, then the new list once
     * the engine has it. One track per language: renditions sharing a
     * `LANGUAGE` across audio groups (a tier per video quality) are one
     * track, and the engine moves between them as the variant changes; a
     * rendition with no language is a track of its own. A fresh load starts on
     * the stream's `DEFAULT=YES` rendition, not the device's language. Again
     * whenever the selection changes — a `setAudioTrack`, or the viewer's pick
     * in native UI — with the new `activeId`.
     */
    'audiotracks-updated': { tracks: AdapterAudioTrack[]; activeId: string | null };
    /**
     * On change: a `setRate`, or the viewer's pick in native UI. Never on
     * `load`, since the rate outlives the item, and never for a pause, which
     * leaves the rate as it was.
     */
    ratechange: { rate: number };
    /** Once per load, when the duration and seekable range are known. Whole milliseconds, as `durationchange`. */
    loadedmetadata: { duration: number | null };
    /** On a presentation change. `inline` means not presented. */
    presentationchange: { state: 'inline' | 'fullscreen' | 'pip' };
}

export type BridgeEventName = keyof BridgeEventMap;

/** Every event is stamped with the player and load it belongs to. */
export type BridgeEvent<E extends BridgeEventName> = BridgeEventMap[E] & {
    playerId: string;
    loadId: string;
};

export const BRIDGE_EVENT_NAMES: readonly BridgeEventName[] = [
    'timeupdate',
    'durationchange',
    'progress',
    'playing',
    'pause',
    'waiting',
    'seeked',
    'ended',
    'stalled',
    'error',
    'reload-requested',
    'variants-updated',
    'audiotracks-updated',
    'ratechange',
    'loadedmetadata',
    'presentationchange',
];

// ---------------------------------------------------------------------------
// Helpers shared by both halves of the TypeScript side
// ---------------------------------------------------------------------------

/** `luminary://asset/<generation>/<n>.<ext>` */
export function assetUri(generation: number, n: number, ext: 'm3u8' | 'vtt'): string {
    return `${ASSET_URI_PREFIX}${generation}/${n}.${ext}`;
}

/** A wire duration as `player-core` reads it: `null` is unbounded. */
export function fromWireDuration(duration: number | null): number {
    return duration ?? Infinity;
}
