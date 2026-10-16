import type { InjectionKey } from 'vue';
import type { Unsubscribe } from '@luminary-media-converter/player-core';
import type { LuminaryPlayerPlugin } from '@luminary-media-converter/player-native';
import { bridgeStats } from '@/lab/bridgeStats';

/** The plugin `NativeVideoPlayer` drives: the Capacitor one on a device, the simulated one elsewhere. */
export const NativePluginKey: InjectionKey<LuminaryPlayerPlugin> = Symbol('LuminaryPlayerPlugin');

/** `@capacitor/app`'s `resume`, where the build has it; see `NativePlayerOptions.onAppResume`. */
export const AppResumeKey: InjectionKey<(listener: () => void) => Unsubscribe> = Symbol('AppResume');

/**
 * The plugin, timing every call and counting its rejections for the lab's health board. It
 * forwards everything unchanged, so the bridge behaves exactly as without it.
 */
export function instrument(plugin: LuminaryPlayerPlugin): LuminaryPlayerPlugin {
    return new Proxy(plugin, {
        get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver) as unknown;
            if (typeof value !== 'function' || name === 'addListener') {
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return (args?: unknown) => {
                const method = String(name);
                const started = performance.now();
                if (method === 'load') bridgeStats.loadPayload(JSON.stringify(args ?? {}).length);
                const call = (value as (args?: unknown) => Promise<unknown>).call(target, args);
                call.then(
                    () => bridgeStats.resolved(method, performance.now() - started),
                    (error: { code?: string; message?: string }) =>
                        bridgeStats.rejected(method, performance.now() - started, error?.code ?? 'unknown', error?.message ?? String(error)),
                );
                return call;
            };
        },
    });
}
