import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/check-pinned-urls.mjs asks whether the sources the FFmpeg build fetches
 * still exist. It is run here as it is, with the network and git replaced: a
 * preload swaps `fetch` for answers the test chooses and skips the retry waits,
 * and a fake `git` on PATH answers `ls-remote`.
 *
 * What it must keep doing: fail when a source answers that it is gone, never fail
 * on a dropped connection, and compare an annotated tag by the commit it points to.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'check-pinned-urls.mjs');

// The pins in ffmpeg-build/versions.sh, which the script reads.
const FFMPEG = 'ffmpeg-8.1.tar.xz';
const NV = {
    repo: 'nv-codec-headers',
    tag: 'n13.0.19.1',
    commit: '88fee5c37318c991a8762d423530f91681e32e3a',
};
const VPL = {
    repo: 'libvpl',
    tag: 'v2.17.0',
    commit: 'd77f9195cf495b937631607333288fd917ae8939',
};

/** One answer to a request: an HTTP status, or a connection reset. */
type Answer = { status: number; body?: string } | 'reset';

const PRELOAD = `
const rules = JSON.parse(process.env.FAKE_NET);
const calls = {};
globalThis.fetch = async (url, init = {}) => {
    const key = Object.keys(rules).find((k) => url.includes(k));
    if (!key) throw new Error('unexpected request: ' + url);
    const method = init.method ?? 'GET';
    const list = rules[key][method] ?? rules[key].ANY;
    const n = (calls[key + method] = (calls[key + method] ?? 0) + 1);
    const answer = list[Math.min(n, list.length) - 1];
    if (answer === 'reset') throw new TypeError('fetch failed', { cause: { message: 'ECONNRESET' } });
    return new Response(answer.body ?? '', { status: answer.status });
};
const setTimeoutReal = globalThis.setTimeout;
globalThis.setTimeout = (fn) => setTimeoutReal(fn, 0);
`;

const FAKE_GIT = `#!/usr/bin/env node
const repos = JSON.parse(process.env.FAKE_GIT);
const [, , cmd, repo, ...refs] = process.argv;
const key = Object.keys(repos).find((k) => repo.includes(k));
const r = repos[key];
if (cmd !== 'ls-remote' || !r || r.down) { console.error('fatal: unable to access'); process.exit(128); }
if (refs[0] === 'HEAD') { console.log('0000000000000000000000000000000000000000\\tHEAD'); process.exit(0); }
const tag = refs[0].replace('refs/tags/', '');
const t = r.tags[tag];
if (!t) process.exit(0);
console.log(t.object + '\\trefs/tags/' + tag);
if (t.peeled) console.log(t.peeled + '\\trefs/tags/' + tag + '^{}');
`;

