#!/usr/bin/env node
/**
 * Ask whether the sources our FFmpeg build depends on still exist.
 *
 * Building from source has its own supply chain — FFmpeg's release tarball and
 * signature, x264's git repository, libwebp's tarball, the NVENC headers — shorter
 * than downloading a binary, but not absent.
 *
 * A source that cannot be fetched means `dist:mac` and `dist:win` stop working for
 * everybody at once, and the corresponding-source offer in the shipped licence notice
 * points at something a recipient cannot fetch.
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
        what: `libwebp ${libwebpVersion}`,
        url: `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${libwebpVersion}.tar.gz`,
    },
];

/**
 * FFmpeg's tarball and signature are checked by reading the release index once,
 * instead of requesting each file.
 *
 * ffmpeg.org answers a request for a file that does not exist by resetting the
 * connection rather than returning 404, so a per-file request cannot tell "missing"
 * from "network trouble" — and repeating the request makes resets more likely, not
 * less. The index is a single request and gives a definite answer: the filename is
 * listed or it is not.
 */
const FFMPEG_INDEX = 'https://ffmpeg.org/releases/';

async function checkFfmpegRelease() {
    let index;
    for (let i = 1; i <= ATTEMPTS; i++) {
        try {
            const res = await fetch(FFMPEG_INDEX, { redirect: 'follow' });
            if (res.ok) {
                index = await res.text();
                break;
            }
        } catch {
            // Retry below; an unreachable index is inconclusive, not a verdict.
        }
        if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * i));
    }

    if (index === undefined) {
        console.log(
            `  ? release index unreachable  FFmpeg ${ffmpegVersion} source + signature`
        );
        inconclusive.push({
            what: `FFmpeg ${ffmpegVersion} source + signature`,
            url: FFMPEG_INDEX,
            status: 'release index could not be fetched',
        });
        return;
    }

    // The signature matters as much as the tarball: without it the build cannot
    // verify what it downloaded, which is the reason for building from source.
    for (const file of [
        `ffmpeg-${ffmpegVersion}.tar.xz`,
        `ffmpeg-${ffmpegVersion}.tar.xz.asc`,
    ]) {
        const listed = index.includes(file);
        console.log(
            `  ${listed ? '✓' : '✗'} ${listed ? 'listed' : 'NOT listed'} in the release index  ${file}`
        );
        if (!listed) {
            failures.push({
                what: file,
                url: FFMPEG_INDEX,
                status: 'not present in the release index',
            });
        }
    }
}

/**
 * Retried, because a single attempt is not evidence: these hosts drop connections
 * intermittently, and a transient error is not a missing source. A check that cries
 * wolf is one everybody learns to ignore, which is worse than not having it.
 */
const ATTEMPTS = 5;

/**
 * A network error and a 404 are different claims, and only one is evidence about the
 * pin.
 *
 * If the server answered — even to say "no such file" — that answer is the result. If
 * no attempt got as far as an answer, the check is *inconclusive*: it says so and does
 * not fail, because a reset connection tells us nothing about whether the source
 * exists, and failing on it turns unrelated pull requests red.
 */
const inconclusive = [];

async function attempt(url) {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (head.ok) return { ok: true, status: head.status, method: 'HEAD' };
    // Some hosts answer HEAD with 403/405 while serving GET perfectly well. Ask for
    // a single byte: cancelling a multi-megabyte body mid-flight throws, and would
    // look like a failed request.
    const ranged = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
    });
    await ranged.arrayBuffer();
    return { ok: ranged.ok, status: ranged.status, method: 'GET range' };
}

async function reachable(url) {
    let answered;
    let networkError;
    for (let i = 1; i <= ATTEMPTS; i++) {
        try {
            const result = await attempt(url);
            if (result.ok)
                return i === 1
                    ? result
                    : { ...result, method: `${result.method}, attempt ${i}` };
            // The server answered and said no. Retrying a 404 only wastes time.
            answered = result;
            break;
        } catch (e) {
            networkError = e.cause?.message ?? e.code ?? e.message;
        }
        if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * i));
    }
    if (answered) return answered;
    return {
        ok: false,
        unreachable: true,
        status: `${networkError} after ${ATTEMPTS} attempts`,
        method: 'no answer',
    };
}

/**
 * A git ref, which no HTTP request can confirm.
 *
 * `kind` matters. A tag is advertised by `ls-remote`, so silence means it does not
 * exist and the pin is wrong. A commit is not advertised, so silence says nothing —
 * for those the check can only establish that the repository answers at all.
 */
