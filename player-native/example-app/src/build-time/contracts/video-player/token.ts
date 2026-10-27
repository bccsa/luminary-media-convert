import type { InjectionKey } from 'vue';
import type { VideoPlayerService } from './contract';

/** Kept apart from the virtual module, so a component can inject without pulling in an implementation. */
export const VideoPlayerKey: InjectionKey<VideoPlayerService> = Symbol('VideoPlayerService');
