#!/usr/bin/env node
/**
 * Ask whether every pinned FFmpeg download still exists.
 *
 * Pinning by digest protects against a download *changing*. It says nothing about
 * a download *disappearing*, and both of our sources can do that: the macOS
 * arm64 build we pin is no longer linked from osxexperts.net (the site has moved
 * on to ffmpeg9arm.zip), and BtbN's Windows build is a dated autobuild release of
 * the kind that rotates.
 *
 * When one goes, `dist:mac` or `dist:win` stops working for everybody at once,
 * and the corresponding-source obligation in Todo 40 gets harder to discharge
 * because the build we would have to publish source for is no longer available to
 * inspect. A weekly check turns that from a discovery during a release into a
 * ticket with weeks of warning.
 *
 * Reachability only. Whether a newer build exists is a judgement call: moving a
 * pin means re-verifying capabilities and re-testing an encode, which is not
 * something a scheduled job should decide to start.
 */
import { TARGETS } from './ffmpeg-targets.mjs';

/**
 * HEAD first, because these are 26-160 MB files and we only want the status.
 * Some hosts answer HEAD with 403 or 405 while serving GET perfectly well, so
 * fall back to a GET whose body is dropped as soon as the status is known.
 */
async function reachable(url) {
    try {
        const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        if (head.ok) return { ok: true, status: head.status, method: 'HEAD' };
        const get = await fetch(url, { method: 'GET', redirect: 'follow' });
        // Release the connection without reading 160 MB of body.
        await get.body?.cancel();
        return { ok: get.ok, status: get.status, method: 'GET' };
    } catch (e) {
        return { ok: false, status: e.code ?? e.message, method: 'error' };
    }
}

const failures = [];
console.log('\n  Checking pinned FFmpeg downloads\n');

for (const [target, spec] of Object.entries(TARGETS)) {
    for (const archive of spec.archives) {
        const { ok, status, method } = await reachable(archive.url);
        const name = archive.url.split('/').pop();
        console.log(
            `  ${ok ? '✓' : '✗'} ${target}  ${status} (${method})  ${name}`
        );
        if (!ok) failures.push({ target, url: archive.url, status });
    }
}

if (failures.length > 0) {
    console.error(
        `\n  ✗ ${failures.length} pinned download(s) are gone. A build from a clean\n` +
            '    checkout cannot succeed until each is re-pinned.\n'
    );
    for (const f of failures)
        console.error(`      ${f.target}  ${f.status}  ${f.url}`);
    console.error(
        '\n    Re-pinning is not mechanical: fetch the replacement, record its digest,\n' +
            '    confirm the capabilities in its TARGETS entry, check the licence with\n' +
            '    `ffmpeg -L` and `-buildconf` (it may differ from the build it replaces),\n' +
            '    and run an encode. See electron/bin/README.md.\n'
    );
    process.exit(1);
}

console.log('\n  All pinned downloads are still reachable.\n');
