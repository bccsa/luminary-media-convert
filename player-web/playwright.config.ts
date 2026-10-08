import { defineConfig, devices } from '@playwright/test';

/** `ENGINE=v8|v10` picks which demo build the specs drive; the specs themselves are engine-neutral. */
const engine = process.env.ENGINE ?? 'v8';
const demoPort = engine === 'v10' ? 5183 : 5182;

export default defineConfig({
    testDir: 'e2e',
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
        { command: 'node e2e/fixtures/serve.mjs', url: 'http://127.0.0.1:5190/__log', reuseExistingServer: true },
        {
            command: engine === 'v10' ? 'npm --prefix ../player-web-v10 run demo' : 'npm run demo',
            url: `http://127.0.0.1:${demoPort}`,
            reuseExistingServer: true,
        },
    ],
});
