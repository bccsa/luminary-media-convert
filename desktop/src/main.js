/**
 * Electron main process — Phase 1 spike.
 *
 * Deliberately minimal: no renderer app, no SaaS, no local database. It exists
 * to prove the things that are expensive to discover late — that the staged
 * service tree runs from inside a packaged app, that worker threads resolve
 * from unpacked resources, that ffmpeg is reachable when the app is launched
 * from Finder rather than a shell, and that quitting does not orphan ffmpeg.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFfmpeg, installHint } from './ffmpeg-detect.js';
import { EncoderService } from './services.js';

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
    } catch (err) {
        status = { ok: false, error: err.message };
        console.error(err);
    }
    publishStatus();
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

    // Spike affordance: lets a shell script drive the packaged app. A real
    // build keeps the master key out of a world-readable file — Phase 5 puts
    // secrets in a 0600 file, with the S3 key in the OS keychain.
    writeHandle({
        encoderUrl: encoder.baseUrl,
        masterKey: encoder.masterKey,
        workDir,
        logDir,
        ffmpeg: ffmpeg.ffmpeg.path,
        ffprobe: ffmpeg.ffprobe.path,
    });

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

    // Nothing in this window should navigate anywhere; anything trying to is
    // either a bug or hostile, and external links belong in the real browser.
    window.webContents.on('will-navigate', (event) => event.preventDefault());
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
    void encoder.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
