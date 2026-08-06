import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    safeStorage,
    shell,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    ALLOWED_EXTENSIONS,
    createServer,
    DEFAULT_PORT,
    type RunningServer,
} from '@luminary-media-converter/api';

const PROTOCOL = 'luminary-convert';

/**
 * The token the renderer authenticates with, minted per launch.
 *
 * Never written down: the only thing that needs it is the window this process
 * opens, and it hands it over across the preload bridge. A token that lived on
 * disk would be a token any other program on the machine could read and use to
 * drive the encoder.
 */
const apiToken = randomBytes(32).toString('hex');

let server: RunningServer | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

/* ------------------------------------------------------------------ *
 * Remembered decisions
 * ------------------------------------------------------------------ */

interface Settings {
    /** Origins the user has allowed. Loaded into the API's allowlist at boot. */
    allowedOrigins: string[];
    /**
     * Origins the user has refused. Kept so a site that keeps trying cannot
     * turn "no" into a dialog every few seconds until someone clicks the wrong
     * button.
     */
    deniedOrigins: string[];
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');

let settings: Settings = { allowedOrigins: [], deniedOrigins: [] };

async function loadSettings(): Promise<void> {
    try {
        const raw = await readFile(settingsPath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<Settings>;
        settings = {
            allowedOrigins: parsed.allowedOrigins ?? [],
            deniedOrigins: parsed.deniedOrigins ?? [],
        };
    } catch {
        // No settings yet, or unreadable: start from "trust nothing", which is
        // the same state a first run is in.
    }
}

async function saveSettings(): Promise<void> {
    try {
        await mkdir(app.getPath('userData'), { recursive: true });
        await writeFile(settingsPath(), JSON.stringify(settings, null, 4), 'utf8');
    } catch (err) {
        console.error('Could not persist settings:', err);
    }
}

/* ------------------------------------------------------------------ *
 * Trust on first use
 * ------------------------------------------------------------------ */

/**
 * One dialog at a time, in the order the requests arrived.
 *
 * Two tabs of the same CMS, or a page that opens an event stream and posts a
 * session in the same tick, produce approval requests milliseconds apart. Two
 * modal sheets stacked on one window is a mess on macOS and a coin toss about
 * which one the user thinks they are answering.
 */
let dialogQueue: Promise<unknown> = Promise.resolve();

function queueDialog<T>(run: () => Promise<T>): Promise<T> {
    const next = dialogQueue.then(run, run);
    dialogQueue = next.catch(() => undefined);
    return next;
}

/**
 * Ask the user about an origin the registry has never seen.
 *
 * Only asks. Remembering the answer belongs to the registry, which is the
 * decision point the CORS layer consults — a second copy here was a second
 * place the settings screen would have had to reach in order to undo one.
 */
async function approveOrigin(origin: string): Promise<boolean> {
    return queueDialog(async () => {
        focusWindow();

        const { response } = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Allow', 'Block'],
            defaultId: 1,
            cancelId: 1,
            title: 'Allow this site to use the encoder?',
            message: `${origin} wants to send encoding jobs to this computer.`,
            detail:
                'Allow this only for a site you administer. It will be able to ' +
                'start encodes and read their progress until you remove it.',
            noLink: true,
        });

        return response === 0;
    });
}

/* ------------------------------------------------------------------ *
 * Host services handed to the API
 * ------------------------------------------------------------------ */

/**
 * `safeStorage` if the OS will give us a key, otherwise nothing.
 *
 * On a Linux desktop with no keyring — and briefly before `ready` anywhere —
 * encryption is unavailable, and the honest answer is to hand the API no
 * cipher at all rather than one that quietly stores plaintext. It then keeps
 * credentials in memory and says so.
 */
function buildCipher():
    | { encrypt(plaintext: string): string; decrypt(ciphertext: string): string }
    | undefined {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('safeStorage unavailable: S3 credentials will stay in memory');
        return undefined;
    }
    return {
        encrypt: (plaintext) =>
            safeStorage.encryptString(plaintext).toString('base64'),
        decrypt: (ciphertext) =>
            safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
    };
}

/**
 * A bundled binary if one was shipped, otherwise let the API look on PATH.
 *
 * Packaging drops ffmpeg and ffprobe beside the app's resources; a developer
 * running from source has neither, and their own install is the right one.
 */
function bundledBinary(name: string): string | undefined {
    if (!app.isPackaged) return undefined;
    const filename = process.platform === 'win32' ? `${name}.exe` : name;
    const candidate = join(process.resourcesPath, filename);
    return existsSync(candidate) ? candidate : undefined;
}

