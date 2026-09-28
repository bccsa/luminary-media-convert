/**
 * Whether a newer release than the one running is published on GitHub.
 *
 * Notification only: nothing is downloaded or installed here. The app is not
 * signed, so an in-place updater has nothing to verify a download against, and
 * macOS refuses to let an unsigned app replace itself (#206). What this can do
 * honestly is tell the user a new version exists and send them to it.
 *
 * Kept free of Electron so it can be tested; `main.ts` supplies the fetch.
 */

export const RELEASES_REPO = 'bccsa/luminary-media-convert';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;

export interface AvailableUpdate {
    /** The published version, without the leading `v`. */
    version: string;
    /** The release page, for its notes. */
    releaseUrl: string;
    /**
     * The installer for this machine, when the release carries one; otherwise
     * the release page, where the user can pick.
     */
    downloadUrl: string;
}

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface Release {
    tag_name: string;
    html_url: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: ReleaseAsset[];
}

/**
 * `1.2.3` as numbers, or null for anything else.
 *
 * A pre-release suffix is dropped rather than ordered: `/releases/latest`
 * never returns a pre-release, so the only one this sees is the running
 * build's own, and treating `0.0.2-rc.1` as `0.0.2` means a tester is not
 * nagged about the release their candidate became.
 */
export function parseVersion(version: string): number[] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
    return match ? match.slice(1, 4).map(Number) : null;
}

/** Whether `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i]! > b[i]!;
    }
    return false;
}

/**
 * The asset this machine should install, by the names electron-builder gives
 * them: `…-mac-arm64.dmg`, `…-mac-x64.dmg`, `…-win-x64.exe`.
 *
 * The installer rather than the zip, because the installer is what the release
 * notes tell people to download. No match — a platform with no build, or a
 * release that lost an asset — returns undefined, and the caller falls back to
 * the release page rather than guessing.
 */
export function pickAsset(
    assets: readonly ReleaseAsset[],
    platform: NodeJS.Platform,
    arch: string
): ReleaseAsset | undefined {
    const suffix =
        platform === 'darwin'
            ? `-mac-${arch}.dmg`
            : platform === 'win32'
              ? `-win-${arch}.exe`
              : undefined;
    if (!suffix) return undefined;
    return assets.find((asset) => asset.name.endsWith(suffix));
}

export interface CheckOptions {
    currentVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The newer release, or null when this is the latest (or newer, as a build
 * from source ahead of the last tag is).
 *
 * Throws on a network or API failure. Whether that is worth mentioning is the
 * caller's call: not at startup, where an offline machine is ordinary, but yes
 * when the user asked.
 */
export async function checkForUpdate(
    options: CheckOptions
): Promise<AvailableUpdate | null> {
    const response = await options.fetch(LATEST_RELEASE_API, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `luminary-media-convert/${options.currentVersion}`,
        },
    });
    // 404 is what GitHub answers when nothing has been published yet.
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status}`);
    }

    const release = (await response.json()) as Release;
    if (release.draft || release.prerelease) return null;

    const version = release.tag_name.replace(/^v/, '');
    if (!isNewer(version, options.currentVersion)) return null;

    const asset = pickAsset(
        release.assets ?? [],
        options.platform,
        options.arch
    );
    const releaseUrl = release.html_url || RELEASES_PAGE;
    return {
        version,
        releaseUrl,
        downloadUrl: asset?.browser_download_url ?? releaseUrl,
    };
}
