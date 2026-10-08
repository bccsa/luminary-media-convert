import { expect, test, type Page } from '@playwright/test';

const FIXTURES = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 5191}`;
const KEY_HEX = '00112233445566778899aabbccddeeff';
const STORAGE_KEY = 'luminary-legacy-player-demo';

async function load(page: Page, fixture: string, keyHex = '') {
    await page.addInitScript(
        ([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
        [STORAGE_KEY, { url: `${FIXTURES}/${fixture}/master.m3u8`, keyHex, prefetchDebug: false }] as const
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Load', exact: true }).click();
}

const stat = (page: Page, label: string) =>
    page.locator('.demo-state div', { has: page.locator('dt', { hasText: label }) }).locator('dd');

test.beforeEach(async ({ request }) => {
    await request.get(`${FIXTURES}/__log?clear=1`);
});

test('plays a clear ladder to the end', async ({ page }) => {
    await load(page, 'clear');
    await expect(page.locator('video')).toBeVisible();
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
    await expect(stat(page, 'lifecycle')).not.toHaveText('error');
});

test('plays an encrypted ladder with the key held in memory', async ({ page, request }) => {
    await load(page, 'encrypted', KEY_HEX);
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
    const seen: { path: string }[] = await (await request.get(`${FIXTURES}/__log`)).json();
    expect(seen.some((r) => /key|luminary/.test(r.path))).toBe(false);
});

test('plays byte-range output whose shared chunk is slow to first byte, without giving up on it', async ({ page, request }) => {
    // The first request into the video chunk object stalls for 12 s — longer than hls.js's 10 s
    // time-to-first-byte default and VHS's 1.5 × target duration.
    const COLD_MS = 12_000;
    await request.get(`${FIXTURES}/__fault?clear=1`);
    await request.get(`${FIXTURES}/__fault?match=media/video_0&ms=${COLD_MS}&times=1`);
    await load(page, 'byterange');
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 40_000 }).toBeGreaterThan(2);
    const seen: { path: string; range: string | null; at: number }[] = await (await request.get(`${FIXTURES}/__log`)).json();
    const chunk = seen.filter((r) => r.path.includes('media/video_0'));
    // A timeout, a retry or an ABR switch-down all fire a second request into the cold object while
    // the first is still outstanding; a patient load asks again only once the first has been answered.
    expect(chunk.length).toBeGreaterThan(1);
    expect(chunk[1]!.at - chunk[0]!.at).toBeGreaterThanOrEqual(COLD_MS - 1_000);
});

test('keeps playing a live stream by re-reading its playlist on every refresh', async ({ page, request }) => {
    await request.get(`${FIXTURES}/__live-reset`);
    await load(page, 'live');
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    const t0 = await expect
        .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 })
        .toBeGreaterThan(0)
        .then(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime));
    // Well past the three segments the stream started with: only a refreshed playlist can supply the rest.
    await expect
        .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
        .toBeGreaterThan(t0 + 5);
    const seen: { path: string }[] = await (await request.get(`${FIXTURES}/__log`)).json();
    const refreshes = seen.filter((r) => /\/live\/v(0|1)\.m3u8$/.test(r.path));
    expect(refreshes.length).toBeGreaterThanOrEqual(3);
    await expect(stat(page, 'lifecycle')).not.toHaveText('error');
});

test('recovers when segments fail transiently', async ({ page, request }) => {
    await request.get(`${FIXTURES}/__fault?clear=1`);
    // Three 503s on the third segment of every rendition: inside what either engine retries on its own.
    await request.get(`${FIXTURES}/__fault?match=_002.m4s&status=503&times=3`);
    await load(page, 'clear');
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 40_000 }).toBeGreaterThan(5);
    await expect(stat(page, 'lifecycle')).not.toHaveText('error');
});

test('opens straight into playback from a link', async ({ page }) => {
    const master = encodeURIComponent(`${FIXTURES}/encrypted/master.m3u8`);
    await page.goto(`/?master=${master}&key=${KEY_HEX}`);
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);
    await expect(stat(page, 'lifecycle')).not.toHaveText('error');
});

// Playing is not the same as sounding. A build of hls.js without alternate audio plays every picture here
// without a sound, reports no error and a lifecycle of "ready", and every check above that reads the playhead
// still passes. This reads what the browser has decoded.
const NATIVE_KEY = '6c756d696e6172792d737069a4e2c0de';
for (const [name, fixture, key] of [
    ['one audio group', 'clear', ''],
    ['an encrypted one', 'encrypted', KEY_HEX],
    ['four languages, encrypted, two angles', 'native', NATIVE_KEY],
] as const) {
    test(`decodes audio, not only picture: ${name}`, async ({ page }) => {
        await load(page, fixture, key);
        const video = page.locator('video');
        const decoded = () =>
            video.evaluate((v: HTMLVideoElement) => ({
                audio: (v as unknown as { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount,
                video: (v as unknown as { webkitVideoDecodedByteCount?: number }).webkitVideoDecodedByteCount,
            }));
        await video.evaluate((v: HTMLVideoElement) => { v.muted = false; v.volume = 1; return v.play().catch(() => undefined); });
        await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(3);
        const bytes = await decoded();
        test.skip(bytes.audio === undefined, 'this browser does not report decoded bytes');
        expect(bytes.video, 'the picture is decoding').toBeGreaterThan(0);
        expect(bytes.audio, 'and so is the sound').toBeGreaterThan(0);
    });
}
