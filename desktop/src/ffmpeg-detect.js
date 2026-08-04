/**
 * Locate ffmpeg and ffprobe on the user's machine.
 *
 * The desktop build deliberately does not bundle them. A GPL ffmpeg (the one
 * with libx264/libx265, i.e. the one that can encode without a GPU) would
 * encumber the distributed app, which is Apache-2.0; an LGPL build would leave
 * machines without a supported GPU unable to encode at all. Using whatever the
 * user already has sidesteps both, at the cost of having to find it.
 *
 * Finding it is the whole problem. A GUI-launched app inherits almost nothing
 * from the user's shell — on macOS, an app opened from Finder or Dock gets a
 * PATH of roughly /usr/bin:/bin:/usr/sbin:/sbin, so a Homebrew ffmpeg in
 * /opt/homebrew/bin is invisible even though `which ffmpeg` works in a terminal.
 * That is why this probes known install locations directly instead of trusting
 * PATH, and why it must be tested against a packaged, Finder-launched build
 * rather than `npm start`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

const BIN_NAMES =
    process.platform === 'win32'
        ? { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' }
        : { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

/** Where each platform's package managers and installers actually put things. */
function candidateDirs() {
    const home = homedir();

    if (process.platform === 'darwin') {
        return [
            '/opt/homebrew/bin', // Homebrew, Apple Silicon
            '/usr/local/bin', // Homebrew, Intel — and most manual installs
            '/opt/local/bin', // MacPorts
            '/usr/bin',
            join(home, 'bin'),
        ];
    }

    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return [
            join(programFiles, 'ffmpeg', 'bin'),
            'C:\\ffmpeg\\bin',
            join(localAppData, 'Microsoft', 'WinGet', 'Links'), // winget shims
            join(home, 'scoop', 'shims'), // scoop
            'C:\\ProgramData\\chocolatey\\bin', // chocolatey
        ];
    }

    return [
        '/usr/bin',
        '/usr/local/bin',
        '/snap/bin',
        '/var/lib/flatpak/exports/bin',
        join(home, '.local', 'bin'),
    ];
}

/**
 * Confirm a path is really the tool we want, by running it.
 *
 * An existsSync check is not enough: a broken symlink, a stub shim, or a
 * quarantined binary all pass it and then fail mid-encode instead.
 */
async function probe(path) {
    try {
        const { stdout } = await execFileAsync(path, ['-version'], {
            timeout: 10_000,
        });
        const version = stdout.split('\n')[0]?.trim();
        return version ? { path, version } : null;
    } catch {
        return null;
    }
}

/** Locate one tool, trying explicit config, then known dirs, then PATH. */
async function locate(tool, override) {
    if (override) {
        const found = await probe(override);
        if (found) return { ...found, source: 'configured' };
        throw new Error(
            `${tool} was configured as "${override}" but did not run`,
        );
    }

    for (const dir of candidateDirs()) {
        const path = join(dir, BIN_NAMES[tool]);
        if (!existsSync(path)) continue;
        const found = await probe(path);
        if (found) return { ...found, source: dir };
    }

    // Last resort. Works when launched from a shell, and on Windows where the
    // GUI environment does inherit the system PATH — but on macOS a
    // Finder-launched app rarely gets here with a useful PATH.
    const found = await probe(BIN_NAMES[tool]);
    if (found) return { ...found, source: 'PATH' };

    return null;
}

/**
 * @returns {Promise<{ok: true, ffmpeg: object, ffprobe: object}
 *                  | {ok: false, missing: string[], searched: string[]}>}
 */
export async function detectFfmpeg(overrides = {}) {
    const [ffmpeg, ffprobe] = await Promise.all([
        locate('ffmpeg', overrides.ffmpeg),
        locate('ffprobe', overrides.ffprobe),
    ]);

    // Both are required: ffprobe drives the probe that every session depends on,
    // so ffmpeg alone is not a usable install.
    const missing = [];
    if (!ffmpeg) missing.push('ffmpeg');
    if (!ffprobe) missing.push('ffprobe');

    if (missing.length > 0) {
        return { ok: false, missing, searched: candidateDirs() };
    }

    return { ok: true, ffmpeg, ffprobe };
}

/** Per-platform install guidance, shown when detection fails. */
export function installHint() {
    switch (process.platform) {
        case 'darwin':
            return 'Install with Homebrew:  brew install ffmpeg';
        case 'win32':
            return 'Install with winget:  winget install Gyan.FFmpeg';
        default:
            return 'Install with your package manager, e.g.  sudo apt install ffmpeg';
    }
}
