import type { Component } from 'vue';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import { LuminaryPlayer, isYouTubeUrl } from '@luminary-media-converter/player-web';
import type { ModeInfo, PlaybackMode, VideoPlayerService } from '@/build-time/contracts/video-player/contract';
import NativeVideoPlayer from '@/players/NativeVideoPlayer.vue';

/**
 * The browser build: `player-web` for LMC and YouTube sources. Native mode runs against the
 * simulated plugin here, so the bridge's TypeScript half can be exercised without a device.
 */
export class WebVideoPlayerService implements VideoPlayerService {
    readonly target = 'web' as const;
    readonly modes: readonly ModeInfo[] = [
        { id: 'web', label: 'Web', available: true },
        { id: 'native', label: 'Native (sim)', available: true, reason: 'Simulated native side: no device in a browser build' },
        { id: 'youtube', label: 'YouTube', available: true },
    ];

    modeFor(source: PlayerSource): PlaybackMode {
        return isYouTubeUrl(source.masterUrl) ? 'youtube' : 'web';
    }

    component(mode: PlaybackMode): Component {
        return mode === 'native' ? NativeVideoPlayer : (LuminaryPlayer as Component);
    }
}
