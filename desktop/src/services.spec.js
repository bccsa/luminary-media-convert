import { EncoderService } from './services.js';

function makeService() {
    const service = new EncoderService({
        entry: '/app/services/api/dist/main.js',
        cwd: '/app/services/api',
        workDir: '/data/work',
        logDir: '/data/logs',
        ffmpeg: '/opt/homebrew/bin/ffmpeg',
        ffprobe: '/opt/homebrew/bin/ffprobe',
    });
    service.port = 12345;
    return service;
}

describe('EncoderService.buildEnv', () => {
    describe('session retention', () => {
        // Nothing sits behind this encoder: its session list is the user's
        // history, not a server's scratch space. The encoder's own defaults
        // sweep finished sessions after 24h and idle ones after 6h, which here
        // would delete someone's work while they were still using the app.
        it('keeps finished sessions forever', () => {
            expect(makeService().buildEnv({}).SESSION_MAX_AGE_HOURS).toBe(
                'never',
            );
        });

        it('keeps unfinished sessions forever', () => {
            // 'uploaded' means probed and waiting for the user to configure the
            // encode — someone coming back after lunch, not an abandoned upload.
            expect(
                makeService().buildEnv({}).SESSION_ABANDONED_MAX_AGE_HOURS,
            ).toBe('never');
        });

        it.each([
            ['SESSION_MAX_AGE_HOURS', '48'],
            ['SESSION_ABANDONED_MAX_AGE_HOURS', '12'],
        ])('lets %s be overridden from the environment', (key, value) => {
            const env = makeService().buildEnv({ [key]: value });
            expect(env[key]).toBe(value);
        });
    });

    describe('ingestion mode', () => {
        it('disables tus — the source is already on this machine', () => {
            expect(makeService().buildEnv({}).TUS_ENABLED).toBe('false');
        });

        it('enables reading a source from disk', () => {
            expect(makeService().buildEnv({}).ALLOW_LOCAL_SOURCE).toBe('true');
        });
    });

    describe('exposure', () => {
        it('binds loopback only', () => {
            // A master key is not a reason to put a transcoder on the network.
            expect(makeService().buildEnv({}).BIND_HOST).toBe('127.0.0.1');
        });

        it('gives the encoder a master key', () => {
            expect(makeService().buildEnv({}).MASTER_API_KEY).toMatch(
                /^[0-9a-f]{64}$/,
            );
        });

        it('mints a different key per instance', () => {
            expect(makeService().masterKey).not.toBe(makeService().masterKey);
        });
    });

    describe('ffmpeg', () => {
        it('passes absolute paths, since a GUI launch has no useful PATH', () => {
            const env = makeService().buildEnv({});
            expect(env.FFMPEG_PATH).toBe('/opt/homebrew/bin/ffmpeg');
            expect(env.FFPROBE_PATH).toBe('/opt/homebrew/bin/ffprobe');
        });

        it('also prepends its directory to PATH', () => {
            const env = makeService().buildEnv({ PATH: '/usr/bin' });
            expect(env.PATH.startsWith('/opt/homebrew/bin')).toBe(true);
            expect(env.PATH).toContain('/usr/bin');
        });

        it('survives an environment with no PATH at all', () => {
            expect(makeService().buildEnv({}).PATH).toBe('/opt/homebrew/bin');
        });
    });

    it('runs the Electron binary as plain Node', () => {
        expect(makeService().buildEnv({}).ELECTRON_RUN_AS_NODE).toBe('1');
    });

    it('points the encoder at the shell-owned work directory', () => {
        expect(makeService().buildEnv({}).WORK_DIR).toBe('/data/work');
    });
});
