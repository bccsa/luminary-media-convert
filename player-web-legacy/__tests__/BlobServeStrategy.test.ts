import { afterEach, describe, it, expect, vi } from 'vitest';
import { PipelineError, type LivePlaylistSpec } from '@luminary-media-converter/player-core';
import { BlobServeStrategy } from '../src/serve/BlobServeStrategy';
import { isLivePlaylistUri } from '../src/serve/livePlaylistUri';

/**
 * The live half of the web's serving layer: a blob URL cannot change, so a
 * live playlist is served from an address the strategy answers itself, freshly,
 * on every request. The read behind it (fetch, LMCENC sniff, rewrite) is
 * `player-core`'s `resolveLivePlaylist` and is specified there; what is pinned
 * here is the address book around it.
 */
const DIR = 'https://live.example.com/channel/video_360';
const LIVE_URL = `${DIR}/chunks.m3u8`;
const SPEC: LivePlaylistSpec = { url: LIVE_URL, baseUrl: LIVE_URL, refreshSec: 4 };

/** A two-segment window starting at `first`, as the packager rewrites it. */
function liveWindow(first: number): string {
    return [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        `#EXT-X-MEDIA-SEQUENCE:${first}`,
        '#EXTINF:4,',
        `l_${first}.ts`,
        '#EXTINF:4,',
        `l_${first + 1}.ts`,
        '',
    ].join('\n');
}

/** A live upstream: one playlist whose window the test moves on. */
function upstream(first = 100) {
    const state = { text: liveWindow(first) };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const bytes = new TextEncoder().encode(state.text);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response;
    });
    return { state, fetchImpl: fetchImpl as unknown as typeof fetch & typeof fetchImpl };
}

const signal = () => new AbortController().signal;

/** jsdom implements neither object-URL call; stand them in for one test. */
function stubObjectUrls() {
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    const revoke = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:test/1');
    URL.revokeObjectURL = revoke;
    return {
        revoke,
        restore: () => {
            URL.createObjectURL = saved.create;
            URL.revokeObjectURL = saved.revoke;
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('BlobServeStrategy — live playlists', () => {
    it('serves a live playlist from its own luminary://live/ address, fetching nothing yet', () => {
        const { fetchImpl } = upstream();
        const strategy = new BlobServeStrategy({ fetchImpl });

        const uri = strategy.serveLive(SPEC);

        expect(isLivePlaylistUri(uri)).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('gives every live playlist an address of its own', () => {
        const strategy = new BlobServeStrategy({ fetchImpl: upstream().fetchImpl });

        const first = strategy.serveLive(SPEC);
        const second = strategy.serveLive({ ...SPEC, url: `${DIR}/../audio/chunks.m3u8` });

        expect(second).not.toBe(first);
    });

    it('answers every request with a fresh read of the upstream playlist', async () => {
        // The engine's refreshes are the refresh; each one must see the window
        // as it is now.
        const { state, fetchImpl } = upstream(100);
        const strategy = new BlobServeStrategy({ fetchImpl });
        const uri = strategy.serveLive(SPEC);

        const first = await strategy.resolveLive(uri, signal());
        state.text = liveWindow(101);
        const second = await strategy.resolveLive(uri, signal());

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([LIVE_URL, LIVE_URL]);
        expect(first).toContain(`${DIR}/l_100.ts`);
        expect(second).toContain(`${DIR}/l_102.ts`);
    });

    it('hands back text rewritten for the engine, every segment absolute', async () => {
        // Relative URIs would resolve against luminary://live/…, which nothing
        // on the network answers.
        const strategy = new BlobServeStrategy({ fetchImpl: upstream(100).fetchImpl });
        const text = await strategy.resolveLive(strategy.serveLive(SPEC), signal());

        const segments = text.split('\n').filter((line) => line && !line.startsWith('#'));
        expect(segments).toEqual([`${DIR}/l_100.ts`, `${DIR}/l_101.ts`]);
    });

    it('tolerates the trailing slash a URL resolver may append', async () => {
        const strategy = new BlobServeStrategy({ fetchImpl: upstream().fetchImpl });
        const uri = strategy.serveLive(SPEC);

        await expect(strategy.resolveLive(`${uri}/`, signal())).resolves.toContain('#EXTM3U');
    });

    it('passes the engine\'s abort signal to the read', async () => {
        const { fetchImpl } = upstream();
        const strategy = new BlobServeStrategy({ fetchImpl });
        const controller = new AbortController();

        await strategy.resolveLive(strategy.serveLive(SPEC), controller.signal);

        expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });

    it('answers an address it never minted as a server answers a playlist it lacks', async () => {
        const { fetchImpl } = upstream();
        const strategy = new BlobServeStrategy({ fetchImpl });

        const error = await strategy
            .resolveLive('luminary://live/999', signal())
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PipelineError);
        expect(error).toMatchObject({ code: 'fetch-failed', status: 404, missing: true });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('forgets its live playlists on release, as it revokes its blobs', async () => {
        const objectUrls = stubObjectUrls();
        try {
            const strategy = new BlobServeStrategy({ fetchImpl: upstream().fetchImpl });
            const blob = strategy.serve('#EXTM3U\n', 'application/vnd.apple.mpegurl');
            const uri = strategy.serveLive(SPEC);

            strategy.release();

            expect(objectUrls.revoke).toHaveBeenCalledWith(blob);
            await expect(strategy.resolveLive(uri, signal())).rejects.toMatchObject({ status: 404 });
        } finally {
            objectUrls.restore();
        }
    });

    it('never hands out an address twice, across releases', async () => {
        // An engine still holding an address from a released source must not
        // be answered with a newer source's playlist.
        const strategy = new BlobServeStrategy({ fetchImpl: upstream().fetchImpl });
        const old = strategy.serveLive(SPEC);
        strategy.release();
        const current = strategy.serveLive(SPEC);

        expect(current).not.toBe(old);
        await expect(strategy.resolveLive(old, signal())).rejects.toMatchObject({ status: 404 });
        await expect(strategy.resolveLive(current, signal())).resolves.toContain('#EXTM3U');
    });

    it('reads through the global fetch when it is given none', async () => {
        const { fetchImpl } = upstream();
        vi.stubGlobal('fetch', fetchImpl);
        const strategy = new BlobServeStrategy();

        await strategy.resolveLive(strategy.serveLive(SPEC), signal());

        expect(fetchImpl).toHaveBeenCalledWith(LIVE_URL, expect.anything());
    });
});
