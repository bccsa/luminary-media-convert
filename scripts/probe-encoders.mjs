#!/usr/bin/env node
/**
 * Ask this machine's ffmpeg which H.264 encoders actually work.
 *
 * Compiling an encoder in is not the same as one that runs. NVENC needs a
 * driver and has a concurrent-session cap; Quick Sync needs an Intel iGPU that
 * is enabled in firmware; AMF needs a Radeon driver; and Media Foundation is
 * always present but reportedly will not encode much above 1080p. None of that
 * shows up in `-encoders`, which lists what was compiled rather than what will
 * open.
 *
 * So each encoder is asked to encode a real frame, at 720p and again at 2160p —
 * the second is what finds a resolution ceiling.
 *
 *     node scripts/probe-encoders.mjs                     # the bundled ffmpeg
 *     node scripts/probe-encoders.mjs C:\\path\\to\\ffmpeg.exe
 *
 * The frame is fed as rawvideo on stdin rather than generated with
 * `-f lavfi -i testsrc`: this build passes --disable-indevs, so lavfi is not in
 * it and testsrc fails with "Error opening input file", which looks like a
 * broken encoder and is not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const exe = platform() === 'win32' ? '.exe' : '';

function findFfmpeg() {
    if (process.argv[2]) return resolve(process.argv[2]);
    const targets =
        platform() === 'win32'
            ? ['win32-x64']
            : [`darwin-${process.arch}`, 'darwin-arm64', 'darwin-x64'];
    for (const t of targets) {
        const candidate = join(
            here,
            '..',
            'app-electron',
            'bin',
            t,
            `ffmpeg${exe}`
        );
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

const ffmpeg = findFfmpeg();
if (!ffmpeg || !existsSync(ffmpeg)) {
    console.error(
        '  Could not find ffmpeg. Pass its path:\n' +
            '      node scripts/probe-encoders.mjs <path to ffmpeg>'
    );
    process.exit(2);
}

/** Which encoders to try, and what each one tells us. */
const CANDIDATES = [
    ['h264_videotoolbox', 'macOS — the only path there, software-backed'],
    ['h264_nvenc', 'NVIDIA'],
    ['h264_qsv', 'Intel Quick Sync'],
    ['h264_amf', 'AMD Radeon'],
    ['h264_mf', 'Windows Media Foundation — the last resort'],
    ['libx264', 'software (should be ABSENT from an LGPL build)'],
];

const SIZES = [
    [1280, 720, '720p'],
    [3840, 2160, '4K'],
];

function compiledIn() {
    const out =
        spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
            encoding: 'utf8',
        }).stdout ?? '';
    return new Set(
        CANDIDATES.map(([name]) => name).filter((n) =>
            new RegExp(`\\b${n}\\b`).test(out)
        )
    );
}

/** One real frame, encoded. Grey rather than noise so it compresses sanely. */
function tryEncode(encoder, width, height) {
    const frame = Buffer.alloc((width * height * 3) / 2, 0x80);
    const res = spawnSync(
        ffmpeg,
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'yuv420p',
            '-s',
            `${width}x${height}`,
            '-r',
            '25',
            '-i',
            'pipe:0',
            '-frames:v',
            '1',
            '-c:v',
            encoder,
            ...(encoder === 'h264_videotoolbox' ? ['-allow_sw', '1'] : []),
            '-f',
            'null',
            '-',
        ],
        { input: frame, encoding: 'utf8', timeout: 60_000 }
    );
    const err = (res.stderr || '').trim().split('\n').filter(Boolean).pop();
    return { ok: res.status === 0, err };
}

console.log(`\n  ffmpeg: ${ffmpeg}`);

// Establish the binary runs here at all, before believing anything it does not
// say. Without this the probe cannot tell "this encoder is absent" from "no
// process ever started": a win32 binary on macOS answers nothing, and every
// check reads as a negative — 0 encoders, and a licence reported as GPL purely
// because the banner was empty. A confident wrong answer is worse than none.
const version = spawnSync(ffmpeg, ['-hide_banner', '-version'], {
    encoding: 'utf8',
});
if (version.status !== 0 || !/ffmpeg version/.test(version.stdout ?? '')) {
    console.error(
        '\n  This ffmpeg cannot be executed here, so nothing below could be\n' +
            '  tested. A win32-x64 build has to be probed on Windows, and a\n' +
            '  macOS build on a Mac.\n' +
            (version.error ? `\n  ${version.error.message}\n` : '\n')
    );
    process.exit(2);
}

const banner =
    spawnSync(ffmpeg, ['-hide_banner', '-L'], { encoding: 'utf8' }).stdout ??
    '';
console.log(`  licence: ${banner.includes('Lesser') ? 'LGPL' : 'GPL'}\n`);

const present = compiledIn();
let usable = 0;

for (const [encoder, note] of CANDIDATES) {
    if (!present.has(encoder)) {
        const expected = encoder === 'libx264' ? '  (correct for LGPL)' : '';
        console.log(`  ${encoder.padEnd(20)} not compiled in${expected}`);
        continue;
    }
    const results = SIZES.map(([w, h, label]) => {
        const { ok, err } = tryEncode(encoder, w, h);
        return { label, ok, err };
    });
    const worked = results.filter((r) => r.ok).map((r) => r.label);
    if (worked.length) usable++;

    const summary = worked.length
        ? `WORKS at ${worked.join(', ')}`
        : 'compiled in but WILL NOT OPEN';
    console.log(`  ${encoder.padEnd(20)} ${summary}   — ${note}`);
    for (const r of results.filter((r) => !r.ok)) {
        console.log(
            `  ${' '.repeat(20)}   ${r.label} failed: ${r.err ?? 'no message'}`
        );
    }
}

console.log(
    `\n  ${usable} usable encoder(s) on this machine.` +
        (usable === 0
            ? '\n  This machine cannot encode with this ffmpeg.\n'
            : '\n')
);
process.exit(usable === 0 ? 1 : 0);
