import { SessionCleanupService } from './session-cleanup.service.js';

function makeService(cleanup = vi.fn().mockReturnValue(0)) {
    const sessionService = { cleanup } as any;
    return { service: new SessionCleanupService(sessionService), cleanup };
}

describe('SessionCleanupService', () => {
    afterEach(() => {
        delete process.env.SESSION_MAX_AGE_HOURS;
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
});
