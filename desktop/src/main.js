/**
 * Electron main process.
 *
 * Starts the encoder as a child process and serves one loopback origin that
 * carries both the renderer and the `/saas/*` API it expects. There is no
 * database and no second service: the encoder persists its own sessions to
 * WORK_DIR, and the only state the shell owns is the user's S3 profiles.
 *
 * The window still shows a status page until the renderer is built and staged.
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFfmpeg, installHint } from './ffmpeg-detect.js';
import { EncoderService } from './services.js';
import { S3ConfigStore } from './s3-configs.js';
import { SessionIndex } from './session-index.js';
import { AppServer } from './static-server.js';
import { stableRendererPort } from './ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Packaged, the staged services live in Resources/ outside the asar. That is
 * not an optimisation: the encoder resolves its worker threads with
 * join(__dirname, '*.worker.js'), which only works against real files on disk.
 */
function resourcesRoot() {
    return app.isPackaged
        ? process.resourcesPath
        : join(HERE, '..', 'build', 'resources');
}

let encoder = null;
let appServer = null;
let window = null;
let status = { ok: false, error: 'starting' };

// A packaged app has nowhere to print, so anything that goes wrong before the
// log directory is known would otherwise vanish. This is the only window where
// that is true, and it is exactly where startup failures happen.
process.on('uncaughtException', (err) => {
    console.error('[main] uncaught:', err);
});
console.error(`[main] starting, packaged=${app.isPackaged}`);

// Two instances would share WORK_DIR and fight over the same session state.
if (!app.requestSingleInstanceLock()) {
    console.error('[main] another instance holds the lock — quitting');
    app.quit();
} else {
    app.on('second-instance', () => {
        if (window) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });
    app.whenReady().then(main);
}

async function main() {
    createWindow();

    try {
        status = await startEncoder();
        console.error(`[main] encoder ready at ${status.encoderUrl}`);

        status.appUrl = await startAppServer();
        console.error(`[main] app server ready at ${status.appUrl}`);
        writeHandle({
            appUrl: status.appUrl,
            encoderUrl: encoder.baseUrl,
            masterKey: encoder.masterKey,
            workDir: status.workDir,
            logDir: status.logDir,
            ffmpeg: status.ffmpeg,
            ffprobe: status.ffprobe,
        });

        // The renderer lands here once it is built (Phase 6). Until then the
        // window keeps showing status rather than a 503 page.
        if (rendererDir()) window?.loadURL(status.appUrl);
    } catch (err) {
        status = { ok: false, error: err.message };
        console.error(err);
    }
    publishStatus();
}

/**
 * Serve the renderer and the /saas/* adapter on one loopback origin.
 *
 * Same origin as the app means no CORS to configure and no mixed-content
 * problem; a pinned port means the origin — and therefore localStorage — is
 * stable across launches.
 */
async function startAppServer() {
    const userData = app.getPath('userData');

    const s3Configs = new S3ConfigStore(
        join(userData, 's3-configs.json'),
        safeStorage,
    );
    const sessionIndex = new SessionIndex(join(userData, 'session-index.json'));

    appServer = new AppServer({
        s3Configs,
        sessionIndex,
        rendererDir: rendererDir(),
        encoder: () => ({
            baseUrl: encoder.baseUrl,
            masterKey: encoder.masterKey,
        }),
    });

    const port = await appServer.listen(
        await stableRendererPort(join(userData, 'ports.json')),
    );
    return `http://127.0.0.1:${port}`;
}

/** The built Vue app, when there is one. */
function rendererDir() {
    const dir = join(resourcesRoot(), 'renderer');
    return existsSync(dir) ? dir : undefined;
}

async function startEncoder() {
    const ffmpeg = await detectFfmpeg({
        ffmpeg: process.env.LMC_FFMPEG_PATH,
        ffprobe: process.env.LMC_FFPROBE_PATH,
    });

    if (!ffmpeg.ok) {
        throw new Error(
            `Could not find ${ffmpeg.missing.join(' or ')}. ${installHint()}\n` +
                `Searched: ${ffmpeg.searched.join(', ')}`,
        );
    }

    const entry = join(resourcesRoot(), 'services', 'api', 'dist', 'main.js');
    if (!existsSync(entry)) {
        throw new Error(
            `Staged encoder not found at ${entry}. Run: npm -w desktop run stage`,
        );
    }

    const workDir = join(app.getPath('userData'), 'work');
    const logDir = join(app.getPath('userData'), 'logs');

    encoder = new EncoderService({
        entry,
        cwd: dirname(dirname(entry)),
        workDir,
        logDir,
        ffmpeg: ffmpeg.ffmpeg.path,
        ffprobe: ffmpeg.ffprobe.path,
    });

    await encoder.start();

    return {
        ok: true,
        encoderUrl: encoder.baseUrl,
        ffmpeg: `${ffmpeg.ffmpeg.path}`,
        ffprobe: `${ffmpeg.ffprobe.path}`,
        ffmpegSource: ffmpeg.ffmpeg.source,
        workDir,
        logDir,
    };
}

/**
 * A 0600 file naming the local URLs and the master key, so a script can drive a
 * running app. It exists for development; the renderer never reads it, and it
 * should go once there is nothing left to drive by hand.
 */
function writeHandle(handle) {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spike-handle.json'), JSON.stringify(handle, null, 2), {
        mode: 0o600,
    });
}

function createWindow() {
    window = new BrowserWindow({
        width: 720,
        height: 420,
        title: 'Luminary Media Convert',
        webPreferences: {
            preload: join(HERE, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    // The app may navigate within its own origin; anything else is either a bug
    // or hostile, and genuine external links belong in the real browser.
    window.webContents.on('will-navigate', (event, url) => {
        if (status.appUrl && url.startsWith(status.appUrl)) return;
        event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    window.loadFile(join(HERE, 'status.html'));
    window.webContents.on('did-finish-load', publishStatus);
    window.on('closed', () => (window = null));
}

function publishStatus() {
    if (window && !window.isDestroyed()) {
        window.webContents.send('status', status);
    }
}

ipcMain.handle('status', () => status);

/**
 * Stop the encoder before the process goes away.
 *
 * preventDefault is what buys the time: without it Electron tears the process
 * down immediately, the encoder never runs its shutdown hooks, and any ffmpeg
 * it started survives as an orphan.
 */
let quitting = false;
app.on('before-quit', (event) => {
    if (quitting || !encoder) return;
    event.preventDefault();
    quitting = true;
    void encoder
        .stop()
        .then(() => appServer?.close())
        .finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
