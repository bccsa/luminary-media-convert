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
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    statSync,
} from 'node:fs';
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

/**
 * The architecture a binary was compiled for, read from its own header.
 *
 * Running a binary does not establish this: macOS runs x86_64 under Rosetta on an
 * arm64 machine, so an arm64 ffmpeg placed in the x64 app would execute here and ship
 * an Intel dmg that cannot start on Intel.
 */
function architectureOf(path) {
    const fd = openSync(path, 'r');
    try {
        const head = Buffer.alloc(64);
        readSync(fd, head, 0, 64, 0);

        // Universal (fat) Mach-O: both slices in one file. Recognised so it is
        // reported as what it is, rather than failing an arch comparison it would
        // actually satisfy.
        const be0 = head.readUInt32BE(0);
        if (be0 === 0xcafebabe || be0 === 0xcafebabf) return 'universal';

        // Mach-O: magic then cputype. 0xfeedfacf little-endian is 64-bit.
        const machO =
            head.readUInt32LE(0) === 0xfeedfacf ||
            head.readUInt32BE(0) === 0xfeedfacf;
        if (machO) {
            const cpu =
                head.readUInt32LE(0) === 0xfeedfacf
                    ? head.readUInt32LE(4)
                    : head.readUInt32BE(4);
            if (cpu === 0x0100000c) return 'arm64';
            if (cpu === 0x01000007) return 'x64';
            return `mach-o cputype ${cpu}`;
        }

        // PE: 'MZ', then the COFF machine field at the offset e_lfanew points to.
        if (head.readUInt16LE(0) === 0x5a4d) {
            const off = head.readUInt32LE(0x3c);
            const coff = Buffer.alloc(6);
            readSync(fd, coff, 0, 6, off);
            if (coff.toString('ascii', 0, 4) !== 'PE\0\0')
                return 'pe (unrecognised)';
            const machine = coff.readUInt16LE(4);
            if (machine === 0x8664) return 'x64';
            if (machine === 0xaa64) return 'arm64';
            if (machine === 0x014c) return 'ia32';
            return `pe machine 0x${machine.toString(16)}`;
        }
        return 'unknown';
    } finally {
        closeSync(fd);
    }
}

/**
 * The architecture an electron-builder output directory is supposed to hold, or
 * null where the comparison does not apply: universal apps carry both slices, and
 * ELF parsing is not implemented, so Linux directories are reported rather than
 * failed against a guess.
 */
function expectedArch(appDirName) {
    if (appDirName.includes('universal')) return null;
    if (appDirName.startsWith('linux')) return null;
    if (appDirName.includes('arm64')) return 'arm64';
    if (appDirName.includes('ia32')) return 'ia32';
    // `mac` and `win-unpacked` with no arch in the name are electron-builder's x64.
    return 'x64';
}

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

// `--enable-gpl` is what gates libx264 and makes the build GPL; `--enable-nonfree`
// produces a binary FFmpeg itself describes as unredistributable; `--enable-version3`
// moves the result to v3 with its anti-tivoization and patent-termination terms.
const FORBIDDEN_FLAGS = /--enable-(?:gpl|nonfree|version3)\b/g;

// Present in the encoder list, these prove a GPL build whatever the flags say.
const FORBIDDEN_ENCODERS = /\blibx26[45]\b/;

/**
 * Assert the shipped encoder is an LGPL build with no software H.264 encoder.
 *
 * Read from BUILDCONF.txt rather than a live `-buildconf` so the cross-built
 * Windows binary is covered too: it cannot be executed on the macOS machine that
 * packages it, and a gate that skips the target it cannot run is not a gate.
 * Where the host *can* run the binary both are asserted — the file records what
 * the build script configured, the binary records what actually shipped.
 *
 * Never grep for `GPL` here: `LGPL` contains it, and the LGPL text itself spells
 * out "General Public License". Match the distinguishing word instead.
 */
