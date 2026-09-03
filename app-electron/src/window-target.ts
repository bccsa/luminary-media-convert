/**
 * Where a new window should point — and whether there is anywhere to point it
 * yet.
 *
 * In a packaged build the API serves the renderer, so a window has no target
 * until the server is listening. That is not a rare startup race: a CMS
 * protocol link *launches* the app, so `open-url` fires as soon as Electron is
 * ready, which is well before the Nest server has finished booting. Reaching
 * for the URL at that moment read `.url` off an undefined server and took the
 * whole main process down with "A JavaScript error occurred in the main
 * process". Undefined here means "not yet" — the caller declines to build a
 * window, and startup builds one as soon as the server is up.
 *
 * Development has no such dependency: the renderer is Vite's dev server on its
 * own port, running whether or not the API is.
 */
export function resolveWindowTarget(opts: {
    isPackaged: boolean;
    /** The running API's base URL, once it is listening. */
    serverUrl?: string;
    /** Vite's dev server, when the harness names one. */
    devRendererUrl?: string;
}): string | undefined {
    if (opts.isPackaged) return opts.serverUrl;
    return opts.devRendererUrl ?? 'http://localhost:5173';
}
