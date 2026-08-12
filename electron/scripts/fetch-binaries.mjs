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
import {
    chmod,
    copyFile,
    mkdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binRoot = join(here, '..', 'bin');

import { TARGETS } from './ffmpeg-targets.mjs';

/**
 * Whether this machine can execute the target's binaries — which decides whether
 * the capability checks *run* or the target is merely fetched and pinned.
 *
 * Architecture counts, not just platform: an arm64 Mac building the Intel target
 * can only run those binaries if Rosetta is installed, and without it every
 * capability probe fails identically to a build that genuinely lacks the encoder.
 * Calling that a bad build would be wrong — so probe for Rosetta and, absent it,
 * report the target as fetched-but-unverified, the same as a cross-platform fetch.
 */
const rosettaAvailable = () => {
    try {
        execFileSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], {
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
};

const canRunTarget = (name) => {
    const [platform, arch] = name.split('-');
    if (platform !== process.platform) return false;
    if (arch === process.arch) return true;
    // The one cross-arch case worth supporting: x64 binaries on an Apple Silicon
    // Mac. Nothing translates the other way, and Windows-on-arm is not a target.
    return (
        process.platform === 'darwin' &&
        process.arch === 'arm64' &&
        arch === 'x64' &&
        rosettaAvailable()
    );
};

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
/**
 * The architecture an executable was built for, read from its own header.
 *
 * Replaces shelling out to `file`, which does not exist on Windows — and this
 * script has to run on the platform it fetches for, or the capability checks
 * below can never execute. Reading eight bytes is also more precise than
 * pattern-matching an English sentence.
 */
function architectureOf(binary) {
    const fd = openSync(binary, 'r');
    try {
        const head = Buffer.alloc(64);
        readSync(fd, head, 0, 64, 0);

        // Mach-O, 64-bit little-endian: magic then cputype.
        if (head.readUInt32LE(0) === 0xfeedfacf) {
            const cpuType = head.readUInt32LE(4);
            if (cpuType === 0x0100000c) return 'arm64';
            if (cpuType === 0x01000007) return 'x86-64';
            return `mach-o cputype 0x${cpuType.toString(16)}`;
        }

        // PE: 'MZ', then the COFF header's machine field at e_lfanew + 4.
        if (head.readUInt16LE(0) === 0x5a4d) {
            const peOffset = head.readUInt32LE(0x3c);
            const coff = Buffer.alloc(6);
            readSync(fd, coff, 0, 6, peOffset);
            if (coff.readUInt32LE(0) !== 0x00004550)
                return 'pe (no PE signature)';
            const machine = coff.readUInt16LE(4);
            if (machine === 0x8664) return 'x86-64';
            if (machine === 0xaa64) return 'arm64';
            return `pe machine 0x${machine.toString(16)}`;
        }

        return 'unrecognised executable format';
    } finally {
        closeSync(fd);
    }
}

function verifyCapabilities(binary, name, arch, spec, executable) {
    const run = (...args) =>
        execFileSync(binary, ['-hide_banner', ...args], { encoding: 'utf8' });

    // Readable without running anything, so it is checked on every platform.
    const actualArch = architectureOf(binary);
    if (actualArch !== arch) fail(`${name} is ${actualArch}, expected ${arch}`);

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
                `        checks below will actually execute.`
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
                'compile-time decision, so this build can never gain it'
        );
    }

    const encoders = run('-encoders');
    for (const encoder of spec.encoders) {
        if (!encoders.includes(encoder))
            fail(`${name} is missing the ${encoder} encoder`);
    }

    const filters = run('-filters');
    for (const filter of spec.filters) {
        if (!filters.includes(filter))
            fail(`${name} is missing the ${filter} filter`);
    }

    console.log(`  ✓ ${name} verified`);
}

