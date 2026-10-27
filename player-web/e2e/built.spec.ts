import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The player as built, which is what an app installs. Everything else here drives source through the demo, and
// source keeps imports the build can drop: the first version of this spec was written after the built library
// turned out to register no element at all, with every other test green.

const FIXTURES = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 5191}`;
const KEY_HEX = '00112233445566778899aabbccddeeff';

test.beforeAll(() => {
    const dist = resolve(process.cwd(), 'dist/index.js');
    if (!existsSync(dist)) throw new Error(`no built library at ${dist}: run \`npm -w player-web run build:lib\` first`);
});

const open = (page: import('@playwright/test').Page, fixture = 'encrypted', extra = '') =>
    page.goto(`http://127.0.0.1:5182/built.html?master=${encodeURIComponent(`${FIXTURES}/${fixture}/master.m3u8`)}${extra}`);

test('plays an encrypted stream, the key held in memory', async ({ page }) => {
    await open(page, 'encrypted', `&key=${KEY_HEX}`);
    const video = page.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
});

