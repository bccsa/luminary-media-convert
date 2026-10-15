import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';
import { describeLiveness, resolveLivePlaylist } from './policy/live.js';

/**
 * The runtime surface of `@luminary-media-converter/player-core`, by name.
 *
 * Its consumers mostly live elsewhere — the players, the Luminary app through
 * `player-web-legacy`'s `export *`, native adapters — and find a removed symbol
 * only at their next build. Pinned here, an export cannot appear or disappear
 * without a change to this list saying so. Type-only exports are erased at
 * runtime, and are the compiler's to check.
 */
const RUNTIME_EXPORTS = [
    'AUDIO_ONLY_ANGLE_ID',
    'DEFAULT_ANGLE_ID',
    'DEFAULT_LEAD_SECONDS',
    'DEFAULT_POLL_INTERVAL_MS',
    'DEFAULT_RECOVERY_POLICY',
    'DEFAULT_WARM_BYTES',
    'Emitter',
    'KEY_CONTENT_TYPE',
    'LUMINARY_KEY_PLACEHOLDER_URI',
    'PLAYLIST_CONTENT_TYPE',
    'PipelineError',
    'PlayerController',
    'Poller',
    'SidecarLoader',
    'StateStore',
    'VTT_CONTENT_TYPE',
    'absolutize',
    'applyQualityCap',
    'buildAudioOnlyMaster',
    'buildChunkSchedules',
    'bytesToHex',
    'chapterTrackId',
    'collectMasterRefs',
    'createInitialState',
    'decodeMaybeEncrypted',
    'decryptLmcenc',
    'describeLiveness',
    'describeMaster',
    'fetchBytes',
    'fetchMaybeEncrypted',
    'hasAes128Key',
    'hasAudioOnlyRendering',
    'hasVideoVariants',
    'hexToBytes',
    'isAudioOnlyMaster',
    'isMasterPlaylistText',
    'isMissing',
    'keyBytes',
    'listQualities',
    'listSegmentUris',
    'loadMaster',
    'mungeSource',
    'parseMasterText',
    'parseVttCues',
    'parseVttTimestamp',
    'pickDefaultChapterTrack',
    'referencedPlaylistUris',
    'resolveLivePlaylist',
    'resolveRecoveryPolicy',
    'rewriteMediaPlaylist',
    'sortQualities',
    'substituteMasterRefs',
    'subtitleSidecarId',
    'toPlayerError',
    'toQuality',
];

describe('player-core exports', () => {
    it('exports exactly its public surface, by name', () => {
        expect(Object.keys(pkg).sort()).toEqual(RUNTIME_EXPORTS);
    });

    it('exports the live refresh step a serving layer runs on every request', () => {
        // What a web strategy calls per engine request, and what a native
        // resolver ports: the package root is where both reach it.
        expect(pkg.resolveLivePlaylist).toBe(resolveLivePlaylist);
        expect(pkg.describeLiveness).toBe(describeLiveness);
    });
});
