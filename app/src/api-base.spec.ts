import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `API_BASE` is resolved once at module load, so each case needs a fresh import
 * after the environment is stubbed.
 */
async function apiBaseWith(env: { DEV: boolean; VITE_API_URL?: string }) {
    vi.resetModules();
    vi.stubEnv('DEV', env.DEV);
    // Vitest loads the app's real `.env`, which on a developer machine usually
    // does set this — so "nothing configured" has to be stated, not assumed.
    vi.stubEnv('VITE_API_URL', env.VITE_API_URL as string | undefined);
    const mod = await import('./api');
    return mod.API_BASE;
}

describe('API_BASE', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('points at the standalone API in browser dev with nothing configured', async () => {
        // Same-origin would send every request to Vite's own port, which is the
        // second of the three things a fresh clone got wrong.
        expect(await apiBaseWith({ DEV: true })).toBe('http://127.0.0.1:3000');
    });

    it('stays same-origin in a build, where the API serves the client', async () => {
        // The packaged app must never carry a dev port baked into the bundle.
        expect(await apiBaseWith({ DEV: false })).toBe('');
    });

    it('lets VITE_API_URL win, which is how the Electron pairing is set', async () => {
        // Desktop dev runs the API on 31711, not the standalone default.
        expect(
            await apiBaseWith({ DEV: true, VITE_API_URL: 'http://127.0.0.1:31711' })
        ).toBe('http://127.0.0.1:31711');
    });
});
