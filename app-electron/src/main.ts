import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    safeStorage,
    shell,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    ALLOWED_EXTENSIONS,
    checkFfmpeg,
    createServer,
    DEFAULT_PORT,
    FFMPEG_DOWNLOAD_URL,
    MIN_FFMPEG_VERSION,
    type RunningServer,
} from '@luminary-media-converter/api';
import { showLicences } from './licences';
import { candidateBinaries, resolveFfmpegBinary } from './ffmpeg-location';

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
    /**
     * A directory holding an ffmpeg the user would rather we used than the one
     * we ship. Unset for everybody who has never opened the menu item.
     *
     * A directory rather than two file paths, so ffmpeg and ffprobe cannot be
     * chosen from different builds — a pair that disagree fail in ways that
     * look like a broken source file.
     */
    ffmpegDir?: string | null;
}

const settingsPath = (): string =>
    join(app.getPath('userData'), 'settings.json');

let settings: Settings = { allowedOrigins: [], deniedOrigins: [] };

async function loadSettings(): Promise<void> {
    try {
        const raw = await readFile(settingsPath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<Settings>;
        settings = {
            allowedOrigins: parsed.allowedOrigins ?? [],
            deniedOrigins: parsed.deniedOrigins ?? [],
            ffmpegDir: parsed.ffmpegDir ?? null,
        };
    } catch {
        // No settings yet, or unreadable: start from "trust nothing", which is
        // the same state a first run is in.
    }
}

async function saveSettings(): Promise<void> {
    try {
        await mkdir(app.getPath('userData'), { recursive: true });
        await writeFile(
            settingsPath(),
            JSON.stringify(settings, null, 4),
            'utf8'
        );
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
    | {
          encrypt(plaintext: string): string;
          decrypt(ciphertext: string): string;
      }
    | undefined {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn(
            'safeStorage unavailable: S3 credentials will stay in memory'
        );
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
 * The ffmpeg or ffprobe to run: the environment, then the user's chosen
 * directory, then the one we ship.
 *
 * The order matters and used not to hold. The bundled path was passed
 * unconditionally, which overwrote FFMPEG_PATH in the environment — so the
 * documented developer escape hatch silently did nothing in a packaged build,
 * and there was no way at all for a user to substitute their own build.
 *
 * That substitutability is not a convenience. We ship an LGPL ffmpeg as a
 * separate program, and being able to replace it with your own copy is the
 * condition attached to distributing it that way.
 */
function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string | undefined {
    return resolveFfmpegBinary(name, {
        env: process.env,
        ffmpegDir: settings.ffmpegDir,
        bundled: bundledBinary,
        platform: process.platform,
        exists: existsSync,
        warn: (message) => console.warn(message),
    });
}

/**
 * The ffmpeg or ffprobe this app should use, in the order they are trusted.
 *
 * 1. **Packaged**: the copy beside the app's own resources, which packaging put
 *    there. Always present in a release, because `dist:mac` / `dist:win` / `pack`
 *    build the encoder first and `verify-package` refuses an app without one.
 * 2. **From source**: `electron/bin/<platform>-<arch>/`, written by
 *    `ffmpeg-build/build.sh` and copied from there by packaging. A developer who has
 *    run the build therefore uses the *shipped* binary rather than whatever their
 *    machine happens to have — which is what makes "works on my machine" mean
 *    something, since hardware support is a compile-time decision.
 * 3. **Neither**: undefined, and the API falls back to PATH. That is the only
 *    route left to the install prompt, and it means a developer who has never run
 *    the build.
 *
 * The second case is why an unpackaged run does not simply defer to PATH: a
 * developer's own install would differ from the one every user gets, leaving the one
 * person able to notice a problem testing against a different ffmpeg.
 */
function bundledBinary(name: string): string | undefined {
    const filename = process.platform === 'win32' ? `${name}.exe` : name;

    const candidates = app.isPackaged
        ? [join(process.resourcesPath, filename)]
        : [
              // `__dirname` is electron/dist when running from source.
              join(
                  __dirname,
                  '..',
                  'bin',
                  `${process.platform}-${process.arch}`,
                  filename
              ),
          ];

    return candidates.find((candidate) => existsSync(candidate));
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

/**
 * Restart, because the encoder is inspected once at startup and cached.
 *
 * `FfmpegService` probes acceleration on init and holds the answer for the
 * process's life. Swapping the binary underneath it would leave the app
 * encoding with one ffmpeg and reporting the capabilities of another, so the
 * honest options are relaunch or refuse — and refusing would make the setting
 * useless.
 */
async function applyFfmpegDirectory(dir: string | null): Promise<void> {
    settings.ffmpegDir = dir;
    await saveSettings();
    // The menu is built once at startup and reads this to enable "Use the
    // bundled FFmpeg". Someone who defers the restart would otherwise be
    // looking at a stale item until they do.
    buildMenu();

    const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Restart required',
        message: dir
            ? 'Luminary Media Convert will use the FFmpeg you chose.'
            : 'Luminary Media Convert will use the FFmpeg it ships with.',
        detail: 'The encoder is inspected when the app starts, so this takes effect after a restart.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) {
        app.relaunch();
        app.exit(0);
    }
}

/**
 * Let the user point the app at their own FFmpeg build.
 *
 * We ship an LGPL ffmpeg and run it as a separate program; being able to
 * replace it with your own copy is the condition attached to distributing it
 * that way. A folder is asked for rather than a file so ffmpeg and ffprobe
 * always come from the same build.
 *
 * Nothing is scanned. Only the directory the user chose is looked at, and only
 * to confirm it holds an ffmpeg new enough to use — the same check the app runs
 * against its own binary at startup, pointed somewhere else.
 */
async function chooseFfmpegDirectory(): Promise<void> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Choose an FFmpeg folder',
        message: 'Select a folder containing ffmpeg and ffprobe.',
        properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return;

    const dir = filePaths[0];
    const candidate = candidateBinaries(dir, process.platform);
    const before = {
        ffmpeg: process.env.FFMPEG_PATH,
        ffprobe: process.env.FFPROBE_PATH,
    };

    let reason: string | null | undefined;
    let detail: string | null | undefined;
    try {
        process.env.FFMPEG_PATH = candidate.ffmpeg;
        process.env.FFPROBE_PATH = candidate.ffprobe;
        ({ reason, detail } = await checkFfmpeg());
    } finally {
        // Restore whatever was there, including nothing: leaving the candidate
        // in the environment would point the running API at a binary the user
        // may have just been told is unusable.
        for (const [key, value] of [
            ['FFMPEG_PATH', before.ffmpeg],
            ['FFPROBE_PATH', before.ffprobe],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }

    if (reason) {
        if (detail) console.error(detail);
        dialog.showErrorBox(
            'That folder cannot be used',
            `${reason}\n\nLuminary Media Convert will keep using the FFmpeg it ships with.`
        );
        return;
    }

    await applyFfmpegDirectory(dir);
}

/**
 * The application menu.
 *
 * Built rather than left to Electron's default because the default has no way
 * to reach the licence texts, and the GPL/LGPL both want them in front of the
 * user rather than buried in the app bundle. Everything else here is a standard
 * role: replacing the default menu without them would take copy, paste and the
 * window controls with it.
 */
function buildMenu(): void {
    const isMac = process.platform === 'darwin';
    // No ellipsis. Apple's convention reserves it for an item that needs more
    // input before it can act; this opens a window and asks for nothing. The
    // FFmpeg picker below keeps its ellipsis for exactly that reason.
    const licences = {
        label: 'Licences',
        click: () => showLicences(mainWindow),
    };
    // Deliberately a plain item rather than anything prominent: the licence
    // asks that substitution be possible, not that we recommend it.
    const ffmpegItems: Electron.MenuItemConstructorOptions[] = [
        { label: 'Choose FFmpeg…', click: () => void chooseFfmpegDirectory() },
        {
            label: 'Use the bundled FFmpeg',
            enabled: !!settings.ffmpegDir,
            click: () => void applyFfmpegDirectory(null),
        },
    ];

    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            ...(isMac
                ? ([
                      {
                          label: app.name,
                          submenu: [
                              { role: 'about' },
                              { type: 'separator' },
                              ...ffmpegItems,
                              { type: 'separator' },
                              { role: 'services' },
                              { type: 'separator' },
                              { role: 'hide' },
                              { role: 'hideOthers' },
                              { role: 'unhide' },
                              { type: 'separator' },
                              { role: 'quit' },
                          ],
                      },
                  ] as Electron.MenuItemConstructorOptions[])
                : []),
            { role: 'fileMenu' },
            { role: 'editMenu' },
            { role: 'viewMenu' },
            { role: 'windowMenu' },
            {
                role: 'help',
                submenu: isMac
                    ? [licences]
                    : [
                          licences,
                          { type: 'separator' },
                          ...ffmpegItems,
                          { type: 'separator' },
                          { role: 'about' },
                      ],
            },
        ] as Electron.MenuItemConstructorOptions[])
    );
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
        extensions: [...ALLOWED_EXTENSIONS].map((ext) =>
            ext.replace(/^\./, '')
        ),
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
            ffmpegPath: resolveBinary('ffmpeg'),
            ffprobePath: resolveBinary('ffprobe'),
            staticAppDir: bundledWebClient(),
        });
        console.log(`Encoding API listening on ${server.url}`);
    } catch (err) {
        // Nothing works without it — most likely something else already has the
        // port, and the user needs to be told rather than shown an empty window.
        dialog.showErrorBox(
            'Luminary Media Convert could not start',
            `The local encoding service failed to start.\n\n${(err as Error).message}`
        );
        app.exit(1);
        return;
    }

    // Before the window: FFmpeg is not optional, and an app window is a promise
    // that something can be done with it.
    if (!(await encoderPresent())) return;

    buildMenu();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else focusWindow();
    });
}

