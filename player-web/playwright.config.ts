import { defineConfig, devices } from '@playwright/test';

/** `ENGINE=v8|v10` picks which demo build the specs drive; the specs themselves are engine-neutral. */
const engine = process.env.ENGINE ?? 'v8';
const demoPort = engine === 'v10' ? 5183 : 5182;
/**
 * The tests get a fixture server of their own. They arm faults, reset the simulated live stream and clear the
 * request log, which would reach into anyone looking at the same server in a browser (the compare page uses
 * 5190), and be reached into by it.
 */
const fixturePort = process.env.FIXTURE_PORT ?? '5191';

export default defineConfig({
    testDir: 'e2e',
    // Pixel baselines are taken per run (see zz-visual.spec.ts) and kept out of the repository.
    snapshotPathTemplate: process.env.SNAPSHOT_DIR ? process.env.SNAPSHOT_DIR + '/{arg}-{projectName}{ext}' : '{testDir}/__screenshots__/{arg}-{projectName}{ext}',
    testMatch: '**/*.spec.ts',
    timeout: 60_000,
    workers: 1,
    reporter: [['list']],
    use: { baseURL: `http://127.0.0.1:${demoPort}`, trace: 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: [
        {
            command: 'node e2e/fixtures/serve.mjs',
            env: { FIXTURE_PORT: fixturePort },
            url: `http://127.0.0.1:${fixturePort}/__log`,
            reuseExistingServer: true,
        },
        {
            // Built first for v10: `built.spec.ts` drives the library as an app gets it, not the source.
            command: engine === 'v10' ? 'npm --prefix ../player-web-v10 run build:lib && npm --prefix ../player-web-v10 run demo' : 'npm run demo',
            url: `http://127.0.0.1:${demoPort}`,
            reuseExistingServer: true,
        },
    ],
});
