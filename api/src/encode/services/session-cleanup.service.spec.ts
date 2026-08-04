import { SessionCleanupService } from './session-cleanup.service.js';

function makeService(
    cleanup = vi.fn().mockReturnValue(0),
    cleanupAbandoned = vi.fn().mockReturnValue(0),
) {
    const sessionService = { cleanup, cleanupAbandoned } as any;
    return {
        service: new SessionCleanupService(sessionService),
        cleanup,
        cleanupAbandoned,
    };
}

describe('SessionCleanupService', () => {
    afterEach(() => {
        delete process.env.SESSION_MAX_AGE_HOURS;
        delete process.env.SESSION_ABANDONED_MAX_AGE_HOURS;
    });

    it('sweeps sessions older than a day by default', () => {
        const { service, cleanup } = makeService();
        service.sweep();
        expect(cleanup).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
    });

    it('honours a configured retention window', () => {
        process.env.SESSION_MAX_AGE_HOURS = '72';
        const { service, cleanup } = makeService();
        service.sweep();
        expect(cleanup).toHaveBeenCalledWith(72 * 60 * 60 * 1000);
    });

    it('accepts a window shorter than an hour', () => {
        process.env.SESSION_MAX_AGE_HOURS = '0.5';
        const { service, cleanup } = makeService();
        service.sweep();
        expect(cleanup).toHaveBeenCalledWith(30 * 60 * 1000);
    });

    it.each(['nonsense', '0', '-5', ''])(
        'falls back to the default rather than deleting early on %p',
        (value) => {
            process.env.SESSION_MAX_AGE_HOURS = value;
            const { service, cleanup } = makeService();
            service.sweep();
            expect(cleanup).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
        },
    );

    it('reports how many it removed', () => {
        const { service } = makeService(vi.fn().mockReturnValue(3));
        expect(service.sweep()).toBe(3);
    });

    describe('retention disabled', () => {
        // The desktop build has no database behind the encoder, so the session
        // list is the user's history rather than scratch space — sweeping it
        // would delete their work.
        it.each(['never', 'off', 'none', 'NEVER', ' Off '])(
            'keeps finished sessions forever on %p',
            (value) => {
                process.env.SESSION_MAX_AGE_HOURS = value;
                const { service, cleanup } = makeService();
                service.sweep();
                expect(cleanup).not.toHaveBeenCalled();
            },
        );

        it.each(['never', 'off', 'none'])(
            'keeps abandoned sessions forever on %p',
            (value) => {
                process.env.SESSION_ABANDONED_MAX_AGE_HOURS = value;
                const { service, cleanupAbandoned } = makeService();
                service.sweep();
                expect(cleanupAbandoned).not.toHaveBeenCalled();
            },
        );

        it('disables each window independently', () => {
            process.env.SESSION_MAX_AGE_HOURS = 'never';
            const { service, cleanup, cleanupAbandoned } = makeService();
            service.sweep();
            expect(cleanup).not.toHaveBeenCalled();
            // Abandoned sessions are unfinished uploads holding disk nobody is
            // going to use — still worth sweeping even when history is kept.
            expect(cleanupAbandoned).toHaveBeenCalledWith(6 * 60 * 60 * 1000);
        });

        it('reports zero rather than counting a sweep it skipped', () => {
            process.env.SESSION_MAX_AGE_HOURS = 'never';
            process.env.SESSION_ABANDONED_MAX_AGE_HOURS = 'never';
            const { service } = makeService(
                vi.fn().mockReturnValue(5),
                vi.fn().mockReturnValue(5),
            );
            expect(service.sweep()).toBe(0);
        });
    });

    describe('abandoned sessions', () => {
        it('sweeps them on a shorter clock than finished ones', () => {
            // A forgotten upload holds space nobody will use; a finished session
            // may still be wanted.
            const { service, cleanupAbandoned } = makeService();
            service.sweep();
            expect(cleanupAbandoned).toHaveBeenCalledWith(6 * 60 * 60 * 1000);
        });

        it('honours a configured idle window', () => {
            process.env.SESSION_ABANDONED_MAX_AGE_HOURS = '2';
            const { service, cleanupAbandoned } = makeService();
            service.sweep();
            expect(cleanupAbandoned).toHaveBeenCalledWith(2 * 60 * 60 * 1000);
        });

        it.each(['nonsense', '0', '-5', ''])(
            'falls back rather than deleting early on %p',
            (value) => {
                process.env.SESSION_ABANDONED_MAX_AGE_HOURS = value;
                const { service, cleanupAbandoned } = makeService();
                service.sweep();
                expect(cleanupAbandoned).toHaveBeenCalledWith(
                    6 * 60 * 60 * 1000,
                );
            },
        );

        it('counts both sweeps in what it reports', () => {
            const { service } = makeService(
                vi.fn().mockReturnValue(3),
                vi.fn().mockReturnValue(2),
            );
            expect(service.sweep()).toBe(5);
        });
    });
});
