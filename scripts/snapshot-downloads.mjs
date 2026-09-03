#!/usr/bin/env node
/**
 * Append today's GitHub release-asset download counts to metrics/downloads.csv.
 *
 * Why this exists: the codec-unit exposure argument rests on staying under a
 * volume threshold, and an argument about volume needs a contemporaneous record
 * of volume. The CSV is committed, so git history timestamps each snapshot
 * independently of anything this script writes into the row.
 *
 * What a row means, and its known biases:
 *
 *   - A download approximates one machine, and **overcounts**: CI runners, bots,
 *     mirrors, reinstalls, and every existing user pulling each new version all
 *     add to it. That is the safe direction for this purpose, so the raw figure
 *     is recorded with no adjustment.
 *   - GitHub's `download_count` is cumulative per asset and never resets.
 *     Differencing two snapshots gives the interval; the raw number is a total.
 *   - Auto-generated source zipballs and tarballs carry no `download_count` and
 *     are not part of the release-asset list, so they are not counted.
 *   - An asset deleted from a release takes its history with it. The per-asset
 *     rows are kept so that shows up as an asset disappearing rather than as a
 *     total silently dropping.
 *
 * Usage:
 *     GITHUB_TOKEN=… node scripts/snapshot-downloads.mjs
 *     node scripts/snapshot-downloads.mjs --dry-run
 *
 * The token needs only public read access. Unauthenticated calls work but are
 * rate-limited; on a weekly job that is usually fine.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.METRICS_REPO ?? 'bccsa/luminary-media-convert';
const here = dirname(fileURLToPath(import.meta.url));
const csvPath = resolve(join(here, '..', 'metrics', 'downloads.csv'));
const dryRun = process.argv.includes('--dry-run');

const HEADER = 'snapshot_utc,release_tag,asset_name,download_count\n';

/** CSV needs quoting for anything containing a comma or a quote. */
const cell = (v) =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

async function releases() {
    const headers = {
        accept: 'application/vnd.github+json',
        'user-agent': 'luminary-media-convert-metrics',
    };
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;

    const out = [];
    // Paginate: a long-lived project accumulates more than one page of releases,
    // and a silently truncated list would undercount — the unsafe direction.
    for (let page = 1; page <= 20; page++) {
        const res = await fetch(
            `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
            { headers }
        );
        if (!res.ok) {
            throw new Error(
                `GitHub API ${res.status} ${res.statusText} — ${await res.text()}`
            );
        }
        const batch = await res.json();
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

const stamp = new Date().toISOString().slice(0, 10);
const all = await releases();

const rows = [];
let total = 0;
for (const release of all) {
    for (const asset of release.assets ?? []) {
        rows.push(
            [stamp, release.tag_name, asset.name, asset.download_count]
                .map(cell)
                .join(',')
        );
        total += asset.download_count;
    }
}

if (rows.length === 0) {
    // No releases yet, or none with assets. Still worth a row: "we looked on
    // this date and there was nothing" is part of the record, and its absence
    // would later look like a gap in monitoring rather than a gap in releases.
    rows.push([stamp, '', '', 0].map(cell).join(','));
}

console.log(`${REPO}: ${all.length} release(s), ${rows.length} row(s), ${total} downloads`);

if (dryRun) {
    console.log(HEADER.trim());
    for (const r of rows) console.log(r);
    process.exit(0);
}

mkdirSync(dirname(csvPath), { recursive: true });
if (!existsSync(csvPath)) writeFileSync(csvPath, HEADER);
appendFileSync(csvPath, rows.join('\n') + '\n');
console.log(`appended to ${csvPath}`);
