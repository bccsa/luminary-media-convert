import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hls } from '@videojs/hlsjs-video';
import { BYTE_RANGE_TTFB_MS, createLuminaryLoader, loadPolicyConfig } from '../src/adapter/hlsLoaders';
import type { LoaderCallbacks, LoaderContext } from '../src/adapter/hlsTypes';

const KEY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

function callbacks() {
    return {
        onSuccess: vi.fn(),
        onError: vi.fn(),
        onTimeout: vi.fn(),
        onAbort: vi.fn(),
    } satisfies Partial<LoaderCallbacks> as unknown as LoaderCallbacks & Record<'onSuccess' | 'onError' | 'onTimeout', ReturnType<typeof vi.fn>>;
}

const ctx = (url: string) => ({ url }) as unknown as LoaderContext;
const loaderConfig = (timeout = 0) => ({ timeout }) as never;

function build(state: Partial<Parameters<typeof createLuminaryLoader>[0]> = {}) {
    const Loader = createLuminaryLoader({
        keyBytes: () => KEY,
        liveSource: () => undefined,
        ...state,
    });
    return new Loader(Hls.DefaultConfig as never);
}

afterEach(() => vi.restoreAllMocks());

describe('luminary://key', () => {
    it('is answered from memory with a copy of the key and never reaches the network', () => {
        const base = vi.spyOn(Hls.DefaultConfig.loader.prototype, 'load').mockImplementation(() => {});
        const cb = callbacks();
        build().load(ctx('luminary://key'), loaderConfig(), cb);

        expect(base).not.toHaveBeenCalled();
        const [response] = cb.onSuccess.mock.calls[0]!;
        expect(new Uint8Array(response.data)).toEqual(KEY);
        // hls.js keeps the result, so it must not alias the adapter's own bytes.
        expect(response.data).not.toBe(KEY.buffer);
    });

    it('tolerates the trailing slash a URL resolver appends', () => {
        const cb = callbacks();
        build().load(ctx('luminary://key/'), loaderConfig(), cb);
        expect(cb.onSuccess).toHaveBeenCalledOnce();
    });

    it('reports an error rather than a zero-length key when there is none', () => {
        const cb = callbacks();
        build({ keyBytes: () => null }).load(ctx('luminary://key'), loaderConfig(), cb);
        expect(cb.onError).toHaveBeenCalledOnce();
        expect(cb.onSuccess).not.toHaveBeenCalled();
    });

    it('reads the key at request time, so one config serves every source', () => {
        let current: Uint8Array | null = KEY;
        const loader = build({ keyBytes: () => current });
        current = null;
        const cb = callbacks();
        loader.load(ctx('luminary://key'), loaderConfig(), cb);
        expect(cb.onError).toHaveBeenCalledOnce();
    });
});

describe('everything else', () => {
    it('goes to the loader hls.js would have used', () => {
        const base = vi.spyOn(Hls.DefaultConfig.loader.prototype, 'load').mockImplementation(() => {});
        const cb = callbacks();
        build().load(ctx('https://cdn.example.com/seg.m4s'), loaderConfig(), cb);
        expect(base).toHaveBeenCalledOnce();
    });
});

describe('luminary://live/<n>', () => {
    it('is answered by the live source, as text', async () => {
        const resolveLive = vi.fn(async () => '#EXTM3U\n#EXT-X-VERSION:7\n');
        const cb = callbacks();
        build({ liveSource: () => ({ resolveLive }) }).load(ctx('luminary://live/3'), loaderConfig(), cb);
        await vi.waitFor(() => expect(cb.onSuccess).toHaveBeenCalledOnce());
        expect(resolveLive).toHaveBeenCalledWith('luminary://live/3', expect.any(AbortSignal));
        expect(cb.onSuccess.mock.calls[0]![0].data).toBe('#EXTM3U\n#EXT-X-VERSION:7\n');
    });

    it('reports the upstream status so the engine reacts to a 404 as it would have directly', async () => {
        const resolveLive = vi.fn(async () => {
            throw Object.assign(new Error('gone'), { status: 404 });
        });
        const cb = callbacks();
        build({ liveSource: () => ({ resolveLive }) }).load(ctx('luminary://live/3'), loaderConfig(), cb);
        await vi.waitFor(() => expect(cb.onError).toHaveBeenCalledOnce());
        expect(cb.onError.mock.calls[0]![0].code).toBe(404);
    });

    it('fails with a 404 when nothing serves live playlists', () => {
        const cb = callbacks();
        build().load(ctx('luminary://live/3'), loaderConfig(), cb);
        expect(cb.onError.mock.calls[0]![0].code).toBe(404);
    });

    it('times out on the engine\'s own timeout', async () => {
        vi.useFakeTimers();
        const cb = callbacks();
        const resolveLive = () => new Promise<string>(() => {});
        build({ liveSource: () => ({ resolveLive }) }).load(ctx('luminary://live/3'), loaderConfig(500), cb);
        await vi.advanceTimersByTimeAsync(600);
        expect(cb.onTimeout).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('stops listening to a request that was aborted', async () => {
        const seen: AbortSignal[] = [];
        const cb = callbacks();
        let resolve!: (text: string) => void;
        const loader = build({
            liveSource: () => ({
                resolveLive: (_uri, signal) => {
                    seen.push(signal);
                    return new Promise<string>((r) => (resolve = r));
                },
            }),
        });
        loader.load(ctx('luminary://live/3'), loaderConfig(), cb);
        loader.abort();
        resolve('#EXTM3U');
        await Promise.resolve();
        expect(seen[0]!.aborted).toBe(true);
        expect(cb.onSuccess).not.toHaveBeenCalled();
    });
});

describe('load policy', () => {
    it('waits at least a minute for the first byte of a cold byte-range chunk', () => {
        const policy = loadPolicyConfig().fragLoadPolicy!.default;
        expect(policy.maxTimeToFirstByteMs).toBeGreaterThanOrEqual(BYTE_RANGE_TTFB_MS);
    });

    it('keeps hls.js\'s retry behaviour', () => {
        const base = Hls.DefaultConfig.fragLoadPolicy.default;
        const policy = loadPolicyConfig().fragLoadPolicy!.default;
        expect(policy.maxLoadTimeMs).toBe(base.maxLoadTimeMs);
        expect(policy.errorRetry).toEqual(base.errorRetry);
        expect(policy.timeoutRetry).toEqual(base.timeoutRetry);
    });
});
