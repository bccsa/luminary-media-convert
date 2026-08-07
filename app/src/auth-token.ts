/**
 * The UI's credential for the local Encoding API.
 *
 * In the packaged desktop app the token is minted by the main process and
 * handed to the renderer over the preload bridge, so it never has to be
 * embedded in the bundle. Running the UI in a plain browser (dev) there is no
 * bridge, and `VITE_API_TOKEN` stands in for it.
 */

/**
 * Must match `DEV_API_TOKEN` in `api/src/dev-defaults.ts`. Duplicated rather
 * than shared because these are two separately bundled processes with no common
 * runtime module, and a shared package for one placeholder string would be a
 * heavier coupling than the literal.
 */
const DEV_API_TOKEN = 'dev-token';

let cached: string | null = null;

export async function getApiToken(): Promise<string> {
    if (cached) return cached;

    const bridge = typeof window !== 'undefined' ? window.luminary : undefined;
    if (bridge) {
        cached = await bridge.getApiToken();
        return cached;
    }

    const fromEnv = import.meta.env.VITE_API_TOKEN;
    if (fromEnv) {
        cached = fromEnv;
        return cached;
    }

    // Browser development with no `.env` at all. The API's own dev defaults
    // accept this same literal (`api/src/dev-defaults.ts`), so a fresh clone
    // works without one being copied by hand — and the two have to stay in
    // agreement or the UI is refused by the API it is paired with.
    //
    // `import.meta.env.DEV` is false for every `vite build`, so this cannot
    // reach the packaged app, where the bridge supplies the real token anyway.
    if (import.meta.env.DEV) {
        cached = DEV_API_TOKEN;
        return cached;
    }

    throw new Error(
        'No API token available — run inside the desktop app, or set VITE_API_TOKEN for browser development.'
    );
}

/** Drops the memoized token. Only useful in tests. */
export function resetApiToken(): void {
    cached = null;
}
