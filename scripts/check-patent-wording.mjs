#!/usr/bin/env node
/**
 * Refuse to ship a claim that H.264 is free to use.
 *
 * The distributor risk that actually attaches to this project is induced
 * infringement, and inducement turns on what we *say* rather than on what we
 * ship. Telling users no licence is needed is the one thing that converts a
 * defensible position into an argument we encouraged them into it — which is
 * why the licensing policy makes this a hard rule rather than a preference.
 *
 * It was a rule nobody could break by accident only because nobody had written
 * the sentence yet. This is the check, so it stays that way: one reassuring
 * line in a README a year from now would otherwise undo the position with
 * nobody noticing.
 *
 *     node scripts/check-patent-wording.mjs
 *
 * Deliberate exceptions — AV1 genuinely is royalty-free, and a licence text is
 * not ours to edit — are allowed by putting `patent-wording-ok` in a comment on
 * the same line. Exceptions have to be argued for one line at a time, which is
 * the point.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Assembled rather than written out, so this file does not trip its own check
 * when it scans the repository it lives in.
 */
const FREE = String.raw`(?:royalty|licen[sc]e|patent)`;
const PATTERNS = [
    new RegExp(String.raw`${FREE}[-\s]free`, 'i'),
    new RegExp(String.raw`free\s+of\s+(?:royalt|licen[sc]e|patent)`, 'i'),
    new RegExp(
        String.raw`no\s+licen[sc](?:e|ing)\s+(?:is\s+)?(?:required|needed)`,
        'i'
    ),
    new RegExp(
        String.raw`no\s+(?:royalt\w+|patent\w*)\s+(?:are\s+|is\s+)?(?:required|payable|owed|due)`,
        'i'
    ),
    // The same claim with the words the other way round — "requires no licence"
    // rather than "no licence required". Missed on the first pass, which is why
    // this checker was tested against a planted violation rather than trusted.
    new RegExp(
        String.raw`(?:require|need)s?\s+no\s+(?:licen[sc]e|royalt\w*|patent\w*)`,
        'i'
    ),
    new RegExp(
        String.raw`without\s+(?:a\s+|any\s+)?(?:licen[sc]e|royalt\w*|patent\s+licen[sc]e)`,
        'i'
    ),
];

const SCANNED_EXTENSIONS = new Set([
    '.md',
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.vue',
    '.html',
    '.json',
    '.yml',
    '.yaml',
]);

const SKIP_DIRECTORIES = new Set([
    'node_modules',
    '.git',
    'dist',
    'release',
    'coverage',
    'work',
    'test-media',
    '.work',
    'bin',
]);

/**
 * Files whose text is not ours to write. Licence texts say "royalty-free" in
 * the FSF's own words, and the private policy documents quote the rule in order
 * to state it.
 */
const SKIP_FILES = [
    /(^|\/)(LICENSE|LICENCE|COPYING)[^/]*$/i,
    /(^|\/)luminary-media-convert-(licensing|legal-memo)\.md$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)check-patent-wording\.mjs$/,
];

const ALLOW_MARKER = 'patent-wording-ok';

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry) || entry.startsWith('.')) continue;
            yield* walk(full);
        } else {
            yield full;
        }
    }
}

const hits = [];
let scanned = 0;

for (const file of walk(root)) {
    const rel = relative(root, file);
    if (!SCANNED_EXTENSIONS.has(extname(file))) continue;
    if (SKIP_FILES.some((re) => re.test(rel))) continue;

    scanned++;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.includes(ALLOW_MARKER)) return;
        const pattern = PATTERNS.find((p) => p.test(line));
        if (pattern) {
            hits.push({ rel, line: i + 1, text: line.trim().slice(0, 110) });
        }
    });
}

if (hits.length === 0) {
    console.log(`  ✓ no patent-freedom claims in ${scanned} files`);
    process.exit(0);
}

console.error(
    `\n  ✗ ${hits.length} claim(s) that something is free of patent or licence obligations:\n`
);
for (const hit of hits) {
    console.error(`      ${hit.rel}:${hit.line}`);
    console.error(`        ${hit.text}\n`);
}
console.error(
    '  We do not state that H.264 is free to use or that no licensing is required.\n' +
        '  Inducement turns on what we say, so this is a hard rule — see PATENTS.md.\n' +
        `  A statement that is genuinely true (AV1, for one) is allowed by putting\n` +
        `  ${ALLOW_MARKER} in a comment on that line.\n`
);
process.exit(1);
