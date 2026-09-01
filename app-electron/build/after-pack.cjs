/**
 * Two things that can only happen once a platform's app directory exists and
 * before its installer is made: collecting Electron's and Chromium's licence
 * texts, and ad-hoc signing the macOS bundle. Order matters between them — see
 * the call site.
 *
 * Electron's own binary arrives already signed (ad-hoc, linker-signed). Adding
 * `extraResources` — the encoder and its licence texts — changes the bundle after
 * that signature was made, which invalidates it. `mac.identity: null` tells
 * electron-builder not to sign, so nothing repairs it, and the app ships with a
 * signature that claims resources which no longer match.
 *
 * macOS treats that as corruption rather than as an unsigned app. A copy carrying
 * the quarantine flag — which is every copy a user downloads — is refused with
 * "the application is damaged and can't be opened. You should move it to the Bin",
 * offering no way past it. That is worse than being unsigned: an unsigned but
 * *valid* bundle gives the familiar "unidentified developer" dialog, which a user
 * can accept through right-click → Open.
 *
 * Re-signing ad-hoc restores a valid signature, so the app becomes openable again.
 * It does not make it trusted: Gatekeeper still has no Developer ID to check and
 * still asks. Proper signing and notarization replace this with an identity, and
 * are what auto-update needs.
 *
 * Locally built copies are unaffected either way — macOS only assesses quarantined
 * ones — which is exactly why this defect survives casual testing on the machine
 * that produced the build.
 */
const { execFileSync } = require('node:child_process');
const {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
} = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');

/** electron-builder hands `context.arch` as its Arch enum ordinal. */
const ARCH_NAME = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/**
 * Electron ships its own MIT licence and Chromium's licence file at the root of
 * its distribution, *beside* Electron.app rather than inside it — so packaging
 * copies the app and leaves both behind. Chromium is BSD-3-Clause and Electron
 * MIT, and both ask for their notice to travel with a binary distribution, which
 * is the same condition we already honour for libwebp.
 *
 * They are taken from the zip for the target being built, not from the host's
 * node_modules: a Windows app cross-built on a Mac would otherwise ship
 * Chromium's macOS credits.
 */
const ELECTRON_NOTICES = [
    { entry: 'LICENSE', as: 'LICENSE-electron.txt' },
    { entry: 'LICENSES.chromium.html', as: 'LICENSES-chromium.html' },
];

/** Where electron-builder caches the distributions it downloads. */
function electronCacheRoot() {
    if (process.env.ELECTRON_CACHE) return process.env.ELECTRON_CACHE;
    const home = homedir();
    if (process.platform === 'darwin')
        return join(home, 'Library', 'Caches', 'electron');
    if (process.platform === 'win32')
        return join(
            process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
            'electron',
            'Cache'
        );
    return join(home, '.cache', 'electron');
}

/** The cache keys a mirror hash into a subdirectory, so the zip is one level down. */
function findElectronZip(version, platform, arch) {
    const name = `electron-v${version}-${platform}-${arch}.zip`;
    const root = electronCacheRoot();
    if (!existsSync(root)) return null;
    for (const sub of ['.', ...readdirSync(root)]) {
        const candidate = join(root, sub, name);
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Extracted with tar rather than a zip library: this is bsdtar on macOS and on
 * Windows 10 1803 and later, it reads these zips, and it pulls two named members
 * out of a 115 MB archive without walking the rest.
 *
 * Staged through a temp directory so a partial extraction cannot leave a
 * half-written notice in the bundle.
 */
function extractEntries(zipPath, wanted, destDir) {
    const staging = mkdtempSync(join(tmpdir(), 'electron-notices-'));
    try {
        try {
            execFileSync(
                'tar',
                ['-xf', zipPath, '-C', staging, ...wanted.map((w) => w.entry)],
                { stdio: 'pipe' }
            );
        } catch (err) {
            throw new Error(
                `Could not extract licence texts from ${zipPath}: ` +
                    `${err.stderr?.toString().trim() || err.message}`
            );
        }

        const found = new Set();
        for (const want of wanted) {
            const from = join(staging, want.entry);
            if (!existsSync(from)) continue;
            copyFileSync(from, join(destDir, want.as));
            found.add(want.entry);
        }
        return found;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

/**
 * Fails the build when a notice is missing rather than shipping without it. The
 * obligation is not conditional, so neither is this.
 */
async function copyElectronNotices(context, resourcesDir) {
    const version = context.packager.info.framework.version;
    const platform = context.electronPlatformName;
    const arch = ARCH_NAME[context.arch];

    const zip = findElectronZip(version, platform, arch);
    if (!zip)
        throw new Error(
            `Cannot find electron-v${version}-${platform}-${arch}.zip in ` +
                `${electronCacheRoot()}. Electron's and Chromium's licence texts ` +
                `are taken from it and must ship with the app.`
        );

    mkdirSync(resourcesDir, { recursive: true });
    const found = await extractEntries(zip, ELECTRON_NOTICES, resourcesDir);

    const missing = ELECTRON_NOTICES.filter((n) => !found.has(n.entry));
    if (missing.length)
        throw new Error(
            `${zip} does not contain ${missing.map((m) => m.entry).join(', ')}.`
        );

    console.log(
        `  • licence notices  ${ELECTRON_NOTICES.map((n) => n.as).join(', ')}`
    );
}

exports.default = async function afterPack(context) {
    const app = join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`
    );

    // Before signing, not after: adding files to a signed bundle invalidates the
    // signature, which is the defect the rest of this hook exists to repair.
    await copyElectronNotices(
        context,
        context.electronPlatformName === 'darwin'
            ? join(app, 'Contents', 'Resources')
            : join(context.appOutDir, 'resources')
    );

    if (context.electronPlatformName !== 'darwin') return;

    // --deep is discouraged for Developer ID signing, where nested code should be
    // signed first and with its own entitlements. For an ad-hoc signature with no
    // hardened runtime there is nothing to inherit, and it is the one invocation
    // that covers the framework and the helper apps in a single pass.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {
        stdio: 'inherit',
    });

    // Verifying here rather than trusting the exit code: a signature that is present
    // but inconsistent is the whole defect this hook exists to prevent, and it is
    // cheaper to fail the build than to discover it from a user's screenshot.
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
        stdio: 'inherit',
    });

    console.log(`  • ad-hoc signed and verified  ${app}`);
};