describe('the pinned sources check (check-pinned-urls.mjs)', () => {
    let dir: string;
    let preload: string;
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'lmc-pins-'));
        preload = join(dir, 'fake-net.mjs');
        writeFileSync(preload, PRELOAD);
        writeFileSync(join(dir, 'git'), FAKE_GIT);
        chmodSync(join(dir, 'git'), 0o755);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const index = (files = [FFMPEG, `${FFMPEG}.asc`]) => ({
        ANY: [
            {
                status: 200,
                body: files.map((f) => `<a href="${f}">${f}</a>`).join('\n'),
            },
        ],
    });
    const webp = (head: Answer[], get: Answer[] = [{ status: 404 }]) => ({
        HEAD: head,
        GET: get,
    });
    // Annotated tags: the tag object, and the commit it points to.
    const repos = (over: Record<string, unknown> = {}) => ({
        [NV.repo]: {
            tags: { [NV.tag]: { object: 'a'.repeat(40), peeled: NV.commit } },
        },
        [VPL.repo]: {
            tags: { [VPL.tag]: { object: 'b'.repeat(40), peeled: VPL.commit } },
        },
        ...over,
    });

    function check(
        net: Record<string, unknown>,
        git: Record<string, unknown>,
        env = {}
    ) {
        const run = spawnSync(
            process.execPath,
            ['--import', pathToFileURL(preload).href, SCRIPT],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_ACTIONS: '',
                    ...env,
                    PATH: [
                        dir,
                        dirname(process.execPath),
                        process.env.PATH,
                    ].join(delimiter),
                    FAKE_NET: JSON.stringify(net),
                    FAKE_GIT: JSON.stringify(git),
                },
            }
        );
        return { code: run.status, out: `${run.stdout}${run.stderr}` };
    }

    const allGood = () => ({
        'ffmpeg.org/releases/': index(),
        'libwebp-1.6.0.tar.gz': webp([{ status: 200 }]),
    });

    it('passes when every source is there', () => {
        const { code, out } = check(allGood(), repos());

        expect(out).toContain('All pinned sources are still reachable');
        expect(code).toBe(0);
    });

    it.each([FFMPEG, `${FFMPEG}.asc`])(
        'fails when the release index no longer lists %s',
        (file) => {
            const net = {
                ...allGood(),
                'ffmpeg.org/releases/': index(
                    [FFMPEG, `${FFMPEG}.asc`].filter((f) => f !== file)
                ),
            };

            const { code, out } = check(net, repos());

            expect(out).toContain(`NOT listed in the release index  ${file}`);
            expect(code).toBe(1);
        }
    );

    it('fails when the libwebp tarball answers 404', () => {
        const net = {
            ...allGood(),
            'libwebp-1.6.0.tar.gz': webp([{ status: 404 }]),
        };

        const { code, out } = check(net, repos());

        expect(out).toMatch(/✗ 404 \(GET range\)\s+libwebp 1\.6\.0/);
        expect(code).toBe(1);
    });

    it('asks for one byte when the host refuses HEAD', () => {
        const net = {
            ...allGood(),
            'libwebp-1.6.0.tar.gz': webp([{ status: 405 }], [{ status: 206 }]),
        };

        const { code, out } = check(net, repos());

        expect(out).toMatch(/✓ 206 \(GET range\)\s+libwebp/);
        expect(code).toBe(0);
    });

    it('retries a dropped connection and passes when an attempt gets through', () => {
        const net = {
            ...allGood(),
            'libwebp-1.6.0.tar.gz': webp(['reset', 'reset', { status: 200 }]),
        };

        const { code, out } = check(net, repos());

        expect(out).toContain('(HEAD, attempt 3)');
        expect(code).toBe(0);
    });

    it('warns but does not fail when a source never answers', () => {
        const net = {
            'ffmpeg.org/releases/': { ANY: ['reset'] },
            'libwebp-1.6.0.tar.gz': webp(['reset']),
        };

        const { code, out } = check(net, repos({ [NV.repo]: { down: true } }));

        expect(out).toContain(
            'libwebp 1.6.0 could not be reached (ECONNRESET after 5 attempts)'
        );
        expect(out).toContain('release index unreachable');
        expect(out).toContain(
            `nv-codec-headers ${NV.tag} could not be reached`
        );
        expect(out).toContain(
            '3 source(s) could not be reached; the rest are fine'
        );
        expect(code).toBe(0);
    });

    it('flags an unreachable source as a GitHub warning in CI', () => {
        const net = { ...allGood(), 'libwebp-1.6.0.tar.gz': webp(['reset']) };

        const { out } = check(net, repos(), { GITHUB_ACTIONS: 'true' });

        expect(out).toContain('::warning::libwebp 1.6.0 could not be reached');
    });

    it('fails when a pinned tag is gone', () => {
        const { code, out } = check(
            allGood(),
            repos({ [VPL.repo]: { tags: {} } })
        );

        expect(out).toContain(
            `libvpl ${VPL.tag} — tag does not exist in the repository`
        );
        expect(code).toBe(1);
    });

    it('fails when a tag no longer points at the pinned commit', () => {
        const moved = {
            [VPL.tag]: { object: 'b'.repeat(40), peeled: 'c'.repeat(40) },
        };

        const { code, out } = check(
            allGood(),
            repos({ [VPL.repo]: { tags: moved } })
        );

        expect(out).toContain(
            `tag resolves to ${'c'.repeat(12)}, but the commit pin says ${VPL.commit.slice(0, 12)}`
        );
        expect(code).toBe(1);
    });

    it('compares an annotated tag by its commit, not the tag object', () => {
        // The tag object's own hash is never the commit; matching it would fail every build.
        const { code, out } = check(allGood(), repos());

        expect(out).toContain(
            `nv-codec-headers ${NV.tag} — tag present and resolves to the pinned commit`
        );
        expect(code).toBe(0);
    });

    it('accepts a lightweight tag, which has only the commit', () => {
        const light = { [NV.tag]: { object: NV.commit } };

        const { code } = check(
            allGood(),
            repos({ [NV.repo]: { tags: light } })
        );

        expect(code).toBe(0);
    });
});
