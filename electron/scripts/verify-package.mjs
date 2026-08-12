#!/usr/bin/env node
/**
 * Assert that a packaged app can actually encode.
 *
 * The failure this exists to catch is silent by design: electron-builder treats a
 * missing `extraResources` source as a **warning**, not an error. Remove the binaries
 * and a package still succeeds, producing a well-formed app with no ffmpeg in it —
 * which installs, launches, shows its UI, accepts a file, and only then fails at the
 * one thing it exists to do. Nothing downstream notices, because the app starts fine
 * without them.
 *
 * The risk is real on this project specifically: `dist:mac` builds arm64 *and* x64,
 * so a step that prepares only the host architecture leaves the other dmg with no
 * encoder — and that is invisible on a machine where the other `bin/<target>`
 * directory happens to exist already.
 *
 * Run after packaging, over every app electron-builder produced:
 *
 *     node scripts/verify-package.mjs            # everything under release/
 *     node scripts/verify-package.mjs release/mac-arm64
 *
 * Checks per app: both binaries present, non-trivial in size, the licence notice
 * and a GPL text beside them (the condition of shipping a GPL build at all), the
 * web client present, and — when the host can execute them — that the *shipped*
 * copy runs and identifies itself. A stub named `ffmpeg` would pass a file-exists
 * test; it does not pass this.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronRoot = join(here, '..');

/**
 * A real ffmpeg is ~50-150 MB. The floor is deliberately low — it is here to
 * catch a zero-byte file or a shell wrapper, not to police build variation.
 */
const MIN_BINARY_BYTES = 1_000_000;

const problems = [];
const notes = [];

/** Where the app's resources live, per platform layout. */
function resourcesDir(appDir) {
    // macOS: <name>.app/Contents/Resources. Windows/Linux: <dir>/resources.
    const macApp = readdirSync(appDir, { withFileTypes: true }).find(
        (e) => e.isDirectory() && e.name.endsWith('.app')
    );
    if (macApp) {
        const r = join(appDir, macApp.name, 'Contents', 'Resources');
        return existsSync(r) ? r : null;
    }
    const r = join(appDir, 'resources');
    return existsSync(r) ? r : null;
}

/** Whether this machine can execute the binaries in a packaged app directory. */
function canRun(appDirName) {
    if (process.platform === 'win32') return appDirName.includes('win');
    if (process.platform !== 'darwin') return false;
    if (!appDirName.startsWith('mac')) return false;
    // `mac-arm64` is native here only on arm64; plain `mac` is the x64 build,
    // which needs Rosetta. Without it every probe fails as though the binary
    // were broken, so report unverified rather than failed.
    const wantsX64 = !appDirName.includes('arm64');
    if (!wantsX64) return process.arch === 'arm64';
    if (process.arch === 'x64') return true;
    try {
        execFileSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], {
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

function verifyApp(appDir, appDirName) {
    const res = resourcesDir(appDir);
    if (!res) {
        problems.push(`${appDirName}: no resources directory found`);
        return;
    }

    const exe =
        process.platform === 'win32' || appDirName.includes('win')
            ? '.exe'
            : '';
    const runnable = canRun(appDirName);
    console.log(
        `\n  ${appDirName}${runnable ? '' : '  (present-only: cannot execute here)'}`
    );

    for (const name of [`ffmpeg${exe}`, `ffprobe${exe}`]) {
        const p = join(res, name);
        if (!existsSync(p)) {
            problems.push(
                `${appDirName}: ${name} is NOT in the packaged app — it cannot encode. ` +
                    'electron-builder only warns when extraResources is missing.'
            );
            continue;
        }
        const size = statSync(p).size;
        if (size < MIN_BINARY_BYTES) {
            problems.push(
                `${appDirName}: ${name} is only ${size} bytes — not a real binary`
            );
            continue;
        }
        console.log(`    ✓ ${name} (${(size / 1_048_576).toFixed(0)} MB)`);

        if (!runnable) continue;
        try {
            const out = execFileSync(p, ['-hide_banner', '-version'], {
                encoding: 'utf8',
            });
            if (!out.includes(`${name.replace('.exe', '')} version`)) {
                problems.push(`${appDirName}: ${name} did not identify itself`);
            } else {
                console.log(`      ${out.split('\n')[0].slice(0, 72)}`);
            }
        } catch (e) {
            problems.push(
                `${appDirName}: the shipped ${name} would not run — ${e.message}`
            );
        }
    }

    // A GPL binary may not ship without its licence. Which text depends on the
    // build (v2-or-later ships both, v3-or-later ships v3 only), so require the
    // notice plus at least one GPL text rather than a fixed filename.
    if (!existsSync(join(res, 'LICENSE-ffmpeg.txt'))) {
        problems.push(
            `${appDirName}: LICENSE-ffmpeg.txt is missing — a GPL build needs its notice`
        );
    }
    const gpl = readdirSync(res).filter((f) => /^GPL-[\d.]+\.txt$/.test(f));
    if (gpl.length === 0) {
        problems.push(
            `${appDirName}: no GPL licence text shipped. GPLv2 §1 and GPLv3 §4 both ` +
                'require a *copy* of the licence to travel with the binary; a link is not one.'
        );
    } else {
        console.log(`    ✓ ${['LICENSE-ffmpeg.txt', ...gpl].join(', ')}`);
    }

    // The API serves this at / in a packaged build; without it the window is blank.
    if (!existsSync(join(res, 'app', 'index.html'))) {
        problems.push(
            `${appDirName}: the web client (app/index.html) is missing`
        );
    } else {
        console.log('    ✓ web client');
    }
}

// resolve(), not join(cwd, …): the argument may be absolute, and joining an
// absolute path onto the cwd produces a path that exists nowhere.
const releaseDir = process.argv[2]
    ? resolve(process.argv[2])
    : join(electronRoot, 'release');

if (!existsSync(releaseDir)) {
    console.error(
        `\n  ✗ Nothing to verify: ${releaseDir} does not exist. Package first.\n`
    );
    process.exit(1);
}

/*
 * One entry per packaged app, matched against the names electron-builder actually
 * uses: `mac`, `mac-arm64`, `win-unpacked`, `win-ia32-unpacked`, `linux-unpacked`.
 *
 * Matched exactly rather than by prefix. A loose `^(mac|win|linux)` also matches
 * anything else a human parks in release/ — a folder of installers downloaded from
 * CI, for instance — and reporting "no resources directory" for a directory that
 * was never an app is a false alarm that teaches people to ignore this script.
 */
const APP_DIR =
    /^(mac(-(arm64|x64|universal))?|(win|linux)(-(ia32|x64|arm64|armv7l))?-unpacked)$/;
const appDirs = readdirSync(releaseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && APP_DIR.test(e.name))
    .map((e) => e.name);

if (appDirs.length === 0) {
    console.error(
        `\n  ✗ No packaged app directories under ${releaseDir}. ` +
            'Expected mac/, mac-arm64/, win-unpacked/ or similar.\n'
    );
    process.exit(1);
}

console.log(`\n  Verifying ${appDirs.length} packaged app(s) in ${releaseDir}`);
for (const name of appDirs) verifyApp(join(releaseDir, name), name);

for (const note of notes) console.log(`\n  · ${note}`);

if (problems.length > 0) {
    console.error(`\n  ✗ ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`      - ${p}`);
    console.error('');
    process.exit(1);
}

console.log(
    `\n  All ${appDirs.length} packaged app(s) carry their encoder and its licence.\n`
);
