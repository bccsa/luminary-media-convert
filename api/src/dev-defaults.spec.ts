import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_API_TOKEN, applyDevDefaults } from './dev-defaults.js';

/** A logger that records rather than prints. */
function fakeLogger() {
    return { warn: vi.fn() } as unknown as Parameters<typeof applyDevDefaults>[0];
}

const KEYS = [
    'NODE_ENV',
    'LOCAL_API_TOKEN',
    'MASTER_API_KEY',
    'CMS_ALLOWED_ORIGINS',
] as const;

describe('applyDevDefaults', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });

    it('fills the token and the allowlist a fresh clone has neither of', () => {
        applyDevDefaults(fakeLogger());

        expect(process.env.LOCAL_API_TOKEN).toBe(DEV_API_TOKEN);
        // The Vite client and the CMS mock: an empty allowlist refuses both, and
        // standalone there is no approver to ask.
        expect(process.env.CMS_ALLOWED_ORIGINS).toContain('http://localhost:5173');
        expect(process.env.CMS_ALLOWED_ORIGINS).toContain('http://localhost:5199');
    });

    it('says so, rather than defaulting silently', () => {
        // The whole risk of this file is a dev token mistaken for configuration.
        const logger = fakeLogger();

        applyDevDefaults(logger);

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
            'production'
        );
    });

    it('does nothing at all in production', () => {
        process.env.NODE_ENV = 'production';
        const logger = fakeLogger();

        applyDevDefaults(logger);

        expect(process.env.LOCAL_API_TOKEN).toBeUndefined();
        expect(process.env.CMS_ALLOWED_ORIGINS).toBeUndefined();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('never overrides what the environment already says', () => {
        process.env.LOCAL_API_TOKEN = 'a-real-secret';
        process.env.CMS_ALLOWED_ORIGINS = 'https://cms.example.com';
        const logger = fakeLogger();

        applyDevDefaults(logger);

        expect(process.env.LOCAL_API_TOKEN).toBe('a-real-secret');
        expect(process.env.CMS_ALLOWED_ORIGINS).toBe('https://cms.example.com');
        // Nothing was defaulted, so there is nothing to announce.
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('leaves the deprecated MASTER_API_KEY in charge when that is all there is', () => {
        // Defaulting a token on top of it would silently ignore the key sitting
        // in the operator's own .env, which is the thing its deprecation warning
        // exists to avoid.
        process.env.MASTER_API_KEY = 'legacy-secret';

        applyDevDefaults(fakeLogger());

        expect(process.env.LOCAL_API_TOKEN).toBeUndefined();
    });

    it('fills only the half that is missing', () => {
        process.env.CMS_ALLOWED_ORIGINS = 'https://cms.example.com';

        applyDevDefaults(fakeLogger());

        expect(process.env.LOCAL_API_TOKEN).toBe(DEV_API_TOKEN);
        expect(process.env.CMS_ALLOWED_ORIGINS).toBe('https://cms.example.com');
    });
});
