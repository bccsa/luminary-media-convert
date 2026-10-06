/*
 * Retired and frozen: the hls.js test implementation, superseded by
 * `@luminary-media-converter/player-web` (video.js), which has since moved
 * ahead of it in features.
 *
 * Nothing consumes it, and nothing builds or tests it — it is outside
 * `build:libs` and CI on purpose, so it may stop compiling as `player-core`
 * moves on. Kept for reference. Its own exports carry `@deprecated`, naming
 * the replacement where there is one. The `player-core` re-export does not:
 * that package is current, and is better imported directly.
 */
export * from '@luminary-media-converter/player-core';

export {
    /** @deprecated Use `LuminaryPlayer` from `player-web`. */
    default as LuminaryPlayer,
} from './components/LuminaryPlayer.vue';
export {
    /** @deprecated No replacement: video.js draws the controls in `player-web`. */
    default as FullscreenControls,
} from './components/FullscreenControls.vue';

// The web's serving layer, which `player-core` now requires a host to supply.
export {
    /** @deprecated Use `BlobServeStrategy` from `player-web`. */
    BlobServeStrategy,
} from './serve/BlobServeStrategy';

export {
    /** @deprecated Use `VideoJsAdapter` from `player-web`. */
    HlsJsAdapter,
    /** @deprecated Use `UnsupportedBrowserError` from `player-web`. */
    UnsupportedBrowserError,
    /** @deprecated hls.js only; `player-web` has `installMemoryKeyXhr` for VHS. */
    createMemoryKeyLoader,
    /** @deprecated Use `isVideoJsEngineSupported` from `player-web`. */
    isHlsEngineSupported,
    /** @deprecated Use `VideoJsAdapterOptions` from `player-web`. */
    type HlsJsAdapterOptions,
} from './adapter/HlsJsAdapter';

// A copy of `player-web`'s warming loop, which is the reference a
// native adapter is ported from. HlsJsAdapter owns its own instance.
export {
    /** @deprecated Use `ChunkPrefetcher` from `player-web`, the reference this copies. */
    ChunkPrefetcher,
    /** @deprecated Use `ChunkPrefetcherHooks` from `player-web`. */
    type ChunkPrefetcherHooks,
    /** @deprecated Use `ChunkPrefetcherOptions` from `player-web`. */
    type ChunkPrefetcherOptions,
} from './adapter/chunkWarming';

export {
    /** @deprecated Use `DEFAULT_MESSAGES` from `player-web`. */
    DEFAULT_MESSAGES,
    /** @deprecated Use `formatSeconds` from `player-web`. */
    formatSeconds,
    /** @deprecated Use `mergeMessages` from `player-web`. */
    mergeMessages,
    /** @deprecated Use `PlayerMessages` from `player-web`. */
    type PlayerMessages,
} from './messages';

export {
    /** @deprecated Use `DEFAULT_CONTROLS` from `player-web`, whose skips default to 10 s, not 15. */
    DEFAULT_CONTROLS,
    /** @deprecated Use `mergeControls` from `player-web`. */
    mergeControls,
    /** @deprecated Use `PlayerControlsOptions` from `player-web`. */
    type PlayerControlsOptions,
} from './controls';

export {
    /** @deprecated Use `usePlayerState` from `player-web`. */
    usePlayerState,
} from './composables/usePlayerState';
export {
    /** @deprecated No replacement: `player-web` leaves rotation to `videojs-mobile-ui`. */
    useFullscreenOrientation,
    /** @deprecated No replacement; see `useFullscreenOrientation`. */
    type FullscreenMode,
    /** @deprecated No replacement; see `useFullscreenOrientation`. */
    type UseFullscreenOrientation,
} from './composables/useFullscreenOrientation';
