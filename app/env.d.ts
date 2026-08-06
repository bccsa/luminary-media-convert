/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * Base URL of the local Encoding API. Left unset in the packaged app —
     * the renderer and the API share an origin there — and set to the API's
     * dev port when the UI runs in a plain browser.
     */
    readonly VITE_API_URL?: string;
    /**
     * UI token for the Encoding API, used only outside Electron. In the
     * packaged app the token comes from `window.luminary.getApiToken()`.
     */
    readonly VITE_API_TOKEN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

/**
 * Bridge exposed by the Electron preload script. Absent when the UI is opened
 * in a plain browser, which is why every caller has to guard on it.
 */
interface LuminaryBridge {
    /** The API token this desktop instance was started with. */
    getApiToken(): Promise<string>;
    /** Absolute path of a dropped File — the browser File API has none. */
    getPathForFile(file: File): string;
    /** Native open dialog; resolves to an absolute path, or null if cancelled. */
    showOpenDialog(): Promise<string | null>;
}

interface Window {
    luminary?: LuminaryBridge;
}

declare module '*.vue' {
    import type { DefineComponent } from 'vue';
    const component: DefineComponent<object, object, unknown>;
    export default component;
}
