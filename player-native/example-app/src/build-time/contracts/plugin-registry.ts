import type { App } from 'vue';
import { installVideoPlayer, VideoPlayerKey } from 'virtual:video-player';

/**
 * Calls each `install*` from the resolved `virtual:*` modules, so build-target services are
 * `provide`d on the app, as `bccsa/luminary`'s `plugin-registry.ts` does.
 */
export function installPlugins(app: App): void {
    installVideoPlayer(app);
}

export { VideoPlayerKey };
export type { VideoPlayerService, PlaybackMode, PlayerHandle, ModeInfo } from './video-player/contract';

/** Vue `app.use()` entry that registers the active build target's services. */
export const appPluginsManager = {
    install(app: App) {
        installPlugins(app);
    },
};
