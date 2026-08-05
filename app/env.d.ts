/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vue" />

interface ImportMetaEnv {
    readonly VITE_AUTH0_DOMAIN: string;
    readonly VITE_AUTH0_CLIENT_ID: string;
    readonly VITE_AUTH0_AUDIENCE: string;
    /**
     * The SaaS service. The Encoding API's address is not configured here — it
     * comes back from GET /saas/me at runtime, so it can differ per user.
     */
    readonly VITE_SAAS_SERVICE_URL: string;
    readonly VITE_TUS_PARALLEL_UPLOADS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

declare module '*.vue' {
    import type { DefineComponent } from 'vue';
    const component: DefineComponent<object, object, unknown>;
    export default component;
}

/** True in the Electron build. Set by `define` in vite.config.ts. */
declare const __DESKTOP__: boolean;
