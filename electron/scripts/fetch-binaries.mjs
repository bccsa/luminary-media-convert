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
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
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
        files: [
            {
                name: 'ffmpeg',
                url: 'https://www.osxexperts.net/ffmpeg81arm.zip',
                sha256: 'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
            },
            {
                name: 'ffprobe',
                url: 'https://www.osxexperts.net/ffprobe81arm.zip',
                sha256: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
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
        arch: 'arm64',
        verify: {
            ffmpeg: {
                hwaccel: 'videotoolbox',
                encoders: ['h264_videotoolbox', 'libx264'],
                filters: ['scale_vt'],
            },
        },
    },
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
function verifyCapabilities(binary, name, arch, spec) {
    const run = (...args) =>
        execFileSync(binary, ['-hide_banner', ...args], { encoding: 'utf8' });

    const described = execFileSync('file', [binary], { encoding: 'utf8' });
    if (!described.includes(arch)) fail(`${name} is not ${arch}: ${described.trim()}`);

    // Runs at all, and is not quietly a shell script wrapping a system install.
    if (!run('-version').includes(`${name} version`)) {
        fail(`${name} did not identify itself as ${name}`);
    }

    if (!spec) return;

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
        for (const file of spec.files) {
            const dest = join(outDir, file.name);
            if (existsSync(dest)) {
                console.log(`  · ${file.name} already here, skipping`);
                continue;
            }

            console.log(`  ↓ ${file.url}`);
            const archive = await download(file.url);

            const actual = digest(archive);
            if (actual !== file.sha256) {
                fail(
                    `Digest mismatch for ${file.name}.\n    expected ${file.sha256}\n    got      ${actual}\n` +
                        '    This binary is distributed to users. Investigate before pinning the new digest.',
                );
            }

            const archivePath = join(staging, `${file.name}.zip`);
            await writeFile(archivePath, archive);
            execFileSync('unzip', ['-oq', archivePath, '-d', staging]);
            execFileSync('mv', [join(staging, file.name), dest]);
            await chmod(dest, 0o755);
            console.log(`  ✓ ${file.name}`);
        }

        for (const file of spec.files) {
            verifyCapabilities(
                join(outDir, file.name),
                file.name,
                spec.arch,
                spec.verify[file.name],
            );
            console.log(`  ✓ ${file.name} verified`);
        }

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
                'Licence text:   https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt',
                '                https://www.gnu.org/licenses/gpl-3.0.txt  (at your option)',
                'FFmpeg project: https://ffmpeg.org/download.html',
                '',
                'Corresponding source for this exact build is not yet published alongside it.',
                'Request it from the distributor; see docs/ffmpeg-licensing.md.',
                '',
            ].join('\n'),
        );

        console.log(`\n  All good — ${target} is ready to package.\n`);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

await main();