function verifyEncoderLicence(res, appDirName, exe, runnable) {
    const conf = join(res, 'BUILDCONF.txt');
    if (!existsSync(conf)) {
        problems.push(
            `${appDirName}: BUILDCONF.txt is missing — there is no record of how the ` +
                'shipped ffmpeg was configured, so its licence cannot be verified'
        );
        return;
    }

    const flags = [
        ...new Set(readFileSync(conf, 'utf8').match(FORBIDDEN_FLAGS) ?? []),
    ];
    if (flags.length) {
        problems.push(
            `${appDirName}: ffmpeg is configured with ${flags.join(', ')}. The licensing ` +
                'policy requires an LGPL build — no gpl, no nonfree, no version3.'
        );
    }

    if (!runnable) {
        if (!flags.length) console.log('    ✓ BUILDCONF.txt: no forbidden flags');
        return;
    }

    const ff = join(res, `ffmpeg${exe}`);
    if (!existsSync(ff)) return;

    const ask = (flag) => {
        try {
            return execFileSync(ff, ['-hide_banner', flag], { encoding: 'utf8' });
        } catch {
            return '';
        }
    };

    // FFmpeg's own banner is the authority on what the binary is.
    const banner = ask('-L');
    if (banner && !banner.includes('Lesser')) {
        const version = banner.match(/either version (\d)/)?.[1];
        problems.push(
            `${appDirName}: the shipped ffmpeg reports GPL${version ? `-${version}.0-or-later` : ''}, ` +
                'not LGPL. The binary is the authority here, not the configure line.'
        );
    }

    const encoders = ask('-encoders');
    const bad = encoders.match(FORBIDDEN_ENCODERS);
    if (bad) {
        problems.push(
            `${appDirName}: the shipped ffmpeg still carries ${bad[0]}. The policy ` +
                'bundles no software H.264 encoder — OS and GPU encoders only.'
        );
    }

    if (!flags.length && banner.includes('Lesser') && !bad) {
        console.log('    ✓ encoder licence: LGPL, no software H.264 encoder');
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
        const arch = architectureOf(p);
        const want = expectedArch(appDirName);
        // A universal binary satisfies either specific architecture.
        if (want && arch !== want && arch !== 'universal') {
            problems.push(
                `${appDirName}: ${name} is ${arch}, but this app is ${want}. It would not ` +
                    'start on the machine this build is for.'
            );
            continue;
        }
        console.log(
            `    ✓ ${name} (${(size / 1_048_576).toFixed(0)} MB, ${arch})`
        );

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
    // libwebp is statically linked and BSD-3-Clause: reproducing its notice with the
    // distribution is a condition of shipping the binary, and LICENSE-ffmpeg.txt
    // refers the reader to this file by name.
    if (!existsSync(join(res, 'LICENSE-libwebp.txt'))) {
        problems.push(
            `${appDirName}: LICENSE-libwebp.txt is missing — libwebp is statically linked (BSD-3-Clause)`
        );
    }
    // libvpl is statically linked into the Windows binaries only — it is what gives
    // them Quick Sync — and MIT asks for its notice to travel with the copy.
    const notices = ['LICENSE-ffmpeg.txt', 'LICENSE-libwebp.txt'];
    if (exe === '.exe') {
        if (!existsSync(join(res, 'LICENSE-libvpl.txt'))) {
            problems.push(
                `${appDirName}: LICENSE-libvpl.txt is missing — libvpl is statically linked (MIT)`
            );
        }
        notices.push('LICENSE-libvpl.txt');
    }
    // The licence the binary is actually under has to travel with it: LGPL-2.1
    // s.6 asks for a copy exactly as GPLv2 §1 and GPLv3 §4 did. Either text
    // satisfies this — an LGPL build ships COPYING.LGPLv2.1, and a build made
    // before the switch still carries its GPL texts.
    const licences = readdirSync(res).filter(
        (f) => /^GPL-[\d.]+\.txt$/.test(f) || f === 'COPYING.LGPLv2.1'
    );
    if (licences.length === 0) {
        problems.push(
            `${appDirName}: no licence text shipped for ffmpeg. LGPL-2.1 §6, GPLv2 §1 ` +
                'and GPLv3 §4 all require a *copy* to travel with the binary; a link is not one.'
        );
    } else {
        console.log(`    ✓ ${[...notices, ...licences].join(', ')}`);
    }

    verifyEncoderLicence(res, appDirName, exe, runnable);

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

if (problems.length > 0) {
    console.error(`\n  ✗ ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`      - ${p}`);
    console.error('');
    process.exit(1);
}

console.log(
    `\n  All ${appDirs.length} packaged app(s) carry their encoder and its licence.\n`
);
