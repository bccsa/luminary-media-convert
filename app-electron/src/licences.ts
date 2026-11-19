import { app, BrowserWindow, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLicencesHtml } from './licences-page';

/**
 * The licences window: the page from licences-page.ts, shown in a window of its
 * own with no privileges, its links opened outside the app.
 */

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

function buildHtml(): string {
    return buildLicencesHtml(noticeDir(), {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
    });
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

    // Written to a file and loaded from there rather than served as a data: URL.
    // Chromium refuses to navigate away from a data: document, and refuses
    // silently — neither the window-open handler nor will-navigate is reached, so
    // the link to Chromium's own notice did nothing at all when clicked.
    const page = join(
        app.getPath('temp'),
        'luminary-media-convert-licences.html'
    );
    writeFileSync(page, buildHtml(), 'utf8');
    void licenceWindow.loadFile(page);
}