/**
 * Whether this machine can encode — and if it cannot, say why and stop.
 *
 * FFmpeg is a hard requirement: encoding, previews, thumbnails, waveforms and
 * even reading a source's metadata all spawn it, so an app that opens without it
 * offers a window in which nothing can be done. Better to say so once, plainly,
 * with the download in reach, than to let the user reach a failed probe after
 * choosing a destination in the CMS and picking a file.
 *
 * Until this existed nothing said so at all: the acceleration probe reported "No
 * GPU found, using CPU encoding" on a machine with no ffmpeg whatsoever, because
 * its checks cannot tell an absent binary from one without NVENC.
 *
 * A packaged build ships its own pair, so in practice this fires for a run from
 * source with nothing installed, or a package built without them — `pack` skips
 * the fetch, and electron-builder only warns about the missing source.
 *
 * Called before `createWindow()` and returns false when the app is quitting.
 */
async function encoderPresent(): Promise<boolean> {
    // After createServer, which is what puts the bundled paths into the
    // environment these read.
    const { reason, detail } = await checkFfmpeg();
    if (!reason) return true;

    console.error(reason);
    // Which options the build lacked, for the log rather than the dialog.
    if (detail) console.error(detail);

    const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'FFmpeg is required',
        // The heading states the requirement, because it holds for both cases
        // this dialog reports: not installed, and installed but too old. A
        // heading that contradicts its own detail is worse than a general one.
        message: `Luminary Media Convert needs FFmpeg ${MIN_FFMPEG_VERSION} or newer`,
        // `reason` says which of the two it is and what to do about it. The
        // option names behind that verdict stay in the log: whoever is reading
        // this wants to convert a video, not debug a muxer.
        detail: `${reason}\n\nDownload it from ${FFMPEG_DOWNLOAD_URL}`,
        buttons: ['Get FFmpeg', 'Quit'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response === 0) await shell.openExternal(FFMPEG_DOWNLOAD_URL);

    // Either way the answer is the same: there is nothing to do here until
    // FFmpeg is installed and the app is started again. Close the server first
    // rather than exiting out from under Nest.
    await server?.close();
    server = undefined;
    app.exit(1);
    return false;
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
