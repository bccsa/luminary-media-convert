import type { App } from 'vue';
import { VideoPlayerKey } from '@/build-time/contracts/video-player/token';
import { NativePluginKey, instrument } from '@/players/nativePlugin';
import { SimulatedNativePlugin } from '@/players/SimulatedNativePlugin';
import { WebVideoPlayerService } from './video-player-web';

export { VideoPlayerKey };

/** Provides the browser build's video player, and the simulated native side its Native mode uses. */
export function installVideoPlayer(app: App): void {
    app.provide(NativePluginKey, instrument(new SimulatedNativePlugin()));
    app.provide(VideoPlayerKey, new WebVideoPlayerService());
}
