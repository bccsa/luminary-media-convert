import { describe, it, expect, vi } from 'vitest';
import * as core from '@luminary-media-converter/player-core';
import * as pkg from '../src/index';

/**
 * The runtime surface of `@luminary-media-converter/player-web-legacy`.
 *
 * The Luminary app consumes this package through a submodule, and a symbol that
 * disappears from it is found at the app's next build, not here. So its own
 * exports are pinned by name — nothing appears or disappears without a change
 * to this list saying so — and the paths a host takes without `LuminaryPlayer`
 * are walked from the package root, which is where a missing export shows.
 * Type-only exports are erased at runtime, and are the compiler's to check.
 */
const OWN_RUNTIME_EXPORTS = [
    'AUTO_HIDE_MS',
    'AudioVideoToggle',
    'BYTE_RANGE_TIMEOUT_FALLBACK_MS',
    'BYTE_RANGE_TIMEOUT_MULTIPLIER',
    'BlobServeStrategy',
    'ChunkPrefetcher',
    'DEFAULT_CONTROLS',
    'DEFAULT_MESSAGES',
    'LIVE_PLAYLIST_URI_PREFIX',
    'LuminaryPlayer',
    'RecoveryLadder',
    'SILENT_AUDIO_DATA_URI',
    'SKIP_ICON_SECONDS',
    'TRANSPARENT_POSTER',
    'UNKNOWN_WAITING_STRIKES',
    'UNKNOWN_WAITING_WINDOW_MS',
    'UnsupportedBrowserError',
    'VhsStallSignals',
    'VideoJsAdapter',
    'YOUTUBE_TECH',
    'buildVideoJsOptions',
    'byteRangeBackstopMs',
    'createKeepAlive',
    'extractYouTubeId',
    'findPreferredTrack',
    'formatSeconds',
    'installAutoHide',
    'installByteRangeTimeout',
    'installLivePlaylistXhr',
    'installMemoryKeyXhr',
    'isLivePlaylistUri',
    'isVideoJsEngineSupported',
    'isYouTubeUrl',
    'matchesPreferredLanguage',
    'mergeControls',
    'mergeMessages',
    'monotonicNow',
    'preferYouTubeTech',
    'singleFlight',
    'snapSkipSeconds',
    'toVideoJsYouTubeUrl',
    'usePlayerState',
    'vhsHandler',
    'vhsTech',
    'wrapVhsXhr',
];

describe('player-web-legacy exports', () => {
    it('exports exactly its own public surface, by name', () => {
        const own = Object.keys(pkg).filter((name) => !(name in core));

        expect(own.sort()).toEqual(OWN_RUNTIME_EXPORTS);
    });

    it('re-exports player-core whole, as the very same bindings', () => {
        // A host catches a PipelineError from this package and builds a
        // PlayerController from it; a copy would fail `instanceof` against the
        // core's own, which is what every other package throws.
        const exported = pkg as Record<string, unknown>;
        for (const [name, value] of Object.entries(core)) {
            expect(exported[name], name).toBe(value);
        }
    });

    it('lets a host that drives its own video.js player put the YouTube tech in front', () => {
        // The options list only the tech that is always loaded, so a YouTube
        // source needs the step LuminaryPlayer takes before setting one.
        const player = { options_: pkg.buildVideoJsOptions(pkg.DEFAULT_CONTROLS) } as any;

        pkg.preferYouTubeTech(player);

        expect(player.options_.techOrder).toEqual([pkg.YOUTUBE_TECH, 'html5']);
    });

    it('lets a host that builds its own controller serve a live playlist', () => {
        // The strategy mints the addresses the adapter it is paired with answers.
        const strategy = new pkg.BlobServeStrategy({ fetchImpl: vi.fn() as unknown as typeof fetch });
        const url = 'https://live.example.com/channel/chunks.m3u8';

        const address = strategy.serveLive({ url, baseUrl: url, refreshSec: 4 });

        expect(pkg.isLivePlaylistUri(address)).toBe(true);
        expect(address.startsWith(pkg.LIVE_PLAYLIST_URI_PREFIX)).toBe(true);
    });
});