function gitRefExists(repo, ref, kind, expectCommit) {
    // Retried like the HTTP checks: a dropped connection to a git host is not a
    // missing ref.
    const lsRemote = (...args) => {
        let lastError;
        for (let i = 1; i <= ATTEMPTS; i++) {
            try {
                return execFileSync('git', ['ls-remote', repo, ...args], {
                    encoding: 'utf8',
                    timeout: 60_000,
                });
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError;
    };

    try {
        if (kind === 'tag') {
            // Both lines of an annotated tag: the tag object and the peeled commit
            // (the `^{}` suffix). The peeled SHA is what a checkout resolves to, so
            // that is what the commit pin must equal — an annotated tag has two
            // hashes, and pinning the wrong one fails every build.
            const out = lsRemote(`refs/tags/${ref}`, `refs/tags/${ref}^{}`);
            if (!out.trim())
                return {
                    ok: false,
                    note: 'tag does not exist in the repository',
                };
            if (expectCommit) {
                const peeled = out
                    .split('\n')
                    .find((l) => l.includes('^{}'))
                    ?.split('\t')[0];
                const resolved = peeled ?? out.split('\t')[0]; // lightweight tag: one line
                if (resolved !== expectCommit) {
                    return {
                        ok: false,
                        note: `tag resolves to ${resolved?.slice(0, 12)}, but the commit pin says ${expectCommit.slice(0, 12)}`,
                    };
                }
                return {
                    ok: true,
                    note: 'tag present and resolves to the pinned commit',
                };
            }
            return { ok: true, note: 'tag present' };
        }
        // A commit: confirm the repository responds, and report the commit as
        // unverifiable rather than implying it was found.
        lsRemote('HEAD');
        return {
            ok: true,
            note: 'repository reachable (a commit pin cannot be checked remotely)',
        };
    } catch (e) {
        // Reaching git failed, which says nothing about the ref.
        return { ok: false, unreachable: true, note: e.message.split('\n')[0] };
    }
}

const failures = [];
console.log('\n  Checking the sources ffmpeg-build/build.sh fetches\n');

await checkFfmpegRelease();

for (const t of httpTargets) {
    const { ok, status, method, unreachable } = await reachable(t.url);
    console.log(
        `  ${ok ? '✓' : unreachable ? '?' : '✗'} ${status} (${method})  ${t.what}`
    );
    if (unreachable) inconclusive.push({ what: t.what, url: t.url, status });
    else if (!ok) failures.push({ what: t.what, url: t.url, status });
    // Spaced out: two of these targets share a host that resets connections when hit
    // in quick succession.
    await new Promise((r) => setTimeout(r, 500));
}

for (const t of [
    {
        what: `x264 ${x264Commit.slice(0, 12)}`,
        repo: x264Repo,
        ref: x264Commit,
        kind: 'commit',
    },
    {
        what: `nv-codec-headers ${nvTag}`,
        repo: pin('NV_CODEC_HEADERS_REPO'),
        ref: nvTag,
        kind: 'tag',
        expectCommit: pin('NV_CODEC_HEADERS_COMMIT'),
    },
]) {
    const { ok, note, unreachable } = gitRefExists(
        t.repo,
        t.ref,
        t.kind,
        t.expectCommit
    );
    console.log(`  ${ok ? '✓' : unreachable ? '?' : '✗'} ${t.what} — ${note}`);
    if (unreachable)
        inconclusive.push({ what: t.what, url: t.repo, status: note });
    else if (!ok) failures.push({ what: t.what, url: t.repo, status: note });
}

if (inconclusive.length > 0) {
    const prefix = process.env.GITHUB_ACTIONS ? '::warning::' : '  ! ';
    for (const f of inconclusive) {
        console.error(
            `${prefix}${f.what} could not be reached (${f.status}) — not a verdict on the pin`
        );
    }
}

if (failures.length > 0) {
    console.error(
        `\n  ✗ ${failures.length} pinned source(s) are wrong or missing.\n`
    );
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

if (inconclusive.length > 0) {
    console.log(
        `\n  ${inconclusive.length} source(s) could not be reached; the rest are fine.` +
            '\n  Not failing: a dropped connection is not evidence that a pin is wrong.\n'
    );
} else {
    console.log('\n  All pinned sources are still reachable.\n');
}
