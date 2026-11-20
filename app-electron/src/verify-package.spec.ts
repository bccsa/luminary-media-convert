import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/verify-package.mjs is the gate a release passes before it ships: the
 * encoder present and real, and every licence notice beside it. It is run here
 * as it runs after packaging, over release directories built in a temp folder.
 *
 * Only Windows and Linux layouts are used: no host running these tests executes
 * those binaries, so the script checks them as files and the results are the
 * same on every machine.
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'verify-package.mjs');

/** A Windows executable header for the given COFF machine, padded past the size floor. */
function pe(machine: number): Buffer {
    const file = Buffer.alloc(1_100_000);
    file.writeUInt16LE(0x5a4d, 0); // 'MZ'
    file.writeUInt32LE(0x80, 0x3c); // e_lfanew
    file.write('PE\0\0', 0x80, 'ascii');
    file.writeUInt16LE(machine, 0x84);
    return file;
}
const X64 = 0x8664;
const ARM64 = 0xaa64;

const LGPL_BUILDCONF =
    '--enable-shared --disable-programs-docs --enable-libwebp';

type App = {
    exe: string;
    binaries: Record<string, Buffer>;
    files: Record<string, string>;
};

function completeWindowsApp(): App {
    return {
        exe: '.exe',
        binaries: { 'ffmpeg.exe': pe(X64), 'ffprobe.exe': pe(X64) },
        files: {
            'BUILDCONF.txt': LGPL_BUILDCONF,
            'LICENSE-ffmpeg.txt': 'FFmpeg notice',
            'LICENSE-libwebp.txt': 'libwebp notice',
            'LICENSE-libvpl.txt': 'libvpl notice',
            'LICENSE-electron.txt': 'Electron notice',
            'LICENSES-chromium.html': '<html>Chromium</html>',
            'COPYING.LGPLv2.1': 'GNU LESSER GENERAL PUBLIC LICENSE',
            'app/index.html': '<!doctype html>',
        },
    };
}

