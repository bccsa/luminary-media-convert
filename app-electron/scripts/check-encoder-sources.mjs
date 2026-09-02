/**
 * Refuses to package an encoder that is not an LGPL build, before anything is
 * packaged.
 *
 * `verify-package.mjs` already asserts this, but only on the artefact — after
 * electron-builder has spent minutes producing an installer that then cannot
 * ship. The inputs are knowable in seconds: `build.sh` writes BUILDCONF.txt
 * beside each binary, recording exactly what it configured.
 *
 * `bin/<target>/` is not tracked, so what sits there is whatever the last build
 * left. A target built before the LGPL switch, or never rebuilt since, is
 * indistinguishable from a current one until something reads it.
 *
 * Usage: check-encoder-sources.mjs darwin-arm64 darwin-x64
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');

/** Mirrors verify-package.mjs — the same policy, asserted earlier. */
const FORBIDDEN_FLAGS = /--enable-(?:gpl|nonfree|version3)\b/g;

const targets = process.argv.slice(2);
if (!targets.length) {
    console.error('Usage: check-encoder-sources.mjs <target> [target...]');
    process.exit(2);
}

const problems = [];

for (const target of targets) {
    const dir = join(BIN, target);

    if (!existsSync(dir)) {
        problems.push(
            `${target}: not built — run \`ffmpeg-build/build.sh ${target}\``
        );
        continue;
    }

    const conf = join(dir, 'BUILDCONF.txt');
    if (!existsSync(conf)) {
        // Written by every build.sh run, so its absence means these binaries
        // predate the LGPL switch rather than that something went wrong.
        problems.push(
            `${target}: no BUILDCONF.txt, so these binaries predate the LGPL build — ` +
                `rebuild with \`ffmpeg-build/build.sh ${target}\``
        );
        continue;
    }

    const flags = [
        ...new Set(readFileSync(conf, 'utf8').match(FORBIDDEN_FLAGS) ?? []),
    ];
    if (flags.length) {
        problems.push(
            `${target}: configured with ${flags.join(', ')} — the licensing policy ` +
                `requires an LGPL build. Rebuild with \`ffmpeg-build/build.sh ${target}\``
        );
        continue;
    }

    // A GPL text here would travel with an LGPL binary and misdescribe it.
    const strays = readdirSync(dir).filter((f) => /^GPL-.*\.txt$/.test(f));
    if (strays.length) {
        problems.push(
            `${target}: ${strays.join(', ')} left from an earlier build — rebuild with ` +
                `\`ffmpeg-build/build.sh ${target}\``
        );
        continue;
    }

    console.log(`  ✓ ${target}: LGPL build, no forbidden flags`);
}

if (problems.length) {
    console.error(`\n  ✗ ${problems.length} problem(s), nothing packaged:\n`);
    for (const p of problems) console.error(`      - ${p}`);
    console.error('');
    process.exit(1);
}
