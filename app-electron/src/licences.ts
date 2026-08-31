import { app, BrowserWindow, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The licences window.
 *
 * The GPL and LGPL both oblige a *copy* of the licence to travel with the
 * binary, and build.sh already ships those texts beside ffmpeg. Shipping them
 * where only someone who opens the app bundle by hand can find them satisfies
 * the letter and not much else, so they are surfaced here.
 *
 * Texts are read from disk rather than compiled in, so this window describes the
 * encoder that actually shipped: a build that changed licence, or picked up a
 * new statically-linked component, changes what is displayed without anyone
 * having to remember to update a list.
 */

/**
 * Licence files shipped beside the binary, with what each one covers. Most are
 * written by build.sh; the two Electron ones are collected at packaging time by
 * build/after-pack.cjs.
 *
 * `link` means the text is offered as a file to open rather than shown inline —
 * Chromium's runs to megabytes, which this window would have to carry in its own
 * data: URL.
 */
const NOTICES: {
    file: string;
    heading: string;
    note?: string;
    link?: boolean;
}[] = [
    {
        file: 'LICENSE-ffmpeg.txt',
        heading: 'FFmpeg',
        note: 'Invoked as a separate process. Built from source by this project — see BUILDCONF.txt beside the binary for the exact configuration.',
    },
    {
        file: 'LICENSE-libwebp.txt',
        heading: 'libwebp',
        note: 'Statically linked into the encoder (BSD-3-Clause).',
    },
    {
        file: 'LICENSE-libvpl.txt',
        heading: 'libvpl',
        note: "Statically linked into the Windows encoder — Intel's Quick Sync dispatcher (MIT).",
    },
    {
        file: 'LICENSE-electron.txt',
        heading: 'Electron',
        note: 'The application runs on Electron (MIT).',
    },
    {
        file: 'LICENSES-chromium.html',
        heading: 'Chromium and its components',
        note: 'Electron embeds Chromium, whose own components carry several hundred licences — BSD-3-Clause, MIT and others. Too long to show here.',
        link: true,
    },
    { file: 'GPL-2.0.txt', heading: 'GNU General Public License v2.0' },
    { file: 'GPL-3.0.txt', heading: 'GNU General Public License v3.0' },
    {
        file: 'COPYING.LGPLv2.1',
        heading: 'GNU Lesser General Public License v2.1',
    },
];

/**
 * Where build.sh put the licence texts: beside the binary, which is Resources in
 * a packaged app and bin/<target> when running from source. Mirrors
 * `bundledBinary` in main.ts.
 */
function noticeDir(): string {
    return app.isPackaged
        ? process.resourcesPath
        : join(__dirname, '..', 'bin', `${process.platform}-${process.arch}`);
}

const escape = (s: string): string =>
    s.replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string
    );

function buildHtml(): string {
    const dir = noticeDir();

    const sections = NOTICES.filter((n) => existsSync(join(dir, n.file))).map(
        (n) => {
            const head = `<h2>${escape(n.heading)}</h2>
                ${n.note ? `<p class="note">${escape(n.note)}</p>` : ''}`;

            if (n.link)
                return `<section>${head}
                    <p><a href="${escape(pathToFileURL(join(dir, n.file)).href)}"
                       target="_blank">Open ${escape(n.file)}</a></p>
                </section>`;

            let body: string;
            try {
                body = readFileSync(join(dir, n.file), 'utf8');
            } catch (err) {
                body = `This licence text could not be read: ${String(err)}`;
            }
            return `<section>${head}
                <pre>${escape(body)}</pre>
            </section>`;
        }
    );

    // Nothing to show means the binary was packaged without its notices, which
    // verify-package.mjs is supposed to catch. Say so rather than showing a
    // blank window that looks like a rendering bug.
    if (sections.length === 0) {
        sections.push(`<section>
            <h2>No licence texts found</h2>
            <p class="note">Expected them in ${escape(dir)}. This build is
            incomplete — the notices are required to travel with the binary.</p>
        </section>`);
    }

    const runtime = [
        ['Application', app.getVersion()],
        ['Electron', process.versions.electron],
        ['Chromium', process.versions.chrome],
        ['Node', process.versions.node],
    ]
        .map(
            ([k, v]) =>
                `<tr><td>${escape(k)}</td><td>${escape(v ?? '')}</td></tr>`
        )
        .join('');

    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Licences</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0; padding: 28px 32px 48px; background: Canvas; color: CanvasText; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 6px; }
  p.lede { margin: 0 0 20px; opacity: .75; max-width: 62ch; }
  p.note { margin: 0 0 8px; opacity: .75; max-width: 72ch; }
  table { border-collapse: collapse; margin: 0 0 8px; }
  td { padding: 1px 20px 1px 0; }
  td:first-child { opacity: .7; }
  pre { white-space: pre-wrap; word-wrap: break-word; font: 11px/1.45 ui-monospace,
        SFMono-Regular, Menlo, Consolas, monospace; background: color-mix(in srgb, CanvasText 6%, Canvas);
        padding: 12px 14px; border-radius: 6px; max-width: 100ch; }
</style></head>
<body>
  <h1>Luminary Media Convert</h1>
  <p class="lede">Third-party components distributed with this application, and
  their licence terms. Patents are a separate question that no copyright licence
  addresses — see PATENTS.md in the project repository.</p>
  <table>${runtime}</table>
  ${sections.join('\n')}
</body></html>`;
}

let licenceWindow: BrowserWindow | undefined;

export function showLicences(parent?: BrowserWindow): void {
    if (licenceWindow && !licenceWindow.isDestroyed()) {
        licenceWindow.focus();
        return;
    }

    licenceWindow = new BrowserWindow({
        width: 780,
        height: 720,
        title: 'Licences',
        parent,
        show: false,
        webPreferences: {
            // Static text with no preload bridge: it needs none of the app's
            // privileges, so it gets none of them.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    licenceWindow.setMenuBarVisibility(false);
    licenceWindow.once('ready-to-show', () => licenceWindow?.show());
    licenceWindow.on('closed', () => {
        licenceWindow = undefined;
    });

    // Chromium's notice is a local file, which openExternal does not reliably
    // hand to a browser; openPath is what opens it in the default viewer.
    const openOutside = (url: string): void => {
        if (url.startsWith('file:')) void shell.openPath(fileURLToPath(url));
        else void shell.openExternal(url);
    };

    licenceWindow.webContents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: 'deny' };
    });

    // Both handlers, because which one fires depends on whether Chromium treats
    // the link as a new window or as navigation away from this data: URL. Either
    // way the window itself must stay where it is.
    licenceWindow.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        openOutside(url);
    });

    void licenceWindow.loadURL(
        'data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml())
    );
}
