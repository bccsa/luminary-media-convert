/*
 * The stylesheets — vendor first, then the skin — are pulled in from
 * `LuminaryPlayer.vue`'s style block rather than from here, so that no `.css`
 * specifier reaches the emitted declarations. See the comment on that block.
 */
export * from '@luminary-media-converter/player-core';

export { default as LuminaryPlayer } from './components/LuminaryPlayer.vue';
export { default as AudioVideoToggle } from './components/AudioVideoToggle.vue';

// The web's serving layer. `player-core` requires one and defaults to nothing,
// so a host building its own controller needs this — and a native shell
// implements `ServeStrategy` in its place.
export { BlobServeStrategy } from './serve/BlobServeStrategy';

export {
    VideoJsAdapter,
    UnsupportedBrowserError,
    isVideoJsEngineSupported,
    type VideoJsAdapterOptions,
} from './adapter/VideoJsAdapter';

// The VHS request-factory seam and the two policies on it. Exported because
// they are the pieces most likely to need swapping out if a video.js upgrade
// moves VHS's request factory — see the README's note on flipping
// `keyDelivery` to 'url'.
export { wrapVhsXhr, vhsHandler, vhsTech } from './adapter/vhsXhrSeam';
export { installMemoryKeyXhr } from './adapter/vhsKeyInterceptor';
export {
    installByteRangeTimeout,
    byteRangeBackstopMs,
    BYTE_RANGE_TIMEOUT_MULTIPLIER,
    BYTE_RANGE_TIMEOUT_FALLBACK_MS,
} from './adapter/vhsRequestTimeout';

// Stall detection is VHS's; this reads its verdicts. Exported, with the clock
// it counts on, as part of the set a native adapter is ported from.
export {
    VhsStallSignals,
    UNKNOWN_WAITING_STRIKES,
    UNKNOWN_WAITING_WINDOW_MS,
    type VhsStallSignalHooks,
    type VhsStallSignalOptions,
    type UsageEventTarget,
} from './adapter/vhsStallSignals';
export { monotonicNow } from './drivers/clock';

// The recovery ladder, whole. Exported because it IS the porting unit: a native
// adapter whose engine has no retry policy of its own ports this file, and one
// whose engine does (ExoPlayer) satisfies the same obligation with that instead.
export {
    RecoveryLadder,
    type RecoveryLadderHooks,
    type RecoveryLadderOptions,
    type RecoveryReason,
} from './drivers/RecoveryLadder';

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
