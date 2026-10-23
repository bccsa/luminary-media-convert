import { describe, expect, it } from 'vitest';
import { flush } from '../../player-core/src/test-support/index.js';
import { BRIDGE_EVENT_NAMES, PROTOCOL_VERSION } from './bridge.js';
import { NativeBridgeError, createNativePlayer } from './createNativePlayer.js';
import { FakePlugin } from './test-support/fakePlugin.js';

describe('createNativePlayer', () => {
    it('checks the version, resets native, then creates a listening player', async () => {
        const plugin = new FakePlugin();
        await createNativePlayer({ plugin, skipBackSeconds: 15 });

        expect(plugin.methods()).toEqual(['getInfo', 'reset', 'create']);
        expect(plugin.argsOf('create')).toEqual([
            { protocolVersion: PROTOCOL_VERSION, skipBackSeconds: 15, skipForwardSeconds: 10 },
        ]);
        expect(plugin.listenerCount()).toBe(BRIDGE_EVENT_NAMES.length);
    });

    it('does the handshake once per JavaScript context', async () => {
        const plugin = new FakePlugin();
        await createNativePlayer({ plugin });
        await createNativePlayer({ plugin });

        expect(plugin.methods()).toEqual(['getInfo', 'reset', 'create', 'create']);
    });

    it('refuses a native side on another protocol version, and tries again next time', async () => {
        const plugin = new FakePlugin({}, PROTOCOL_VERSION + 1);

        const failure = await createNativePlayer({ plugin }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NativeBridgeError);
        expect((failure as NativeBridgeError).code).toBe('protocol-mismatch');
        expect(plugin.methods()).toEqual(['getInfo']);

        plugin.info = { ...plugin.info, protocolVersion: PROTOCOL_VERSION };
        await createNativePlayer({ plugin });
        expect(plugin.methods()).toEqual(['getInfo', 'getInfo', 'reset', 'create']);
    });

    it('asks native to catch up on a host resume signal, until destroyed', async () => {
        const plugin = new FakePlugin();
        let signal: (() => void) | null = null;
        const { controller } = await createNativePlayer({
            plugin,
            onAppResume: (listener) => {
                signal = listener;
                return () => {
                    signal = null;
                };
            },
            controller: {
                fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
                prefetch: { enabled: false },
            },
        });

        // Nothing loaded: nothing to catch up on.
        signal!();
        expect(plugin.methods()).not.toContain('resumed');

        controller.destroy();
        await flush();
        expect(signal).toBeNull();
    });
});
