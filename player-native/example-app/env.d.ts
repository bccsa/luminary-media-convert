/// <reference types="vite/client" />

declare module '*.vue' {
    import type { DefineComponent } from 'vue';
    const component: DefineComponent<object, object, unknown>;
    export default component;
}

/** Resolved per build target by `vite-plugins/buildTargetVirtuals.ts`. */
declare module 'virtual:video-player' {
    export * from '@/build-time/plugins/video-player/index';
}
