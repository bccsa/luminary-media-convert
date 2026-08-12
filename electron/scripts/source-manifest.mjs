#!/usr/bin/env node
/**
 * Record what "corresponding source" means for the binaries we ship.
 *
 * The GPL obliges us to offer the source that rebuilds the binary we distribute.
 * For a statically linked GPL build that is wider than FFmpeg alone: x264 and
 * x265 are compiled *into* the executable, so their source at the exact revisions
 * used is part of the work being conveyed.
 *
 * Nothing in this repository recorded any of that, which made the obligation in
 * Todo 40 impossible to discharge without going back to each builder — and the
 * pinned URLs are already drifting (see check-pinned-urls.mjs). This writes the
 * facts down while they are still readable off the binaries.
 *
 *     npm -w electron run source-manifest
 *
 * Writes docs/ffmpeg-corresponding-source.md. Rerun it whenever a pin moves; the
 * output is committed so the record survives the download it describes.
 *
 * Honest about its limits. The FFmpeg version and the full configure line come
 * straight from the binary. x265 prints a git-describe string, so that is exact.
 * **x264 does not expose its revision in these builds at all** — neither the log,
 * the muxer metadata, nor the embedded strings carry it — so the manifest says so
 * rather than guessing, and names asking the builder as the way to close it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './ffmpeg-targets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const binRoot = join(here, '..', 'bin');

const UNKNOWN = '_not recoverable from the binary — ask the builder_';

/** Run the binary if this machine can; otherwise report nothing rather than guess. */
function tryRun(binary, args) {
    try {
        return execFileSync(binary, ['-hide_banner', ...args], {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        });
    } catch {
        return null;
    }
}

/**
 * Pull a string out of the executable's own bytes.
 *
 * Used only for the configure line and version banners, which ffmpeg stores as
 * literal strings and prints verbatim for `-buildconf` / `-L`. This is *not* a
 * way to ask what a build supports: encoder and filter *names* appear in tables
 * whether or not the feature was compiled in, which is exactly how a `strings`
 * check once "confirmed" NVENC in a build nobody had run.
 */
function scanBinary(path, pattern) {
    const text = readFileSync(path, 'latin1');
    const m = text.match(pattern);
    return m ? m[0] : null;
}

function configureLine(binary) {
    const run = tryRun(binary, ['-buildconf']);
    if (run) {
        return run
            .split('\n')
            .filter((l) => l.trim().startsWith('--'))
            .map((l) => l.trim())
            .join(' ');
    }
    // Cross-platform fallback: the line is embedded verbatim.
    const scanned = scanBinary(binary, /--prefix=[^\0]{0,4000}/);
    return scanned ? scanned.replace(/\s+/g, ' ').trim() : null;
}

const sections = [];

for (const [target, spec] of Object.entries(TARGETS)) {
    const exe = target.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg';
    const binary = join(binRoot, target, exe);
    if (!existsSync(binary)) {
        sections.push({ target, spec, missing: true });
        continue;
    }

    /*
     * `ffmpeg -version` prints "ffmpeg version <V>", but that sentence is
     * assembled at runtime — only <V> is a literal in the file. So the fallback
     * looks for the git-describe form a build carries (`n8.1.2-34-g9b6c8969e0`),
     * which is the precise thing the corresponding source has to match anyway.
     */
    const version =
        tryRun(binary, ['-version'])?.split('\n')[0] ??
        scanBinary(binary, /n\d+\.\d+(\.\d+)?-\d+-g[0-9a-f]{7,}(-\d{8})?/) ??
        scanBinary(binary, /ffmpeg version [^\0\n]{0,120}/);
    const licenceLine =
        tryRun(binary, ['-L'])?.match(/either version (\d)/)?.[0] ??
        scanBinary(binary, /either version \d of the License/);
    const configure = configureLine(binary);
    // x265 reports a git-describe string; x264 exposes nothing in these builds.
    const x265 = scanBinary(binary, /\d+\.\d+\+\d+-[0-9a-f]{7,}/);

    sections.push({ target, spec, version, licenceLine, configure, x265 });
}

const lines = [
    '# Corresponding source for the FFmpeg builds we ship',
    '',
    '**Generated — do not edit by hand.** Run `npm -w electron run source-manifest`',
    'after changing any pin in `electron/scripts/ffmpeg-targets.mjs`.',
    '',
    'The GPL requires us to offer the source that rebuilds the binary we distribute.',
    'x264 and x265 are **statically linked into** these executables, so their source at',
    "the revisions used is part of the work being conveyed — not just FFmpeg's.",
    'See [`ffmpeg-licensing.md`](ffmpeg-licensing.md) §5.',
    '',
    '> **This file records what to publish. It is not itself the offer, and publishing',
    '> has not happened yet** — until it does, distributing a build outside the',
    '> organisation is not compliant (Todo 40).',
    '',
];

for (const s of sections) {
    lines.push(`## ${s.target}`, '');
    if (s.missing) {
        lines.push(
            `_Not fetched on the machine that generated this file._ Run`,
            '`npm -w electron run fetch-binaries ' +
                s.target +
                '` and regenerate.',
            ''
        );
        continue;
    }
    lines.push(
        `- **Builder**: ${s.spec.builder}`,
        `- **Licence**: ${s.spec.licence} (binary reports: ${s.licenceLine ?? UNKNOWN})`,
        `- **FFmpeg**: ${s.version ?? UNKNOWN}`,
        `- **x265**: ${s.x265 ? `\`${s.x265}\` (git describe, as the encoder reports it)` : UNKNOWN}`,
        `- **x264**: ${UNKNOWN}`,
        '',
        '**Pinned downloads** (what the source must correspond to):',
        ''
    );
    for (const a of s.spec.archives) {
        lines.push(`- \`${a.url}\``, `  - sha256 \`${a.sha256}\``);
    }
    lines.push(
        '',
        '**Configure line**',
        '',
        '```',
        s.configure ?? UNKNOWN,
        '```',
        ''
    );
}

lines.push(
    '## What is still missing, and how to close it',
    '',
    "**x264's revision is not recoverable from any of these builds.** It is absent from",
    'the encoder log, from the muxer metadata, and from the embedded strings — unlike',
    'x265, which prints a git-describe string. So the exact x264 source cannot be',
    'identified from what we hold.',
    '',
    'Two ways forward:',
    '',
    '1. **Ask each builder.** BtbN publishes the build scripts behind their releases,',
    '   which pin the dependency revisions; osxexperts.net documents nothing, so it',
    '   would have to be a direct question.',
    '2. **Build FFmpeg ourselves**, which makes the corresponding source ours by',
    '   construction and removes the question — at the cost of maintaining three',
    '   builds and their security updates.',
    '',
    'Until one of those happens, the honest position is the one in the shipped notice:',
    'the corresponding source for these exact builds is not published.',
    ''
);

const out = join(repoRoot, 'docs', 'ffmpeg-corresponding-source.md');
await writeFile(out, lines.join('\n'));
console.log(`\n  Wrote ${out}\n`);
for (const s of sections) {
    console.log(
        `  ${s.target.padEnd(14)} ${s.missing ? 'not fetched' : (s.version ?? 'version unknown')}`
    );
}
console.log('');
