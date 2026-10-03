import type { App, Component } from 'vue';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import { LuminaryPlayer, isYouTubeUrl } from '@luminary-media-converter/player-web';
import { LuminaryPlayer as NativePlugin } from '@luminary-media-converter/player-native';
import type { ModeInfo, PlaybackMode, VideoPlayerService } from '../src/build-time/contracts/video-player/contract';
import { VideoPlayerKey } from '../src/build-time/contracts/video-player/token';
import { AppResumeKey, NativePluginKey, instrument } from '../src/players/nativePlugin';
import { SimulatedNativePlugin } from '../src/players/SimulatedNativePlugin';
import NativeVideoPlayer from '../src/players/NativeVideoPlayer.vue';

export { VideoPlayerKey };

/**
 * The packaged-app build, reached through `VITE_NATIVE_IMPL_DIR` as
 * `luminary-deployment/capacitor/native-plugins/` will be: LMC sources play natively, and YouTube
 * stays in `player-web` on every platform. Web mode is kept for side-by-side comparison in the
 * same WebView.
 */
class NativeVideoPlayerService implements VideoPlayerService {
    readonly target = 'native' as const;
    readonly modes: readonly ModeInfo[];

    constructor(private readonly onDevice: boolean) {
        this.modes = [
            {
                id: 'native',
                label: onDevice ? 'Native' : 'Native (sim)',
                available: true,
                reason: onDevice ? undefined : 'Not on a device: the simulated native side stands in',
            },
            { id: 'web', label: 'Web', available: true },
            { id: 'youtube', label: 'YouTube', available: true },
        ];
    }

    modeFor(source: PlayerSource): PlaybackMode {
        return isYouTubeUrl(source.masterUrl) ? 'youtube' : 'native';
    }

    component(mode: PlaybackMode): Component {
        return mode === 'native' ? NativeVideoPlayer : (LuminaryPlayer as Component);
    }
}

export function installVideoPlayer(app: App): void {
    const onDevice = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LuminaryPlayer');
    app.provide(NativePluginKey, instrument(onDevice ? NativePlugin : new SimulatedNativePlugin()));
    // `visibilitychange` is unreliable in Android's WebView; `resume` is the second signal.
    app.provide(AppResumeKey, (listener: () => void) => {
        const handle = CapacitorApp.addListener('resume', listener);
        return () => void handle.then((h) => h.remove());
    });
    app.provide(VideoPlayerKey, new NativeVideoPlayerService(onDevice));
}
