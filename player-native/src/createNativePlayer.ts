/**
 * The one entry point a host uses: a `PlayerController` driving the native
 * player, with the bridge's handshake done.
 *
 * The first player in a JavaScript context checks the protocol version and
 * resets native, which destroys any player an earlier context left behind — a
 * WebView reload, a crashed renderer, a hot-module reload all leave native
 * playing to nobody. Later players in the same context skip both.
 */

import {
    PlayerController,
    type PlayerControllerOptions,
    type Unsubscribe,
} from '@luminary-media-converter/player-core';
import {
    PROTOCOL_VERSION,
    type BridgeErrorCode,
    type BridgeInfo,
    type LuminaryPlayerPlugin,
} from './bridge.js';
import { AssetBatch } from './assetBatch.js';
import { NativeBridgeAdapter } from './NativeBridgeAdapter.js';
import { NativeServeStrategy } from './NativeServeStrategy.js';
import { LuminaryPlayer } from './plugin.js';

export interface NativePlayerOptions {
    /** Passed to the controller; the serving layer is the bridge's own. */
    controller?: Omit<PlayerControllerOptions, 'serveStrategy'>;
    /** Remote-command and notification skips. Default 10. */
    skipBackSeconds?: number;
    /** Default 10. */
    skipForwardSeconds?: number;
    /**
     * A second foreground signal beside `visibilitychange`, for a host that
     * already listens to one — `@capacitor/app`'s `resume`, typically. Both
     * may fire for one return; the adapter asks native once.
     */
    onAppResume?: (listener: () => void) => Unsubscribe;
    /** Where failed fire-and-forget calls go. Defaults to `console.warn`. */
    report?: (method: string, error: unknown) => void;
    /** The plugin to drive; the registered one unless a test supplies its own. */
    plugin?: LuminaryPlayerPlugin;
}

export interface NativePlayer {
    controller: PlayerController;
    adapter: NativeBridgeAdapter;
}

/** A bridge failure JavaScript raises itself, with the same codes native uses. */
export class NativeBridgeError extends Error {
    constructor(
        readonly code: BridgeErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'NativeBridgeError';
    }
}

/** One handshake per plugin per JavaScript context. */
const handshakes = new WeakMap<LuminaryPlayerPlugin, Promise<BridgeInfo>>();

export async function createNativePlayer(
    options: NativePlayerOptions = {},
): Promise<NativePlayer> {
    const plugin = options.plugin ?? LuminaryPlayer;
    const report = options.report ?? defaultReport;

    const info = await handshake(plugin);
    const { playerId } = await plugin.create({
        protocolVersion: PROTOCOL_VERSION,
        skipBackSeconds: options.skipBackSeconds ?? 10,
        skipForwardSeconds: options.skipForwardSeconds ?? 10,
    });

    const batch = new AssetBatch();
    const adapter = new NativeBridgeAdapter({ plugin, playerId, info, batch, report });
    await adapter.ready();

    const serveStrategy = new NativeServeStrategy({ plugin, playerId, batch, report });
    const controller = new PlayerController(adapter, {
        ...options.controller,
        serveStrategy,
    });

    watchForeground(adapter, options.onAppResume);
    return { controller, adapter };
}

function handshake(plugin: LuminaryPlayerPlugin): Promise<BridgeInfo> {
    let pending = handshakes.get(plugin);
    if (!pending) {
        pending = (async () => {
            const info = await plugin.getInfo();
            if (info.protocolVersion !== PROTOCOL_VERSION) {
                throw new NativeBridgeError(
                    'protocol-mismatch',
                    `The native player speaks protocol ${info.protocolVersion}; ` +
                        `this app speaks ${PROTOCOL_VERSION}`,
                );
            }
            await plugin.reset();
            return info;
        })();
        // A failed handshake is not remembered, so the next player tries again.
        pending.catch(() => handshakes.delete(plugin));
        handshakes.set(plugin, pending);
    }
    return pending;
}

function watchForeground(
    adapter: NativeBridgeAdapter,
    onAppResume: NativePlayerOptions['onAppResume'],
): void {
    const resume = () => void adapter.resume();

    if (typeof document !== 'undefined') {
        const onVisibility = () => {
            if (document.visibilityState === 'visible') resume();
        };
        document.addEventListener('visibilitychange', onVisibility);
        adapter.onDestroy(() =>
            document.removeEventListener('visibilitychange', onVisibility),
        );
    }
    if (onAppResume) adapter.onDestroy(onAppResume(resume));
}

function defaultReport(method: string, error: unknown): void {
    console.warn(`[luminary-native] ${method} failed`, error);
}
