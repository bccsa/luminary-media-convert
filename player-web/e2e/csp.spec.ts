import { expect, test } from '@playwright/test';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The packaged app serves the web client under a strict Content-Security-Policy (api/src/bootstrap.ts, `buildHelmet`
// with the client being served). A player that needs `eval`, an inline script, a worker from somewhere else or a
// style the policy refuses works in every other test here, which run with no policy, and not in the app.
test.skip(process.env.ENGINE === 'v8', 'the main player only');

const FIXTURES = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 5191}`;
const KEY_HEX = '00112233445566778899aabbccddeeff';

/** The directives `buildHelmet(true)` sets, plus helmet's own defaults that bear on a player. Keep in step with it. */
const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "font-src 'self' https: data:",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self' https: http: blob: data:",
    "media-src 'self' https: http: blob: data:",
    "worker-src 'self' blob:",
].join('; ');

/**
 * The demo, served through a proxy that adds the policy to every response, the way the API does. Not a route that
 * rewrites the document inside the browser: a page fulfilled by the test runner has no network address, which
 * Chrome counts as public, and then refuses its requests to a loopback server for a reason that has nothing to do
 * with the policy.
 */
let proxy: Server;
let origin = '';

test.beforeAll(async () => {
    const target = new URL(`http://127.0.0.1:5182`);
    proxy = createServer((req, res) => {
        const upstream = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (up) => {
            res.writeHead(up.statusCode ?? 502, { ...up.headers, 'content-security-policy': CSP });
            up.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

test.afterAll(() => proxy?.close());

test('the built player works under the packaged app\'s Content-Security-Policy', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
        if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text().slice(0, 220));
    });
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
            console.error(`Refused to ${event.violatedDirective}: ${event.blockedURI} (${event.sample ?? ''})`);
        });
    });

    await page.goto(
        `${origin}/built.html?master=${encodeURIComponent(`${FIXTURES}/encrypted/master.m3u8`)}&key=${KEY_HEX}&thumbs=1`
    );
    const video = page.locator('video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await video.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(2);

    // The controls, the stylesheet, a card and the scrub preview: the parts that draw rather than play.
    await expect(page.locator('.lmpl-root.lmpl-has-thumbs')).toBeAttached({ timeout: 20_000 });
    expect(await page.locator('.lmpl-play').evaluate((el) => getComputedStyle(el).width)).not.toBe('auto');
    const box = (await page.locator('.lmpl-root').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.lmpl-opt-speed').click();
    await expect(page.locator('.lmpl-card-speed')).toBeVisible();
    await page.keyboard.press('Escape');
    const bar = (await page.locator('.lmpl-time-slider').boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await expect(page.locator('.lmpl-thumb-frame')).toBeVisible();

    expect(violations, 'nothing the policy refused').toEqual([]);
});