describe('the packaging gate (verify-package.mjs)', () => {
    let release: string;
    beforeEach(() => {
        release = mkdtempSync(join(tmpdir(), 'lmc-release-'));
    });
    afterEach(() => rmSync(release, { recursive: true, force: true }));

    function pack(dirName: string, app: App, drop: string[] = []) {
        const res = join(release, dirName, 'resources');
        mkdirSync(join(res, 'app'), { recursive: true });
        for (const [name, bytes] of Object.entries(app.binaries))
            if (!drop.includes(name)) writeFileSync(join(res, name), bytes);
        for (const [name, text] of Object.entries(app.files))
            if (!drop.includes(name)) writeFileSync(join(res, name), text);
    }

    function verify(dir = release) {
        const run = spawnSync(process.execPath, [SCRIPT, dir], {
            encoding: 'utf8',
        });
        return { code: run.status, out: `${run.stdout}${run.stderr}` };
    }

    it('passes a complete Windows app', () => {
        pack('win-unpacked', completeWindowsApp());

        const { code, out } = verify();

        expect(out).toContain(
            'All 1 packaged app(s) carry their encoder and its licence'
        );
        expect(code).toBe(0);
    });

    it.each([
        ['ffmpeg.exe', 'ffmpeg.exe is NOT in the packaged app'],
        ['ffprobe.exe', 'ffprobe.exe is NOT in the packaged app'],
        ['LICENSE-ffmpeg.txt', 'LICENSE-ffmpeg.txt is missing'],
        ['LICENSE-libwebp.txt', 'LICENSE-libwebp.txt is missing'],
        ['LICENSE-libvpl.txt', 'LICENSE-libvpl.txt is missing'],
        ['LICENSE-electron.txt', 'LICENSE-electron.txt is missing'],
        ['LICENSES-chromium.html', 'LICENSES-chromium.html is missing'],
        ['COPYING.LGPLv2.1', 'no licence text shipped for ffmpeg'],
        ['BUILDCONF.txt', 'BUILDCONF.txt is missing'],
        ['app/index.html', 'the web client (app/index.html) is missing'],
    ])('fails the release when %s is left out', (file, message) => {
        pack('win-unpacked', completeWindowsApp(), [file]);

        const { code, out } = verify();

        expect(out).toContain(`win-unpacked: ${message}`);
        expect(code).toBe(1);
    });

    it('accepts an older GPL text in place of the LGPL one', () => {
        const app = completeWindowsApp();
        delete app.files['COPYING.LGPLv2.1'];
        app.files['GPL-3.0.txt'] = 'GNU GENERAL PUBLIC LICENSE';
        pack('win-unpacked', app);

        expect(verify().code).toBe(0);
    });

    it.each(['--enable-gpl', '--enable-nonfree', '--enable-version3'])(
        'fails an encoder configured with %s',
        (flag) => {
            const app = completeWindowsApp();
            app.files['BUILDCONF.txt'] = `${LGPL_BUILDCONF} ${flag}`;
            pack('win-unpacked', app);

            const { code, out } = verify();

            expect(out).toContain(`ffmpeg is configured with ${flag}`);
            expect(code).toBe(1);
        }
    );

    it('does not mistake a longer flag that starts with --enable-gpl for it', () => {
        const app = completeWindowsApp();
        app.files['BUILDCONF.txt'] =
            `${LGPL_BUILDCONF} --enable-gpl3-compatible-docs`;
        pack('win-unpacked', app);

        expect(verify().out).not.toContain('ffmpeg is configured with');
    });

    it('fails a binary too small to be a real encoder', () => {
        const app = completeWindowsApp();
        app.binaries['ffmpeg.exe'] = Buffer.from('#!/bin/sh\necho ffmpeg\n');
        pack('win-unpacked', app);

        const { code, out } = verify();

        expect(out).toMatch(
            /win-unpacked: ffmpeg\.exe is only \d+ bytes — not a real binary/
        );
        expect(code).toBe(1);
    });

    it('fails an encoder built for the wrong processor', () => {
        const app = completeWindowsApp();
        app.binaries['ffmpeg.exe'] = pe(ARM64);
        pack('win-unpacked', app);

        const { code, out } = verify();

        expect(out).toContain(
            'win-unpacked: ffmpeg.exe is arm64, but this app is x64'
        );
        expect(code).toBe(1);
    });

    it('checks every app in the release, not only the first', () => {
        pack('win-unpacked', completeWindowsApp());
        pack('win-arm64-unpacked', {
            ...completeWindowsApp(),
            binaries: { 'ffmpeg.exe': pe(ARM64), 'ffprobe.exe': pe(ARM64) },
        });
        pack('win-ia32-unpacked', completeWindowsApp(), [
            'LICENSE-electron.txt',
        ]);

        const { code, out } = verify();

        expect(out).toContain('Verifying 3 packaged app(s)');
        expect(out).toContain(
            'win-ia32-unpacked: ffmpeg.exe is x64, but this app is ia32'
        );
        expect(out).toContain(
            'win-ia32-unpacked: LICENSE-electron.txt is missing'
        );
        expect(out).not.toContain('win-arm64-unpacked:');
        expect(code).toBe(1);
    });

    it('needs no libvpl notice on Linux, where it is not linked in', () => {
        const app = completeWindowsApp();
        pack('linux-unpacked', {
            exe: '',
            binaries: { ffmpeg: pe(X64), ffprobe: pe(X64) },
            files: Object.fromEntries(
                Object.entries(app.files).filter(
                    ([f]) => f !== 'LICENSE-libvpl.txt'
                )
            ),
        });

        const { code, out } = verify();

        expect(out).not.toContain('libvpl');
        expect(code).toBe(0);
    });

    it('ignores folders that are not packaged apps', () => {
        pack('win-unpacked', completeWindowsApp());
        mkdirSync(join(release, 'installers-from-ci'));

        const { code, out } = verify();

        expect(out).toContain('Verifying 1 packaged app(s)');
        expect(out).not.toContain('installers-from-ci');
        expect(code).toBe(0);
    });

    it('fails when there is nothing packaged to verify', () => {
        mkdirSync(join(release, 'installers-from-ci'));

        expect(verify()).toMatchObject({ code: 1 });
        expect(verify().out).toContain('No packaged app directories');
        expect(verify(join(release, 'missing')).out).toContain(
            'Nothing to verify'
        );
    });
});
