// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApiToken, resetApiToken } from './auth-token';

/**
 * `import.meta.env` is replaced at build time, so it cannot be assigned — but
 * `vi.stubEnv` reaches the same object Vite exposes to the module under test.
 */
function withEnv(env: { DEV?: boolean; VITE_API_TOKEN?: string }) {
    if (env.DEV !== undefined) vi.stubEnv('DEV', env.DEV);
    vi.stubEnv('VITE_API_TOKEN', env.VITE_API_TOKEN ?? '');
}

describe('getApiToken', () => {
    beforeEach(() => {
        resetApiToken();
        delete (window as { luminary?: unknown }).luminary;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        resetApiToken();
        delete (window as { luminary?: unknown }).luminary;
    });

    it('prefers the preload bridge, which is the real token', async () => {
        // The desktop app mints one per launch; nothing in the bundle should
        // ever stand in for it.
        withEnv({ DEV: true, VITE_API_TOKEN: 'from-env' });
        (window as { luminary?: unknown }).luminary = {
            getApiToken: async () => 'from-bridge',
        };

        await expect(getApiToken()).resolves.toBe('from-bridge');
    });

    it('uses VITE_API_TOKEN when there is no bridge', async () => {
        withEnv({ DEV: true, VITE_API_TOKEN: 'from-env' });

        await expect(getApiToken()).resolves.toBe('from-env');
    });

    it('falls back to the shared dev token so a fresh clone needs no .env', async () => {
        // Must match DEV_API_TOKEN in api/src/dev-defaults.ts, or the UI is
        // refused by the API it is paired with.
        withEnv({ DEV: true });

        await expect(getApiToken()).resolves.toBe('dev-token');
    });

    it('still refuses outside dev, where a placeholder would be a real hole', async () => {
        withEnv({ DEV: false });

        await expect(getApiToken()).rejects.toThrow('No API token available');
    });

    it('ignores VITE_API_TOKEN in a build, so no .env token ships in the bundle', async () => {
        /*
         * Vite bakes every VITE_* value into every build, so reading this one
         * outside the DEV check embedded a developer's token in the release —
         * `dev-token` was sitting in app/dist. Never exploitable: the bridge
         * answers first in the packaged app, and the host mints a fresh token
         * per launch that would not match. But a credential in a shipped
         * artifact should not depend on being unreachable to be harmless.
         */
        withEnv({ DEV: false, VITE_API_TOKEN: 'leakme-poison-token' });

        await expect(getApiToken()).rejects.toThrow('No API token available');
    });
});
