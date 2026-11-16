import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLicencesHtml, NOTICES, PATENTS_URL } from './licences-page';

const versions = {
    app: '0.0.7',
    electron: '33.4.0',
    chrome: '130.0',
    node: '20.18.0',
};

describe('the licences page', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'lmc-licences-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const ship = (file: string, text = `${file} text`) =>
        writeFileSync(join(dir, file), text);

    it('lists every notice the packaging check requires', () => {
        const files = NOTICES.map((n) => n.file);

        for (const required of [
            'LICENSE-ffmpeg.txt',
            'LICENSE-libwebp.txt',
            'LICENSE-libvpl.txt',
            'LICENSE-electron.txt',
            'LICENSES-chromium.html',
            'COPYING.LGPLv2.1',
        ])
            expect(files).toContain(required);
    });

    it('shows the text of each licence shipped, in order, and leaves out the ones that are not', () => {
        ship('LICENSE-ffmpeg.txt', 'FFmpeg is free software');
        ship('COPYING.LGPLv2.1', 'GNU LESSER GENERAL PUBLIC LICENSE');

        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain('<h2>FFmpeg</h2>');
        expect(html).toContain('FFmpeg is free software');
        expect(html).toContain(
            '<h2>GNU Lesser General Public License v2.1</h2>'
        );
        expect(html).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
        expect(html.indexOf('FFmpeg is free software')).toBeLessThan(
            html.indexOf('GNU LESSER GENERAL PUBLIC LICENSE')
        );
        expect(html).not.toContain('<h2>libwebp</h2>');
        expect(html).not.toContain('No licence texts found');
    });

    it('offers the long texts as a file to open instead of showing them', () => {
        ship('LICENSES-chromium.html', '<html>nine megabytes</html>');

        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain('<h2>Chromium and its components</h2>');
        expect(html).toContain(
            `href="${pathToFileURL(join(dir, 'LICENSES-chromium.html')).href}"`
        );
        expect(html).toContain('Open LICENSES-chromium.html');
        expect(html).not.toContain('nine megabytes');
    });

    it('shows a licence text as text, never as markup', () => {
        ship('LICENSE-ffmpeg.txt', '<script>alert(1)</script> & <b>bold</b>');

        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain(
            '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;'
        );
        expect(html).not.toContain('<script>');
    });

    it('keeps a link intact when the folder path has a quote in it', () => {
        const quoted = join(dir, 'a"b');
        mkdirSync(quoted);
        writeFileSync(join(quoted, 'LICENSES-npm.txt'), 'packages');

        const html = buildLicencesHtml(quoted, versions);
        const href = html.match(/href="([^"]*LICENSES-npm\.txt)"/)?.[1];

        // The file URL encodes the quote, so it cannot end the attribute early.
        expect(href).toBe(pathToFileURL(join(quoted, 'LICENSES-npm.txt')).href);
        expect(href).toContain('%22');
    });

    it('says a text could not be read instead of failing the page', () => {
        // A folder where the file should be: it exists, but cannot be read as text.
        mkdirSync(join(dir, 'LICENSE-ffmpeg.txt'));

        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain('<h2>FFmpeg</h2>');
        expect(html).toContain('This licence text could not be read');
    });

    it('says plainly when a build shipped without any notices', () => {
        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain('No licence texts found');
        expect(html).toContain(dir);
    });

    it('lists the versions it runs on and links the patents notice', () => {
        const html = buildLicencesHtml(dir, versions);

        for (const [label, value] of [
            ['Application', '0.0.7'],
            ['Electron', '33.4.0'],
            ['Chromium', '130.0'],
            ['Node', '20.18.0'],
        ])
            expect(html).toContain(
                `<tr><td>${label}</td><td>${value}</td></tr>`
            );
        expect(html).toContain(`href="${PATENTS_URL}"`);
    });

    it('allows no scripts on the page', () => {
        const html = buildLicencesHtml(dir, versions);

        expect(html).toContain(
            `content="default-src 'none'; style-src 'unsafe-inline';"`
        );
    });
});
