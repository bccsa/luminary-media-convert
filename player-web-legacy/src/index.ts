/*
 * The stylesheets — vendor first, then the skin — are pulled in from
 * `LuminaryPlayer.vue`'s style block rather than from here, so that no `.css`
 * specifier reaches the emitted declarations. See the comment on that block.
 */
export * from '@luminary-media-converter/player-core';

export { default as LuminaryPlayer } from './components/LuminaryPlayer.vue';
export { default as AudioVideoToggle } from './components/AudioVideoToggle.vue';

export {
    VideoJsAdapter,
    UnsupportedBrowserError,
    isVideoJsEngineSupported,
    type VideoJsAdapterOptions,
} from './adapter/VideoJsAdapter';

// The in-memory key seam. Exported because it is the piece most likely to need
// swapping out if a video.js upgrade moves VHS's request factory — see the
// README's note on flipping `keyDelivery` to 'url'.
export { installMemoryKeyXhr } from './adapter/vhsKeyInterceptor';

// Exported as the reference warming loop a native adapter is ported from, not
// because a host has any reason to construct one: the adapter owns its own.
export {
    ChunkPrefetcher,
    type ChunkPrefetcherHooks,
    type ChunkPrefetcherOptions,
} from './adapter/chunkWarming';

export {
    DEFAULT_MESSAGES,
    formatSeconds,
    mergeMessages,
    type PlayerMessages,
} from './messages';

export {
    DEFAULT_CONTROLS,
    mergeControls,
    type PlayerControlsOptions,
} from './controls';

export { usePlayerState } from './composables/usePlayerState';

// The video.js construction options and the pieces of the skin that are
// behaviour rather than CSS. A host embedding the player through its own
// video.js instance builds the same options from the same function.
export {
    buildVideoJsOptions,
    snapSkipSeconds,
    SKIP_ICON_SECONDS,
    type VideoJsOptions,
} from './vjs/playerOptions';
export { installAutoHide, AUTO_HIDE_MS } from './vjs/autoHide';
export { TRANSPARENT_POSTER } from './vjs/poster';
export { createKeepAlive, SILENT_AUDIO_DATA_URI, type KeepAlive } from './vjs/keepAlive';

// Mode detection and language matching: pure, and both are decisions a host may
// need to make before it has a player (which source goes to which component,
// which language it will ask for).
export { isYouTubeUrl, extractYouTubeId, toVideoJsYouTubeUrl } from './youtube';
export { singleFlight } from './singleFlight';
export {
    findPreferredTrack,
    matchesPreferredLanguage,
    type LanguageTaggedTrack,
} from './audioTrackLanguage';
