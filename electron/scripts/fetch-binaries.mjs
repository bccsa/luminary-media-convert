#!/usr/bin/env node
/**
 * Fetch the ffmpeg/ffprobe pair the packaged app ships.
 *
 * The app does not encode: it drives ffmpeg. A user who downloads a media
 * converter has not also installed a media toolchain, so without these the
 * packaged app starts, shows its UI, accepts a file, and then fails at the one
 * thing it exists to do.
 *
 * Why fetched and not committed: two ~50 MB binaries per platform do not belong
 * in a git history. Why scripted and not a manual download: the build has to be
 * reproducible. Every release built from this repository should carry the same
 * ffmpeg, and a hand-copied binary is a build nobody else can reproduce and
 * nobody can audit afterwards.
 *
 * Digests are pinned. A mismatch is a hard failure rather than a warning: this
 * binary is distributed to users, and "the download changed" is exactly the
 * event a pinned digest exists to catch.
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const binRoot = join(here, '..', 'bin');

/**
 * One entry per platform the app is built for.
 *
 * macOS arm64 comes from osxexperts.net: the better-known evermeet.cx publishes
 * x86_64 only, which would run under Rosetta on the machines this app targets.
 * Homebrew's build is not a candidate at all — it links against eighteen
 * dylibs under /opt/homebrew and cannot start anywhere else.
 *
 * These are GPL builds, and deliberately. The LGPL ones omit libx264, which is
 * the CPU fallback in FfmpegService — without it the app cannot encode at all
 * on a machine with no VideoToolbox or NVENC. ffmpeg runs as a separate
 * process, never linked, so the obligation travels with ffmpeg rather than
 * with this Apache-2.0 codebase; LICENSE-ffmpeg.txt is written beside the
 * binaries and shipped with them.
 */
const TARGETS = {
    'darwin-arm64': {
        version: '8.1',
        arch: 'arm64',
        /**
         * One entry per archive, each naming what it provides. macOS ships the
         * two binaries separately; Windows ships both in one 160 MB zip, so the
         * shape has to allow either without downloading the same archive twice.
         */
        archives: [
            {
                url: 'https://www.osxexperts.net/ffmpeg81arm.zip',
                sha256: 'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
                provides: [{ name: 'ffmpeg', from: 'ffmpeg' }],
            },
            {
                url: 'https://www.osxexperts.net/ffprobe81arm.zip',
                sha256: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
                provides: [{ name: 'ffprobe', from: 'ffprobe' }],
            },
        ],
        /**
         * What the app actually asks of this build. Checked after unpacking,
         * because a binary that downloads and unzips cleanly can still be the
         * wrong architecture or missing the encoder the whole bundle is for.
         *
         * Only ffmpeg is asked about codecs: ffprobe inspects media and does
         * not take `-hwaccels`, `-encoders` or `-filters` at all.
         */
        verify: {
            ffmpeg: {
                hwaccel: 'videotoolbox',
                encoders: ['h264_videotoolbox', 'libx264'],
                filters: ['scale_vt'],
            },
        },
    },

    /**
     * Windows, pinned to a dated BtbN release rather than their `latest` tag —
     * `latest` moves, and a moving URL cannot be pinned to a digest.
     *
     * The `-gpl` build rather than `-gpl-shared`: shared means DLLs beside the
     * executable, and `bundledBinary()` resolves a single file. Same reasoning
     * that ruled out Homebrew on macOS.
     */
    'win32-x64': {
        version: '8.1.2',
        // What `file` reports for a 64-bit PE executable.
        arch: 'x86-64',
        archives: [
            {
                url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-11-13-11/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip',
                sha256: '05eedc113542be39af5d0f78f0b1093bafb89c98cecf25b77e8644670293107f',
                provides: [
                    { name: 'ffmpeg.exe', from: '*/bin/ffmpeg.exe' },
                    { name: 'ffprobe.exe', from: '*/bin/ffprobe.exe' },
                ],
            },
        ],
        verify: {
            'ffmpeg.exe': {
                hwaccel: 'cuda',
                encoders: ['h264_nvenc', 'libx264'],
                filters: ['scale_cuda'],
            },
        },
    },
};

