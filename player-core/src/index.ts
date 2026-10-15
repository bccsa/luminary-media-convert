export * from './types.js';

export { PlayerController } from './controller.js';
export type { PlayerControllerOptions } from './controller.js';

export { Emitter } from './emitter.js';
export { StateStore, createInitialState } from './store.js';
export { Poller, DEFAULT_POLL_INTERVAL_MS } from './poller.js';
// `DEFAULT_RECOVERY_POLICY` / `resolveRecoveryPolicy` come from `types.js`
// above: the policy is data the adapter's ladder reads, not behaviour here.
// The warming loop itself is an adapter's job (`PlayerAdapter.warmChunks`);
// what ships from here is the schedule builder and the policy defaults.
export {
    buildChunkSchedules,
    DEFAULT_LEAD_SECONDS,
    DEFAULT_WARM_BYTES,
} from './prefetch.js';
export type { ChunkBoundary } from './prefetch.js';
export {
    SidecarLoader,
    chapterTrackId,
    subtitleSidecarId,
    pickDefaultChapterTrack,
} from './sidecars.js';
export { parseVttCues, parseVttTimestamp } from './vtt.js';

// Liveness, and the plain-data spec a native serving layer refreshes from.
export { describeLiveness, resolveLivePlaylist } from './policy/live.js';
export type {
    Liveness,
    LivePlaylistSpec,
    ResolveLiveOptions,
} from './policy/live.js';

// Pipeline — the deliberately public, pure pieces. The blob-backed
// `ServeStrategy` is NOT among them: it lives in the player packages, because
// this one is headless and a host must now supply its own.
export {
    KEY_CONTENT_TYPE,
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
} from './pipeline/content-types.js';
export {
    bytesToHex,
    decryptLmcenc,
    hexToBytes,
    keyBytes,
} from './pipeline/decrypt.js';
export {
    PipelineError,
    decodeMaybeEncrypted,
    fetchBytes,
    fetchMaybeEncrypted,
    isMissing,
    toPlayerError,
} from './pipeline/fetch.js';
export type { DecodedAsset, FetchOptions } from './pipeline/fetch.js';
export {
    DEFAULT_ANGLE_ID,
    describeMaster,
    loadMaster,
    mungeSource,
} from './pipeline/pipeline.js';
export type {
    MasterInfo,
    MungeOptions,
    MungeResult,
    MungedMediaPlaylist,
    MungedSource,
    PipelineContext,
    ServeMemo,
} from './pipeline/pipeline.js';
export type { MediaPlaylistScan, SegmentRun } from './pipeline/media-scan.js';
export {
    applyQualityCap,
    listQualities,
    sortQualities,
    toQuality,
} from './pipeline/quality-cap.js';
export {
    LUMINARY_KEY_PLACEHOLDER_URI,
    rewriteMediaPlaylist,
} from './pipeline/rewrite-media.js';
export type { RewriteMediaOptions } from './pipeline/rewrite-media.js';
export {
    buildAudioOnlyMaster,
    hasAudioOnlyRendering,
    isAudioOnlyMaster,
    referencedPlaylistUris,
} from './pipeline/audio-only.js';
export {
    absolutize,
    collectMasterRefs,
    hasAes128Key,
    hasVideoVariants,
    isMasterPlaylistText,
    listSegmentUris,
    parseMasterText,
    substituteMasterRefs,
} from './pipeline/playlist-text.js';
