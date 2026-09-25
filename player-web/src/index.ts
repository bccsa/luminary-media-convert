/*
 * Deprecated: superseded by `@luminary-media-converter/player-web-legacy`,
 * whose `LuminaryPlayer` takes the same props and slots and exposes the same
 * surface. Moving is an import change plus a visual one — video.js draws its
 * full control bar over the picture, where this package draws none outside
 * fullscreen.
 *
 * Kept building only because the encoder app still uses it; it gets no new
 * work. Its own exports carry `@deprecated`, naming the replacement where
 * there is one. The `player-core` re-export does not: that package is current,
 * and is better imported directly.
 */
export * from '@luminary-media-converter/player-core';

export {
    /** @deprecated Use `LuminaryPlayer` from `player-web-legacy`. */
    default as LuminaryPlayer,
} from './components/LuminaryPlayer.vue';
export {
    /** @deprecated No replacement: video.js draws the controls in `player-web-legacy`. */
    default as FullscreenControls,
} from './components/FullscreenControls.vue';

// The web's serving layer, which `player-core` now requires a host to supply.
export {
    /** @deprecated Use `BlobServeStrategy` from `player-web-legacy`. */
    BlobServeStrategy,
} from './serve/BlobServeStrategy';

export {
    /** @deprecated Use `VideoJsAdapter` from `player-web-legacy`. */
    HlsJsAdapter,
    /** @deprecated Use `UnsupportedBrowserError` from `player-web-legacy`. */
    UnsupportedBrowserError,
    /** @deprecated hls.js only; `player-web-legacy` has `installMemoryKeyXhr` for VHS. */
    createMemoryKeyLoader,
    /** @deprecated Use `isVideoJsEngineSupported` from `player-web-legacy`. */
    isHlsEngineSupported,
    /** @deprecated Use `VideoJsAdapterOptions` from `player-web-legacy`. */
    type HlsJsAdapterOptions,
} from './adapter/HlsJsAdapter';

// A copy of `player-web-legacy`'s warming loop, which is the reference a
// native adapter is ported from. HlsJsAdapter owns its own instance.
export {
    /** @deprecated Use `ChunkPrefetcher` from `player-web-legacy`, the reference this copies. */
    ChunkPrefetcher,
    /** @deprecated Use `ChunkPrefetcherHooks` from `player-web-legacy`. */
    type ChunkPrefetcherHooks,
    /** @deprecated Use `ChunkPrefetcherOptions` from `player-web-legacy`. */
    type ChunkPrefetcherOptions,
} from './adapter/chunkWarming';

export {
    /** @deprecated Use `DEFAULT_MESSAGES` from `player-web-legacy`. */
    DEFAULT_MESSAGES,
    /** @deprecated Use `formatSeconds` from `player-web-legacy`. */
    formatSeconds,
    /** @deprecated Use `mergeMessages` from `player-web-legacy`. */
    mergeMessages,
    /** @deprecated Use `PlayerMessages` from `player-web-legacy`. */
    type PlayerMessages,
} from './messages';

export {
    /** @deprecated Use `DEFAULT_CONTROLS` from `player-web-legacy`, whose skips default to 10 s, not 15. */
    DEFAULT_CONTROLS,
    /** @deprecated Use `mergeControls` from `player-web-legacy`. */
    mergeControls,
    /** @deprecated Use `PlayerControlsOptions` from `player-web-legacy`. */
    type PlayerControlsOptions,
} from './controls';

export {
    /** @deprecated Use `usePlayerState` from `player-web-legacy`. */
    usePlayerState,
} from './composables/usePlayerState';
export {
    /** @deprecated No replacement: `player-web-legacy` leaves rotation to `videojs-mobile-ui`. */
    useFullscreenOrientation,
    /** @deprecated No replacement; see `useFullscreenOrientation`. */
    type FullscreenMode,
    /** @deprecated No replacement; see `useFullscreenOrientation`. */
    type UseFullscreenOrientation,
} from './composables/useFullscreenOrientation';