/** Whether this machine can execute the target's binaries. */
const canRunTarget = (name) => name.split('-')[0] === process.platform;

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;

function fail(message) {
    console.error(`\n  ✗ ${message}\n`);
    process.exit(1);
}

async function download(url) {
    const response = await fetch(url);
    if (!response.ok) fail(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Confirm the binary can do what the encoder will ask of it.
 *
 * `-hwaccels` and friends are the same questions FfmpegService asks at start-up
 * to choose its acceleration mode, so a build that passes here is one that will
 * report the mode we expect rather than silently falling back to CPU.
 */
function verifyCapabilities(binary, name, arch, spec, executable) {
    const run = (...args) =>
        execFileSync(binary, ['-hide_banner', ...args], { encoding: 'utf8' });

    // Architecture is readable without running anything, so it is checked on
    // every platform: `file` reports `arm64` for a Mach-O and `x86-64` for a PE.
    const described = execFileSync('file', [binary], { encoding: 'utf8' });
    if (!described.includes(arch)) fail(`${name} is not ${arch}: ${described.trim()}`);

    /*
     * Everything below has to *run* the binary, which a machine of a different
     * platform cannot do — fetching win32-x64 from a Mac is useful (CI, or
     * preparing a release) but it cannot answer "does this build have NVENC".
     *
     * Saying so is the point. Silently skipping would let an unverified binary
     * reach an installer looking exactly like a verified one, and the whole
     * reason this step exists is that hardware support is a compile-time
     * decision that cannot be added later.
     */
    if (!executable) {
        console.log(
            `  ⚠ ${name}: architecture confirmed (${arch}), capabilities NOT checked\n` +
                `      — this machine cannot run a ${target} binary. Before shipping, run\n` +
                `        \`npm run fetch-binaries ${target}\` on ${target} itself, where the\n` +
                `        checks below will actually execute.`,
        );
        return;
    }

    // Runs at all, and is not quietly a shell script wrapping a system install.
    const selfName = name.replace(/\.exe$/, '');
    if (!run('-version').includes(`${selfName} version`)) {
        fail(`${name} did not identify itself as ${selfName}`);
    }

    if (!spec) {
        console.log(`  ✓ ${name} verified`);
        return;
    }

    if (!run('-hwaccels').includes(spec.hwaccel)) {
        fail(
            `${name} has no ${spec.hwaccel} support — hardware encoding is a ` +
                'compile-time decision, so this build can never gain it',
        );
    }

    const encoders = run('-encoders');
    for (const encoder of spec.encoders) {
        if (!encoders.includes(encoder)) fail(`${name} is missing the ${encoder} encoder`);
    }

    const filters = run('-filters');
    for (const filter of spec.filters) {
        if (!filters.includes(filter)) fail(`${name} is missing the ${filter} filter`);
    }

    console.log(`  ✓ ${name} verified`);
}

async function main() {
    const spec = TARGETS[target];
    if (!spec) {
        fail(
            `No binaries defined for ${target}. Known: ${Object.keys(TARGETS).join(', ')}. ` +
                'See electron/bin/README.md for how to add one.',
        );
    }

    const outDir = join(binRoot, target);
    await mkdir(outDir, { recursive: true });

    const staging = join(tmpdir(), `lmc-ffmpeg-${process.pid}`);
    await mkdir(staging, { recursive: true });

    try {
        for (const [index, archive] of spec.archives.entries()) {
            const wanted = archive.provides.filter(
                (entry) => !existsSync(join(outDir, entry.name)),
            );
            if (wanted.length === 0) {
                for (const entry of archive.provides) {
                    console.log(`  · ${entry.name} already here, skipping`);
                }
                continue;
            }

            console.log(`  ↓ ${archive.url}`);
            const bytes = await download(archive.url);

            const actual = digest(bytes);
            if (actual !== archive.sha256) {
                fail(
                    `Digest mismatch for ${archive.url}.\n    expected ${archive.sha256}\n    got      ${actual}\n` +
                        '    This binary is distributed to users. Investigate before pinning the new digest.',
                );
            }

            const archivePath = join(staging, `archive-${index}.zip`);
            await writeFile(archivePath, bytes);

            for (const entry of wanted) {
                // `-j` flattens: Windows builds keep their binaries in
                // `<release>/bin/`, and the destination is a flat directory.
                execFileSync('unzip', ['-joq', archivePath, entry.from, '-d', staging]);
                const unpacked = join(staging, basename(entry.from));
                if (!existsSync(unpacked)) {
                    fail(`${entry.from} was not in ${archive.url}`);
                }
                execFileSync('mv', [unpacked, join(outDir, entry.name)]);
                await chmod(join(outDir, entry.name), 0o755);
                console.log(`  ✓ ${entry.name}`);
            }
        }

        const names = spec.archives.flatMap((a) => a.provides.map((e) => e.name));
        for (const name of names) {
            verifyCapabilities(
                join(outDir, name),
                name,
                spec.arch,
                spec.verify[name],
                canRunTarget(target),
            );
        }

        /*
         * The licence texts themselves, copied beside the binaries.
         *
         * GPLv2 §1 requires giving recipients "a copy of this License along with
         * the Program" — a link in a notice is not a copy. Both versions travel
         * because the build is "v2 or later": v2 is what we convey under, and a
         * recipient exercising the "or later" option should not have to go
         * looking for v3.
         *
         * Vendored in `electron/bin/licenses/` rather than downloaded here: they
         * must ship whether or not anyone reruns this script, and they are 53 KB
         * of text that never changes.
         */
        for (const licence of ['GPL-2.0.txt', 'GPL-3.0.txt']) {
            const from = join(binRoot, 'licenses', licence);
            if (!existsSync(from)) {
                fail(
                    `${licence} is missing from electron/bin/licenses/. It has to ship ` +
                        'with the binaries — see docs/ffmpeg-licensing.md.',
                );
            }
            await copyFile(from, join(outDir, licence));
        }
        console.log('  ✓ GPL-2.0.txt, GPL-3.0.txt');

        /*
         * Shipped beside the binaries: a GPL build obliges the licence to travel
         * with what is distributed.
         *
         * The version is v2-or-later, taken from the binary itself rather than
         * assumed — `ffmpeg -L` says so, and `-buildconf` shows `--enable-gpl`
         * without `--enable-version3`. This file previously claimed v3-or-later,
         * which understated our recipients' options and pointed at the wrong
         * licence text.
         *
         * The source line is honest about what it is: upstream's download page is
         * *not* the corresponding source for this build, which statically links
         * x264 and x265 and so obliges their source at these versions too. See
         * docs/ffmpeg-licensing.md — closing that gap is the mirroring work in
         * Todo item 40, and until it is done a public release is not compliant.
         */
        await writeFile(
            join(outDir, 'LICENSE-ffmpeg.txt'),
            [
                `FFmpeg ${spec.version}, built by osxexperts.net, distributed under the GNU General`,
                'Public License version 2 or later, with libx264 and libx265 statically linked.',
                '',
                'This application invokes ffmpeg as a separate process; it is not linked against',
                'the FFmpeg libraries. The application itself is licensed under Apache-2.0.',
                '',
                'Licence text:   GPL-2.0.txt beside this file (and GPL-3.0.txt, at your option)',
                'FFmpeg project: https://ffmpeg.org/download.html',
                '',
                'Corresponding source for this exact build is not yet published alongside it.',
                'Request it from the distributor; see docs/ffmpeg-licensing.md.',
                '',
            ].join('\n'),
        );

        console.log(
            canRunTarget(target)
                ? `\n  All good — ${target} is ready to package.\n`
                : `\n  Fetched and pinned, but NOT verified: ${target} binaries cannot be run\n` +
                      `  here. They are packageable, and a release built from them has had its\n` +
                      `  hardware support taken on trust. Run this on ${target} to confirm.\n`,
        );
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

await main();
