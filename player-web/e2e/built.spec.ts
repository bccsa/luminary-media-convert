import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The player as built, which is what an app installs. Everything else here drives source through the demo, and
// source keeps imports the build can drop: the first version of this spec was written after the built library
// turned out to register no element at all, with every other test green.
test.skip(process.env.ENGINE !== 'v10', 'the Video.js 10 player only');

const FIXTURES = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 5191}`;
const KEY_HEX = '00112233445566778899aabbccddeeff';

test.beforeAll(() => {
    const dist = resolve(process.cwd(), '../player-web-v10/dist/index.js');
    if (!existsSync(dist)) throw new Error(`no built library at ${dist}: run \`npm -w player-web-v10 run build:lib\` first`);
});

const open = (page: import('@playwright/test').Page, fixture = 'encrypted', extra = '') =>
    page.goto(`http://127.0.0.1:5183/built.html?master=${encodeURIComponent(`${FIXTURES}/${fixture}/master.m3u8`)}${extra}`);

test('every control tag of the built player is a registered element', async ({ page }) => {
    await open(page, 'clear');
    await expect(page.locator('.lmpl-root')).toBeAttached();
    const undefinedTags = await page.evaluate(() => {
        const tags = new Set<string>();
        for (const el of document.querySelectorAll('.lmpl-root *')) {
            if (/^(media-|video-)/.test(el.localName) || el.localName === 'hlsjs-video') tags.add(el.localName);
        }
        return { seen: tags.size, undefinedTags: [...tags].filter((t) => !customElements.get(t)) };
    });
    expect(undefinedTags.seen).toBeGreaterThan(15);
    expect(undefinedTags.undefinedTags).toEqual([]);
});

test('every icon in the built player renders', async ({ page }) => {
    await open(page, 'clear');
    await expect(page.locator('.lmpl-root media-icon').first()).toBeAttached();
    const icons = await page.evaluate(() =>
        [...document.querySelectorAll('.lmpl-root media-icon')].map((el) => ({
            name: el.getAttribute('name'),
            drawn: !!(el.querySelector('svg') ?? el.shadowRoot?.querySelector('svg')),
        }))
    );
    expect(icons.length).toBeGreaterThan(10);
    expect(icons.filter((i) => !i.drawn).map((i) => i.name)).toEqual([]);
});

test('the built player carries its own stylesheet', async ({ page }) => {
    await open(page, 'clear');
    await expect(page.locator('.lmpl-play')).toBeAttached();
    const css = await page.evaluate(() => {
        const play = getComputedStyle(document.querySelector('.lmpl-play')!);
        const button = getComputedStyle(document.querySelector('.lmpl-icon-btn')!);
        return { playWidth: play.width, radius: button.borderTopLeftRadius };
    });
    // 80px at the base scale, and this page is wide enough for the next step up (x1.25): the sizes arrive with the
    // stylesheet, container query and all.
    expect(css.playWidth).toBe('100px');
    expect(parseFloat(css.radius)).toBeGreaterThan(100);
});

test('plays an encrypted stream, the key held in memory', async ({ page }) => {
    await open(page, 'encrypted', `&key=${KEY_HEX}`);
    const video = page.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
});

test('the built controls work: a card opens, and the scrub preview draws', async ({ page }) => {
    await open(page, 'clear', '&thumbs=1');
    await expect(page.locator('.lmpl-root.lmpl-has-thumbs')).toBeAttached({ timeout: 20_000 });
    const box = (await page.locator('.lmpl-root').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.lmpl-opt-speed').click();
    await expect(page.locator('.lmpl-card-speed')).toBeVisible();
    await page.keyboard.press('Escape');
    const bar = (await page.locator('.lmpl-time-slider').boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await expect(page.locator('.lmpl-thumb-frame')).toBeVisible();
});
