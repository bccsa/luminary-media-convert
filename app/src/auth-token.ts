/**
 * The UI's credential for the local Encoding API.
 *
 * In the packaged desktop app the token is minted by the main process and
 * handed to the renderer over the preload bridge, so it never has to be
 * embedded in the bundle. Running the UI in a plain browser (dev) there is no
 * bridge, and `VITE_API_TOKEN` stands in for it.
 */

let cached: string | null = null;

export async function getApiToken(): Promise<string> {
    if (cached) return cached;

    const bridge = typeof window !== 'undefined' ? window.luminary : undefined;
    if (bridge) {
        cached = await bridge.getApiToken();
        return cached;
    }

    const fromEnv = import.meta.env.VITE_API_TOKEN;
    if (!fromEnv) {
        throw new Error(
            'No API token available — run inside the desktop app, or set VITE_API_TOKEN for browser development.'
        );
    }
    cached = fromEnv;
    return cached;
}

/** Drops the memoized token. Only useful in tests. */
export function resetApiToken(): void {
    cached = null;
}
