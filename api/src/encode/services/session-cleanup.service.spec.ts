import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCleanupService } from './session-cleanup.service.js';
import type { SessionService } from './session.service.js';

const HOUR_MS = 60 * 60 * 1000;

const cleanupAbandoned = vi.fn<(maxAgeMs: number) => number>();
const sessions = { cleanupAbandoned } as unknown as SessionService;

function build(): SessionCleanupService {
    return new SessionCleanupService(sessions);
}

beforeEach(() => {
    cleanupAbandoned.mockReset().mockReturnValue(0);
});

afterEach(() => {
    delete process.env.SESSION_ABANDONED_MAX_AGE_HOURS;
});

describe('SessionCleanupService', () => {
    it('sweeps at the six-hour default', () => {
        build().sweep();

        expect(cleanupAbandoned).toHaveBeenCalledWith(6 * HOUR_MS);
    });

    it('honours SESSION_ABANDONED_MAX_AGE_HOURS', () => {
        process.env.SESSION_ABANDONED_MAX_AGE_HOURS = '2';

        build().sweep();

        expect(cleanupAbandoned).toHaveBeenCalledWith(2 * HOUR_MS);
    });

    it('accepts a fractional window', () => {
        // Useful on a small volume, and nothing in the parsing requires whole
        // hours — so a value that works must not be rejected for looking odd.
        process.env.SESSION_ABANDONED_MAX_AGE_HOURS = '0.5';

        build().sweep();

        expect(cleanupAbandoned).toHaveBeenCalledWith(0.5 * HOUR_MS);
    });

    it.each(['nonsense', '0', '-3', 'NaN', ''])(
        'falls back to the default rather than deleting early on %o',
        (value) => {
            // This sweep deletes a user's uploaded media. A misread setting must
            // never shorten the window — the safe direction is to keep files
            // longer than asked, not to bin them sooner.
            process.env.SESSION_ABANDONED_MAX_AGE_HOURS = value;

            build().sweep();

            expect(cleanupAbandoned).toHaveBeenCalledWith(6 * HOUR_MS);
        }
    );

    it('ignores surrounding whitespace', () => {
        process.env.SESSION_ABANDONED_MAX_AGE_HOURS = '  3  ';

        build().sweep();

        expect(cleanupAbandoned).toHaveBeenCalledWith(3 * HOUR_MS);
    });

    it('returns how many sessions were swept', () => {
        cleanupAbandoned.mockReturnValue(4);

        expect(build().sweep()).toBe(4);
    });

    it('re-reads the setting on every sweep', () => {
        // The service is long-lived and the schedule fires for the life of the
        // process; reading once at construction would pin the first value.
        const service = build();
        service.sweep();

        process.env.SESSION_ABANDONED_MAX_AGE_HOURS = '1';
        service.sweep();

        expect(cleanupAbandoned).toHaveBeenNthCalledWith(1, 6 * HOUR_MS);
        expect(cleanupAbandoned).toHaveBeenNthCalledWith(2, 1 * HOUR_MS);
    });
});
