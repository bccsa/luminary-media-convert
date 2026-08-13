export * from '@luminary-media-converter/player-core';

export { default as LuminaryPlayer } from './components/LuminaryPlayer.vue';
export { default as FullscreenControls } from './components/FullscreenControls.vue';

export {
    HlsJsAdapter,
    UnsupportedBrowserError,
    createMemoryKeyLoader,
    isHlsEngineSupported,
    type HlsJsAdapterOptions,
} from './adapter/HlsJsAdapter';

// Exported as the reference warming loop a native adapter is ported from, not
// because a host has any reason to construct one: HlsJsAdapter owns its own.
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
export {
    useFullscreenOrientation,
    type FullscreenMode,
    type UseFullscreenOrientation,
} from './composables/useFullscreenOrientation';
