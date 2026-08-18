/**
 * Ad-hoc sign the macOS bundle after packaging.
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
const { join } = require('node:path');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const app = join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
    );

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
