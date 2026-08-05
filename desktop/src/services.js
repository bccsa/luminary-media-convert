/**
 * Spawn and supervise the encoder as a child process.
 *
 * The service runs under `ELECTRON_RUN_AS_NODE`, which makes the Electron
 * binary behave as plain Node — so there is no second Node runtime to ship, and
 * the child gets the same version Electron bundles. It runs as a child rather
 * than inside the main process because the encoder blocks: GPU detection alone
 * makes several synchronous subprocess calls at boot, which would freeze the UI.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Ask the OS for a free port, then hand it to the child. */
export function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        // Bind loopback only, so the probe reflects where the child will listen.
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

export function generateSecret(bytes = 32) {
    return randomBytes(bytes).toString('hex');
}

export class EncoderService {
    #proc = null;
    #logStream = null;
    #exited = null;

    constructor({ entry, cwd, workDir, logDir, ffmpeg, ffprobe }) {
        this.entry = entry;
        this.cwd = cwd;
        this.workDir = workDir;
        this.logDir = logDir;
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.masterKey = generateSecret();
        this.port = null;
    }

    get baseUrl() {
        return `http://127.0.0.1:${this.port}`;
    }

    /**
     * The environment the encoder runs under.
     *
     * Separate from start() so it can be asserted on directly: these values are
     * the difference between a server deployment and a desktop app, and getting
     * one wrong is silent — the encoder starts happily either way and behaves
     * incorrectly hours later.
     */
    buildEnv(inherited = process.env) {
        return {
            ...inherited,
            ELECTRON_RUN_AS_NODE: '1',

            PORT: String(this.port),
            // Loopback only. The encoder authenticates with a master key, but a
            // key is not a reason to expose a media transcoder to the network.
            BIND_HOST: '127.0.0.1',
            MASTER_API_KEY: this.masterKey,
            WORK_DIR: this.workDir,

            // No uploads: the source is already on this machine. Skipping tus
            // also means the tusd binary is absent from the bundle entirely.
            TUS_ENABLED: 'false',
            ALLOW_LOCAL_SOURCE: 'true',

            // Nothing sits behind this encoder, so its session list is the
            // user's entire history rather than a server's scratch space. The
            // defaults sweep finished sessions after a day and idle ones after
            // six hours, which here means deleting someone's work while they
            // are still using the app. Both windows are turned off; disk is
            // reclaimed when the user deletes a session, which is the only
            // moment they have said they are finished with it.
            SESSION_MAX_AGE_HOURS: inherited.SESSION_MAX_AGE_HOURS ?? 'never',
            SESSION_ABANDONED_MAX_AGE_HOURS:
                inherited.SESSION_ABANDONED_MAX_AGE_HOURS ?? 'never',

            // Absolute paths, because a GUI-launched app cannot rely on PATH.
            FFMPEG_PATH: this.ffmpeg,
            FFPROBE_PATH: this.ffprobe,
            // Belt and braces for any call site still resolving by name.
            PATH: [dirOf(this.ffmpeg), inherited.PATH]
                .filter(Boolean)
                .join(pathSeparator()),
        };
    }

    async start() {
        this.port = await freePort();

        mkdirSync(this.workDir, { recursive: true });
        mkdirSync(this.logDir, { recursive: true });
        this.#logStream = createWriteStream(join(this.logDir, 'encoder.log'), {
            flags: 'a',
        });

        const env = this.buildEnv();

        this.#proc = spawn(process.execPath, [this.entry], {
            cwd: this.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.#exited = null;
        this.#proc.on('exit', (code, signal) => {
            this.#exited = code ?? signal;
        });

        const tee = (chunk) => {
            const text = chunk.toString();
            this.#logStream?.write(text);
            if (process.env.LMC_DESKTOP_VERBOSE) process.stdout.write(text);
        };
        this.#proc.stdout.on('data', tee);
        this.#proc.stderr.on('data', tee);

        await this.#waitUntilReady();
        return this.port;
    }

    /**
     * Poll until the service answers. Any HTTP status proves it is listening —
     * the probe carries no credentials, so 401 is the expected answer.
     */
    async #waitUntilReady(timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        const url = `${this.baseUrl}/api/sessions/readiness-probe`;

        while (Date.now() < deadline) {
            if (this.#exited !== null) {
                throw new Error(
                    `Encoder exited during startup (${this.#exited}). See ${join(this.logDir, 'encoder.log')}`,
                );
            }
            try {
                await fetch(url);
                return;
            } catch {
                await delay(250);
            }
        }
        throw new Error(`Encoder did not become ready within ${timeoutMs}ms`);
    }

    /**
     * Stop the encoder, giving it time to shut down cleanly.
     *
     * This matters more than it looks. The encoder's shutdown hooks are what
     * terminate a running ffmpeg; killing it outright orphans that process and
     * leaves a half-written HLS tree in WORK_DIR. Windows has no SIGTERM, so
     * there `kill()` is already a hard terminate — which is why the fallback
     * below is a last resort on every platform rather than the normal path.
     */
    async stop(graceMs = 10_000) {
        if (!this.#proc || this.#exited !== null) return;

        this.#proc.kill('SIGTERM');

        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline && this.#exited === null) {
            await delay(100);
        }

        if (this.#exited === null) {
            this.#proc.kill('SIGKILL');
            await delay(250);
        }

        this.#logStream?.end();
    }

    get exitCode() {
        return this.#exited;
    }
}

function dirOf(filePath) {
    if (!filePath) return null;
    const idx = Math.max(
        filePath.lastIndexOf('/'),
        filePath.lastIndexOf('\\'),
    );
    return idx > 0 ? filePath.slice(0, idx) : null;
}

function pathSeparator() {
    return process.platform === 'win32' ? ';' : ':';
}
