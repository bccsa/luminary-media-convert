#!/usr/bin/env node
/**
 * Ask whether the sources our FFmpeg build depends on still exist.
 *
 * We no longer download prebuilt binaries, so this no longer watches a
 * third-party build host. It watches what the build itself fetches — FFmpeg's
 * release tarball, x264's git repository, libwebp's release tarball — because a
 * build from source has its own supply chain, and it is only shorter, not absent.
 *
 * A vanished URL means `dist:mac` and `dist:win` stop working for everybody at
 * once, and the corresponding-source offer in the shipped licence notice points at
 * something a recipient can no longer fetch. A weekly check turns that from a
 * discovery during a release into a ticket with weeks of warning.
 *
 * Reachability only. Whether a newer FFmpeg exists is a judgement call: moving a
 * pin means re-verifying capabilities, re-checking the nv-codec-headers ceiling and
 * re-testing an encode, which is not something a scheduled job should start.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const versionsFile = join(here, '..', '..', 'ffmpeg-build', 'versions.sh');

/**
 * Read the pins out of versions.sh rather than repeating them here. A second copy
 * would drift, and a health check watching the wrong URLs is worse than none.
 */
const versions = readFileSync(versionsFile, 'utf8');
const pin = (name) => {
    const m = versions.match(new RegExp(`^${name}="([^"]*)"`, 'm'));
    if (!m) {
        console.error(`\n  ✗ ${name} not found in ffmpeg-build/versions.sh\n`);
        process.exit(1);
    }
    return m[1];
};

const ffmpegVersion = pin('FFMPEG_VERSION');
const libwebpVersion = pin('LIBWEBP_VERSION');
const x264Repo = pin('X264_REPO');
const x264Commit = pin('X264_COMMIT');
const nvTag = pin('NV_CODEC_HEADERS_TAG');

const httpTargets = [
    {
        what: `FFmpeg ${ffmpegVersion} source`,
        url: `https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.xz`,
    },
    {
        // Without this the build cannot verify the tarball, which is the whole
        // reason for building from source rather than downloading a binary.
        what: `FFmpeg ${ffmpegVersion} signature`,
        url: `https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.xz.asc`,
    },
    {
        what: `libwebp ${libwebpVersion}`,
        url: `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${libwebpVersion}.tar.gz`,
    },
];

/**
 * Retried, because a single attempt is not evidence. ffmpeg.org failed one run in
 * three during testing while `curl -I` succeeded every time — a transient network
 * error, reported by the first version of this script as "the pinned source is
 * gone". A weekly job that cries wolf is a weekly job everybody learns to ignore,
 * which is worse than not having one.
 */
const ATTEMPTS = 3;

async function attempt(url) {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (head.ok) return { ok: true, status: head.status, method: 'HEAD' };
    // Some hosts answer HEAD with 403/405 while serving GET perfectly well. Ask
    // for a single byte rather than cancelling a multi-megabyte body mid-flight,
    // which itself throws and looks like a failed request.
    const ranged = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
    });
    await ranged.arrayBuffer();
    return { ok: ranged.ok, status: ranged.status, method: 'GET range' };
}

async function reachable(url) {
    let last;
    for (let i = 1; i <= ATTEMPTS; i++) {
        try {
            const result = await attempt(url);
            if (result.ok)
                return i === 1
                    ? result
                    : { ...result, method: `${result.method}, attempt ${i}` };
            last = result;
        } catch (e) {
            last = {
                ok: false,
                status: e.cause?.message ?? e.code ?? e.message,
                method: 'error',
            };
        }
        if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * i));
    }
    return { ...last, status: `${last.status} after ${ATTEMPTS} attempts` };
}

/** A git commit or tag, which no HTTP request can confirm. */
function gitRefExists(repo, ref) {
    try {
        // `ls-remote <repo> <ref>` prints a line when the ref exists. A commit that
        // is not a ref prints nothing, so fall back to asking for everything and
        // grepping — enough to tell "the repository is gone" from "the pin moved".
        const out = execFileSync('git', ['ls-remote', repo, ref], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        if (out.trim()) return { ok: true, note: 'ref present' };
        const all = execFileSync('git', ['ls-remote', repo], {
            encoding: 'utf8',
            timeout: 60_000,
        });
        return all.includes(ref)
            ? { ok: true, note: 'commit present' }
            : {
                  ok: true,
                  note: 'repository reachable; commit not advertised as a ref (normal)',
              };
    } catch (e) {
        return { ok: false, note: e.message.split('\n')[0] };
    }
}

const failures = [];
console.log('\n  Checking the sources ffmpeg-build/build.sh fetches\n');

for (const t of httpTargets) {
    const { ok, status, method } = await reachable(t.url);
    console.log(`  ${ok ? '✓' : '✗'} ${status} (${method})  ${t.what}`);
    if (!ok) failures.push({ what: t.what, url: t.url, status });
}

for (const t of [
    {
        what: `x264 ${x264Commit.slice(0, 12)}`,
        repo: x264Repo,
        ref: x264Commit,
    },
    {
        what: `nv-codec-headers ${nvTag}`,
        repo: 'https://github.com/FFmpeg/nv-codec-headers.git',
        ref: nvTag,
    },
]) {
    const { ok, note } = gitRefExists(t.repo, t.ref);
    console.log(`  ${ok ? '✓' : '✗'} ${t.what} — ${note}`);
    if (!ok) failures.push({ what: t.what, url: t.repo, status: note });
}

if (failures.length > 0) {
    console.error(`\n  ✗ ${failures.length} pinned source(s) unreachable.\n`);
    for (const f of failures)
        console.error(`      ${f.what}  ${f.status}\n        ${f.url}`);
    console.error(
        '\n    Re-pinning is not mechanical: record the new digest, check the licence\n' +
            '    with `ffmpeg -L` and `-buildconf` (it can differ between releases), confirm\n' +
            '    the nv-codec-headers tag still matches nvenc.c, and run an encode.\n' +
            '    See ffmpeg-build/README.md.\n'
    );
    process.exit(1);
}

console.log('\n  All pinned sources are still reachable.\n');
