import { afterEach, describe, it, expect, vi } from 'vitest';
import { PipelineError } from '@luminary-media-converter/player-core';
import { installLivePlaylistXhr } from '../src/adapter/vhsLivePlaylistInterceptor';
import type { LivePlaylistSource } from '../src/serve/livePlaylistUri';

/**
 * These pin the seam, not the plumbing — as the key interceptor's do.
 *
 * `installLivePlaylistXhr` answers VHS's playlist requests for a
 * `luminary://live/…` address through VHS's internal request factory, so what
 * matters is the shape of the request object it hands back and the callback
 * contract `playlist-loader.js` relies on: a response it can parse, the status
 * an upstream failure carried, and silence after an abort.
 */
function fakePlayerWithVhs(originalXhr = vi.fn()) {
    const vhs: Record<string, unknown> = { xhr: originalXhr };
    return {
        _vhs: vhs,
        tech: () => ({ vhs }),
    } as any;
}

const LIVE_URI = 'luminary://live/3';
const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttps://live.example.com/l_1.ts\n';

/** A source whose reads the test settles by hand. */
function deferredSource() {
    const reads: {
        uri: string;
        signal: AbortSignal;
        resolve: (text: string) => void;
        reject: (error: unknown) => void;
    }[] = [];
    const source = {
        resolveLive: vi.fn(
            (uri: string, signal: AbortSignal) =>
                new Promise<string>((resolve, reject) => reads.push({ uri, signal, resolve, reject })),
        ),
    } satisfies LivePlaylistSource;
    return { source, reads };
}

/** Let promise callbacks run; works under fake timers too. */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe('installLivePlaylistXhr', () => {
    it('answers a live playlist request from the source, never over the network', async () => {
        const original = vi.fn();
        const player = fakePlayerWithVhs(original);
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI, requestType: 'hls-playlist' }, callback);
        reads[0]!.resolve(PLAYLIST);
        await settle();

        expect(original).not.toHaveBeenCalled();
        expect(source.resolveLive).toHaveBeenCalledWith(LIVE_URI, expect.any(AbortSignal));
        const [error, request] = callback.mock.calls[0]!;
        expect(error).toBeNull();
        // playlist-loader.js reads `responseText` off the request it was handed.
        expect(request).toMatchObject({ status: 200, responseText: PLAYLIST, response: PLAYLIST });
    });

    it('reports the address VHS asked for as the response URL', async () => {
        // VHS adopts a differing responseURL as the playlist's new address; the
        // upstream one would take every later refresh off this seam.
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const request: any = player._vhs.xhr({ uri: LIVE_URI }, vi.fn());
        reads[0]!.resolve(PLAYLIST);
        await settle();

        expect(request.responseURL).toBe(LIVE_URI);
        expect(request.uri).toBe(LIVE_URI);
    });

    it('asks the source afresh for every request — each refresh is a new read', async () => {
        const player = fakePlayerWithVhs();
        const { source } = deferredSource();
        installLivePlaylistXhr(player, source);

        player._vhs.xhr({ uri: LIVE_URI }, vi.fn());
        player._vhs.xhr({ uri: LIVE_URI }, vi.fn());

        expect(source.resolveLive).toHaveBeenCalledTimes(2);
    });

    it('hands VHS the status the upstream failed with, so its own retry policy applies', async () => {
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI }, callback);
        const failure = new PipelineError('fetch-failed', 'HTTP 404', { status: 404, missing: true });
        reads[0]!.reject(failure);
        await settle();

        const [error, request] = callback.mock.calls[0]!;
        expect(error).toBe(failure);
        expect(request.status).toBe(404);
        expect(request.statusCode).toBe(404);
    });

    it('leaves the status at 0 when there was no response at all', async () => {
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI }, callback);
        reads[0]!.reject(new Error('offline'));
        await settle();

        expect(callback.mock.calls[0]![0]).toBeInstanceOf(Error);
        expect(callback.mock.calls[0]![1].status).toBe(0);
    });

    it('cancels the read on abort and calls nothing back', async () => {
        // VHS aborts only what it has already stopped listening to.
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        const request: any = player._vhs.xhr({ uri: LIVE_URI }, callback);
        request.abort();
        reads[0]!.resolve(PLAYLIST);
        await settle();

        expect(request.aborted).toBe(true);
        expect(reads[0]!.signal.aborted).toBe(true);
        expect(callback).not.toHaveBeenCalled();
    });

    it("survives what VHS's stopRequest does to the object it gets back", () => {
        // playlist-loader.js: `oldRequest.onreadystatechange = null; oldRequest.abort();`
        const player = fakePlayerWithVhs();
        installLivePlaylistXhr(player, deferredSource().source);

        const request: any = player._vhs.xhr({ uri: LIVE_URI }, vi.fn());

        expect(() => {
            request.onreadystatechange = null;
            request.abort();
        }).not.toThrow();
        expect(() => request.addEventListener('loadend', vi.fn())).not.toThrow();
        expect(() => request.removeEventListener('loadend', vi.fn())).not.toThrow();
    });

    it('times out when VHS asked for a timeout, and says so the way an XHR would', async () => {
        vi.useFakeTimers();
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        const request: any = player._vhs.xhr({ uri: LIVE_URI, timeout: 5_000 }, callback);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0]![0]).toMatchObject({ code: 'ETIMEDOUT' });
        expect(request.timedout).toBe(true);
        expect(reads[0]!.signal.aborted).toBe(true);

        // A read that lands after the timeout is not a second answer.
        reads[0]!.resolve(PLAYLIST);
        await settle();
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('waits as long as the read takes when VHS asked for no timeout', async () => {
        vi.useFakeTimers();
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI, timeout: 0 }, callback);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(callback).not.toHaveBeenCalled();

        reads[0]!.resolve(PLAYLIST);
        await settle();
        expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ status: 200 }));
    });

    it('stands its timeout down once the read has answered', async () => {
        vi.useFakeTimers();
        const player = fakePlayerWithVhs();
        const { source, reads } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI, timeout: 5_000 }, callback);
        reads[0]!.resolve(PLAYLIST);
        await settle();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0]![0]).toBeNull();
    });

    it('calls back asynchronously, after the caller has filed the request', async () => {
        // The caller keeps the returned object as its in-flight request, and a
        // synchronous callback would run before it had.
        const player = fakePlayerWithVhs();
        installLivePlaylistXhr(player, { resolveLive: () => Promise.resolve(PLAYLIST) });

        const callback = vi.fn();
        player._vhs.xhr({ uri: LIVE_URI }, callback);

        expect(callback).not.toHaveBeenCalled();
        await settle();
        expect(callback).toHaveBeenCalled();
    });

    it('passes every other request straight through', () => {
        const original = vi.fn(() => 'passed-through');
        const player = fakePlayerWithVhs(original);
        const { source } = deferredSource();
        installLivePlaylistXhr(player, source);

        const callback = vi.fn();
        const result = player._vhs.xhr({ uri: 'https://live.example.com/l_1.ts' }, callback);

        expect(original).toHaveBeenCalledWith({ uri: 'https://live.example.com/l_1.ts' }, callback);
        expect(result).toBe('passed-through');
        expect(source.resolveLive).not.toHaveBeenCalled();
    });

    it('restores the original factory on uninstall', () => {
        const original = vi.fn();
        const player = fakePlayerWithVhs(original);

        const uninstall = installLivePlaylistXhr(player, deferredSource().source);
        expect(player._vhs.xhr).not.toBe(original);

        uninstall();
        expect(player._vhs.xhr).toBe(original);
    });
});