/** The built web client, present only in a packaged app. */
function bundledWebClient(): string | undefined {
    if (!app.isPackaged) return undefined;
    const dir = join(process.resourcesPath, 'app');
    return existsSync(join(dir, 'index.html')) ? dir : undefined;
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function focusWindow(): void {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
}

/**
 * A session the renderer should be showing but may not have been told about yet.
 *
 * The CMS can open a session before this app has a window at all — the click
 * that created it is often the same click that launched us through the
 * `luminary-convert://` handler. Delivering the id to a renderer that has not
 * finished loading drops it silently, so it is parked here and claimed by the
 * renderer when it is ready.
 */
let pendingSessionId: string | null = null;

/**
 * Bring the window forward on the session that was just opened.
 *
 * Focusing alone was not enough: the window came up on whichever session the
 * user was last looking at, so a CMS opening one for a different post showed
 * them the wrong one and left them to find the new one in the list.
 */
function focusSession(sessionId: string): void {
    pendingSessionId = sessionId;
    focusWindow();

    const contents = mainWindow?.webContents;
    // `isLoading()` covers the launch case: the renderer is mid-navigation and
    // any message sent now lands in a document that is about to be replaced.
    if (!contents || contents.isLoading()) return;
    contents.send('luminary:showSession', sessionId);
    pendingSessionId = null;
}

function createWindow(): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
        focusWindow();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        show: false,
        backgroundColor: '#0f172a',
        title: 'Luminary Media Convert',
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
        mainWindow = undefined;
    });

    // Anything that is not the app itself belongs in the user's browser, not in
    // a chrome-less window with a preload bridge attached to it.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    const target = app.isPackaged
        ? server!.url
        : (process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173');

    // In development the renderer is Vite's dev server, which is started
    // alongside this process and is routinely a few seconds behind it. Without
    // the retry the window lands on Chromium's connection-refused page and
    // stays there until someone reloads it by hand.
    let attemptsLeft = app.isPackaged ? 0 : 30;
    mainWindow.webContents.on('did-fail-load', () => {
        if (attemptsLeft-- <= 0) return;
        setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                void mainWindow.loadURL(target);
            }
        }, 1000);
    });

    void mainWindow.loadURL(target);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

const mediaFilters = [
    {
        name: 'Media files',
        extensions: [...ALLOWED_EXTENSIONS].map((ext) => ext.replace(/^\./, '')),
    },
    { name: 'All files', extensions: ['*'] },
];

function registerIpc(): void {
    ipcMain.handle('luminary:getApiToken', () => apiToken);

    ipcMain.handle('luminary:showOpenDialog', async () => {
        const win = mainWindow;
        const options = {
            title: 'Choose a media file',
            properties: ['openFile' as const],
            filters: mediaFilters,
        };
        const result = win
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    // Claimed once, by the renderer, when it is ready to act on it. Pull rather
    // than push because the renderer decides when that is — a session opened
    // while the app was still launching would otherwise be sent into a document
    // that never received it.
    ipcMain.handle('luminary:takePendingSession', () => {
        const sessionId = pendingSessionId;
        pendingSessionId = null;
        return sessionId;
    });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
    // Someone double-clicked the app, or followed a luminary-convert:// link,
    // while it was already running. The instance that holds the lock is the one
    // with the server on the port; this one has nothing to add.
    app.quit();
} else {
    app.on('second-instance', () => {
        focusWindow();
    });

    app.on('open-url', (event) => {
        event.preventDefault();
        focusWindow();
    });

    registerProtocolClient();

    void start();
}

function registerProtocolClient(): void {
    if (process.defaultApp) {
        // Running from source: the scheme has to point at electron plus this
        // project, or the OS launches a bare Electron with no app to run.
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
                resolve(process.argv[1]!),
            ]);
        }
    } else {
        app.setAsDefaultProtocolClient(PROTOCOL);
    }
}

async function start(): Promise<void> {
    await app.whenReady();
    await loadSettings();
    registerIpc();

    try {
        server = await createServer({
            port: Number(process.env.LUMINARY_PORT ?? DEFAULT_PORT),
            workDir: join(app.getPath('userData'), 'work'),
            localApiToken: apiToken,
            cmsAllowedOrigins: settings.allowedOrigins,
            cmsDeniedOrigins: settings.deniedOrigins,
            originApprover: approveOrigin,
            // The registry holds the live answer; this writes it somewhere that
            // outlives the process. Only the host knows where its settings go.
            onOriginDecisionsChanged: ({ allowed, denied }) => {
                settings.allowedOrigins = allowed;
                settings.deniedOrigins = denied;
                void saveSettings();
            },
            credentialCipher: buildCipher(),
            onCmsSessionCreated: (sessionId) => focusSession(sessionId),
            ffmpegPath: bundledBinary('ffmpeg'),
            ffprobePath: bundledBinary('ffprobe'),
            staticAppDir: bundledWebClient(),
        });
        console.log(`Encoding API listening on ${server.url}`);
    } catch (err) {
        // Nothing works without it — most likely something else already has the
        // port, and the user needs to be told rather than shown an empty window.
        dialog.showErrorBox(
            'Luminary Media Convert could not start',
            `The local encoding service failed to start.\n\n${(err as Error).message}`,
        );
        app.exit(1);
        return;
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else focusWindow();
    });
}

app.on('window-all-closed', () => {
    // macOS convention: closing the window is not quitting the app, and an
    // encode still running is a good reason to still be here.
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
    if (quitting || !server) return;
    // Nest's shutdown hooks are what stop ffmpeg and drain the queue; quitting
    // out from under them leaves orphan processes and half-written output.
    event.preventDefault();
    quitting = true;
    void server
        .close()
        .catch((err: Error) => console.error('Shutdown failed:', err))
        .finally(() => {
            server = undefined;
            app.quit();
        });
});