async function main() {
    const spec = TARGETS[target];
    if (!spec) {
        fail(
            `No binaries defined for ${target}. Known: ${Object.keys(TARGETS).join(', ')}. ` +
                'See electron/bin/README.md for how to add one.'
        );
    }

    const outDir = join(binRoot, target);
    await mkdir(outDir, { recursive: true });

    /*
     * Staged inside `electron/bin/`, not the OS temp directory.
     *
     * `fs.rename` cannot cross volumes, and on a GitHub Windows runner the temp
     * directory is on C: while the checkout is on D: — which failed with EXDEV
     * the first time this ran there, a case no macOS run can reproduce because
     * everything is one filesystem. Staging beside the destination keeps the
     * move within one volume on every platform.
     */
    const staging = join(binRoot, `.staging-${process.pid}`);
    await mkdir(staging, { recursive: true });

    try {
        for (const [index, archive] of spec.archives.entries()) {
            const wanted = archive.provides.filter(
                (entry) => !existsSync(join(outDir, entry.name))
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
                        '    This binary is distributed to users. Investigate before pinning the new digest.'
                );
            }

            const archivePath = join(staging, `archive-${index}.zip`);
            await writeFile(archivePath, bytes);

            for (const entry of wanted) {
                /*
                 * `tar` rather than `unzip`, and `rename` rather than `mv`: this
                 * script has to run on Windows as well as macOS, where neither
                 * of those exists. Windows 10 and later ship bsdtar, which reads
                 * zips, matches wildcards and strips leading path components —
                 * the same invocation works on both platforms.
                 */
                const depth = entry.from.split('/').length - 1;
                execFileSync('tar', [
                    '-xf',
                    archivePath,
                    '-C',
                    staging,
                    ...(depth > 0 ? [`--strip-components=${depth}`] : []),
                    entry.from,
                ]);
                const unpacked = join(staging, basename(entry.from));
                if (!existsSync(unpacked)) {
                    fail(`${entry.from} was not in ${archive.url}`);
                }
                await rename(unpacked, join(outDir, entry.name));
                await chmod(join(outDir, entry.name), 0o755);
                console.log(`  ✓ ${entry.name}`);
            }
        }

        const names = spec.archives.flatMap((a) =>
            a.provides.map((e) => e.name)
        );
        for (const name of names) {
            verifyCapabilities(
                join(outDir, name),
                name,
                spec.arch,
                spec.verify[name],
                canRunTarget(target)
            );
        }

        /*
         * The licence texts themselves, copied beside the binaries.
         *
         * GPLv2 §1 and GPLv3 §4 both require giving recipients "a copy of this
         * License along with the Program" — a link in a notice is not a copy.
         *
         * Which texts travel follows the build. A v2-or-later build conveys under
         * v2 and lets the recipient take v3 instead, so both ship. A v3-or-later
         * build does not offer v2 at all, and shipping that text beside it would
         * suggest an option the recipient does not have.
         *
         * Vendored in `electron/bin/licenses/` rather than downloaded here: they
         * must ship whether or not anyone reruns this script, and they are 53 KB
         * of text that never changes.
         */
        const licences = spec.licence.startsWith('GPL-3.0')
            ? ['GPL-3.0.txt']
            : ['GPL-2.0.txt', 'GPL-3.0.txt'];
        for (const licence of licences) {
            const from = join(binRoot, 'licenses', licence);
            if (!existsSync(from)) {
                fail(
                    `${licence} is missing from electron/bin/licenses/. It has to ship ` +
                        'with the binaries — see docs/ffmpeg-licensing.md.'
                );
            }
            await copyFile(from, join(outDir, licence));
        }
        console.log(`  ✓ ${licences.join(', ')} (${spec.licence})`);

        /*
         * Shipped beside the binaries: a GPL build obliges the licence to travel
         * with what is distributed.
         *
         * Builder and licence version come from the target rather than from one
         * shared string, because they differ per build and a licence notice that
         * misstates either is worse than none. This text used to credit
         * osxexperts.net for BtbN's Windows build and claim v2-or-later for all
         * three, when only the arm64 build is v2 — the other two are configured
         * `--enable-version3`.
         *
         * The source line is honest about what it is: upstream's download page is
         * *not* the corresponding source for this build, which statically links
         * x264 and x265 and so obliges their source at these versions too. See
         * docs/ffmpeg-licensing.md — closing that gap is the mirroring work in
         * Todo item 40, and until it is done a public release is not compliant.
         */
        const isV3 = spec.licence.startsWith('GPL-3.0');
        await writeFile(
            join(outDir, 'LICENSE-ffmpeg.txt'),
            [
                `FFmpeg ${spec.version} (${target}), built by ${spec.builder}, distributed under`,
                `the GNU General Public License version ${isV3 ? '3' : '2'} or later, with libx264 and`,
                'libx265 statically linked.',
                '',
                'This application invokes ffmpeg as a separate process; it is not linked against',
                'the FFmpeg libraries. The application itself is licensed under Apache-2.0.',
                '',
                `Licence:        ${spec.licence}`,
                isV3
                    ? 'Licence text:   GPL-3.0.txt beside this file'
                    : 'Licence text:   GPL-2.0.txt beside this file (and GPL-3.0.txt, at your option)',
                'FFmpeg project: https://ffmpeg.org/download.html',
                '',
                'Corresponding source for this exact build is not yet published alongside it.',
                'Request it from the distributor; see docs/ffmpeg-licensing.md.',
                '',
            ].join('\n')
        );

        console.log(
            canRunTarget(target)
                ? `\n  All good — ${target} is ready to package.\n`
                : `\n  Fetched and pinned, but NOT verified: ${target} binaries cannot be run\n` +
                      `  here. They are packageable, and a release built from them has had its\n` +
                      `  hardware support taken on trust. Run this on ${target} to confirm.\n`
        );
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

await main();
