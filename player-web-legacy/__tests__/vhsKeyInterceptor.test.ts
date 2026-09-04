import { describe, it, expect, vi } from 'vitest';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/player-core';
import { installMemoryKeyXhr } from '../src/adapter/vhsKeyInterceptor';

/**
 * These pin the seam, not the plumbing.
 *
 * `installMemoryKeyXhr` wraps VHS's per-handler request factory — internal API,
 * pinned to the version this workspace installs — so what matters is the shape
 * of the object it hands back and the fact that nothing key-shaped is ever
 * requested. A VHS upgrade that moves the seam should fail here rather than in
 * a viewer's browser.
 */
function fakePlayerWithVhs(originalXhr = vi.fn()) {
    const vhs: Record<string, unknown> = { xhr: originalXhr };
    return {
        _vhs: vhs,
        tech: () => ({ vhs }),
    } as any;
}

const KEY = new Uint8Array(16).fill(7);

describe('installMemoryKeyXhr', () => {
    it('answers the sentinel key URI from memory, never over the network', async () => {
        const original = vi.fn();
        const player = fakePlayerWithVhs(original);
        installMemoryKeyXhr(player, () => KEY);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, callback);
        await Promise.resolve();

        expect(original).not.toHaveBeenCalled();
        const [error, request] = callback.mock.calls[0];
        expect(error).toBeNull();
        expect(request.status).toBe(200);
        expect(new Uint8Array(request.response)).toEqual(KEY);
    });

    it('hands back a standalone 16-byte buffer, not a view onto a larger one', async () => {
        // VHS keeps the buffer and checks its length exactly; a view would carry
        // the backing store's length and be rejected.
        const player = fakePlayerWithVhs();
        installMemoryKeyXhr(player, () => new Uint8Array(new ArrayBuffer(64), 0, 16).fill(3));

        const callback = vi.fn();
        player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, callback);
        await Promise.resolve();

        expect(callback.mock.calls[0][1].response.byteLength).toBe(16);
    });

    it('calls back asynchronously, after the caller has filed the request', async () => {
        // The caller pushes the returned object into its active-request list
        // *after* this returns; a synchronous callback re-enters its completion
        // logic before that has happened.
        const player = fakePlayerWithVhs();
        installMemoryKeyXhr(player, () => KEY);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, callback);

        expect(callback).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(callback).toHaveBeenCalled();
    });

    it('reports an error rather than an empty key when there is no session key', async () => {
        const player = fakePlayerWithVhs();
        installMemoryKeyXhr(player, () => null);

        const callback = vi.fn();
        player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, callback);
        await Promise.resolve();

        expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('survives what VHS actually does with the object it gets back', async () => {
        /*
         * media-segment-request.js files every request in an `activeXhrs` array
         * and then calls `addEventListener('loadend', ...)` on each one, and
         * `abortAll` calls `abort()`. A plain response object without those threw
         * "addEventListener is not a function" and killed the segment load, so
         * encrypted playback failed with a black frame.
         */
        const player = fakePlayerWithVhs();
        installMemoryKeyXhr(player, () => KEY);

        const request: any = player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, vi.fn());
        await Promise.resolve();

        const activeXhrs = [request];
        expect(() =>
            activeXhrs.forEach((xhr) => xhr.addEventListener('loadend', vi.fn())),
        ).not.toThrow();
        expect(() => activeXhrs.forEach((xhr) => xhr.abort())).not.toThrow();
        expect(() => request.removeEventListener('loadend', vi.fn())).not.toThrow();
    });

    it('reports itself as not aborted, which is what the loadend handler reads', () => {
        // VHS's handleLoadEnd calls abortFn() when a request says it was aborted.
        const player = fakePlayerWithVhs();
        installMemoryKeyXhr(player, () => KEY);

        const request: any = player._vhs.xhr({ uri: LUMINARY_KEY_PLACEHOLDER_URI }, vi.fn());

        expect(request.aborted).toBe(false);
    });

    it('passes every other request straight through', () => {
        const original = vi.fn(() => 'passed-through');
        const player = fakePlayerWithVhs(original);
        installMemoryKeyXhr(player, () => KEY);

        const callback = vi.fn();
        const result = player._vhs.xhr({ uri: 'https://cdn/segment0.m4s' }, callback);

        expect(original).toHaveBeenCalledWith({ uri: 'https://cdn/segment0.m4s' }, callback);
        expect(result).toBe('passed-through');
    });

    it("carries VHS's own hook properties across the wrap", () => {
        // beforeRequest, the on/offRequest hooks and the callback sets live on
        // the factory. Dropping them silently disables every other consumer's
        // hooks, and the shared sets are how VHS finds its own registrations.
        const original: any = vi.fn();
        original.beforeRequest = vi.fn();
        const player = fakePlayerWithVhs(original);

        installMemoryKeyXhr(player, () => KEY);

        expect((player._vhs.xhr as any).beforeRequest).toBe(original.beforeRequest);
        expect((player._vhs.xhr as any)._requestCallbackSet).toBe(original._requestCallbackSet);
        expect((player._vhs.xhr as any)._responseCallbackSet).toBeInstanceOf(Set);
    });

    it('restores the original factory on uninstall', () => {
        const original = vi.fn();
        const player = fakePlayerWithVhs(original);

        const uninstall = installMemoryKeyXhr(player, () => KEY);
        expect(player._vhs.xhr).not.toBe(original);

        uninstall();
        expect(player._vhs.xhr).toBe(original);
    });

    it('leaves a replaced factory alone on uninstall', () => {
        // A later source swapped the whole handler; restoring into that one
        // would hand it a factory belonging to a torn-down source.
        const original = vi.fn();
        const player = fakePlayerWithVhs(original);
        const uninstall = installMemoryKeyXhr(player, () => KEY);

        const replacement = vi.fn();
        player._vhs.xhr = replacement;
        uninstall();

        expect(player._vhs.xhr).toBe(replacement);
    });

    it('is a no-op when there is no VHS handler to wrap', () => {
        const player = { tech: () => ({}) } as any;
        expect(() => installMemoryKeyXhr(player, () => KEY)()).not.toThrow();
    });
});
