import { describe, expect, it, vi } from 'vitest';
import {
    checkForUpdate,
    isNewer,
    LATEST_RELEASE_API,
    parseVersion,
    pickAsset,
    RELEASES_PAGE,
} from './update-check';

const ASSETS = [
    'Luminary.Media.Convert-0.0.2-mac-arm64.dmg',
    'Luminary.Media.Convert-0.0.2-mac-arm64.zip',
    'Luminary.Media.Convert-0.0.2-mac-x64.dmg',
    'Luminary.Media.Convert-0.0.2-win-x64.exe',
].map((name) => ({
    name,
    browser_download_url: `https://github.com/dl/${name}`,
}));

const RELEASE_URL =
    'https://github.com/bccsa/luminary-media-convert/releases/tag/v0.0.2';

function respond(status: number, body: unknown = {}) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function release(overrides: Record<string, unknown> = {}) {
    return {
        tag_name: 'v0.0.2',
        html_url: RELEASE_URL,
        assets: ASSETS,
        ...overrides,
    };
}

const machine = {
    currentVersion: '0.0.1',
    platform: 'darwin',
    arch: 'arm64',
} as const;

describe('parseVersion', () => {
    it('reads a plain or v-prefixed version', () => {
        expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
        expect(parseVersion('v0.10.0')).toEqual([0, 10, 0]);
    });

    it('ignores a pre-release or build suffix', () => {
        expect(parseVersion('0.0.2-rc.1')).toEqual([0, 0, 2]);
    });

    it('refuses anything that is not a version', () => {
        expect(parseVersion('latest')).toBeNull();
        expect(parseVersion('1.2')).toBeNull();
    });
});

describe('isNewer', () => {
    it('compares numerically, not as text', () => {
        expect(isNewer('0.0.10', '0.0.9')).toBe(true);
        expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    });

    it('is false for the same or an older version', () => {
        expect(isNewer('0.0.1', '0.0.1')).toBe(false);
        expect(isNewer('0.0.1', '0.0.2')).toBe(false);
    });

    it('is false when either side is unreadable', () => {
        expect(isNewer('nightly', '0.0.1')).toBe(false);
        expect(isNewer('0.0.2', 'dev')).toBe(false);
    });
});

describe('pickAsset', () => {
    it('picks the dmg for each Mac architecture, not the zip', () => {
        expect(pickAsset(ASSETS, 'darwin', 'arm64')?.name).toBe(
            'Luminary.Media.Convert-0.0.2-mac-arm64.dmg'
        );
        expect(pickAsset(ASSETS, 'darwin', 'x64')?.name).toBe(
            'Luminary.Media.Convert-0.0.2-mac-x64.dmg'
        );
    });

    it('picks the Windows installer', () => {
        expect(pickAsset(ASSETS, 'win32', 'x64')?.name).toBe(
            'Luminary.Media.Convert-0.0.2-win-x64.exe'
        );
    });

    it('finds nothing for a platform or architecture with no build', () => {
        expect(pickAsset(ASSETS, 'linux', 'x64')).toBeUndefined();
        expect(pickAsset(ASSETS, 'win32', 'arm64')).toBeUndefined();
    });
});

describe('checkForUpdate', () => {
    it('asks the latest-release endpoint', async () => {
        const fetch = respond(200, release());
        await checkForUpdate({ ...machine, fetch });
        expect(fetch).toHaveBeenCalledWith(
            LATEST_RELEASE_API,
            expect.objectContaining({ headers: expect.any(Object) })
        );
    });

    it("offers the newer release with this machine's installer", async () => {
        const update = await checkForUpdate({
            ...machine,
            fetch: respond(200, release()),
        });
        expect(update).toEqual({
            version: '0.0.2',
            releaseUrl: RELEASE_URL,
            downloadUrl:
                'https://github.com/dl/Luminary.Media.Convert-0.0.2-mac-arm64.dmg',
        });
    });

    it('falls back to the release page when there is no matching installer', async () => {
        const update = await checkForUpdate({
            ...machine,
            platform: 'linux',
            fetch: respond(200, release()),
        });
        expect(update?.downloadUrl).toBe(RELEASE_URL);
    });

    it('is null when the running version is current', async () => {
        const update = await checkForUpdate({
            ...machine,
            currentVersion: '0.0.2',
            fetch: respond(200, release()),
        });
        expect(update).toBeNull();
    });

    // A build from source ahead of the last tag is not out of date.
    it('is null when the running version is ahead', async () => {
        const update = await checkForUpdate({
            ...machine,
            currentVersion: '0.1.0',
            fetch: respond(200, release()),
        });
        expect(update).toBeNull();
    });

    it('ignores drafts and pre-releases', async () => {
        for (const flag of ['draft', 'prerelease']) {
            const update = await checkForUpdate({
                ...machine,
                fetch: respond(200, release({ [flag]: true })),
            });
            expect(update).toBeNull();
        }
    });

    it('is null when nothing has been published', async () => {
        expect(
            await checkForUpdate({ ...machine, fetch: respond(404) })
        ).toBeNull();
    });

    it('throws on any other failure, so a manual check can say so', async () => {
        await expect(
            checkForUpdate({ ...machine, fetch: respond(403) })
        ).rejects.toThrow('403');
    });

    it('uses the releases page when the release has no URL', async () => {
        const update = await checkForUpdate({
            ...machine,
            fetch: respond(200, release({ html_url: '', assets: [] })),
        });
        expect(update?.releaseUrl).toBe(RELEASES_PAGE);
        expect(update?.downloadUrl).toBe(RELEASES_PAGE);
    });
});
