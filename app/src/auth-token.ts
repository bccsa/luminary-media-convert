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

    // Both fallbacks below are development-only, and both sit inside the `DEV`
    // check for the same reason: Vite bakes every `VITE_*` value it finds into
    // every build, so reading `VITE_API_TOKEN` unconditionally embedded a
    // developer's token in the shipped bundle. Harmless — the bridge above
    // answers first, and the host mints a fresh token per launch that would not
    // match it anyway — but a credential in a release artifact should not rely
    // on being unreachable to be safe.
    if (import.meta.env.DEV) {
        const fromEnv = import.meta.env.VITE_API_TOKEN;
        if (fromEnv) {
            cached = fromEnv;
            return cached;
        }

        // Browser development with no `.env` at all. The API's own dev defaults
        // accept this same literal (`api/src/dev-defaults.ts`), so a fresh clone
        // works without one being copied by hand — and the two have to stay in
        // agreement or the UI is refused by the API it is paired with.
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
