import { Hls } from '@videojs/hlsjs-video';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/player-core';
import { isLivePlaylistUri, type LivePlaylistSource } from '../serve/livePlaylistUri';
import type { HlsJsConfig, LoaderCallbacks, LoaderConfiguration, LoaderConstructor, LoaderContext } from './hlsTypes';

/** What the loader reads at request time, so one config object serves every source. */
export interface LoaderState {
    keyBytes(): Uint8Array | null;
    liveSource(): LivePlaylistSource | undefined;
}

/** Tolerates the trailing slash a URL resolver may append. */
function isKeyPlaceholder(url: string): boolean {
    return url === LUMINARY_KEY_PLACEHOLDER_URI || url === `${LUMINARY_KEY_PLACEHOLDER_URI}/`;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * hls.js's loader, answering `luminary://key` from memory and `luminary://live/<n>` from the
 * serving layer; every other request goes to the loader hls.js would have used.
 */
export function createLuminaryLoader(state: LoaderState): LoaderConstructor {
    const Base: LoaderConstructor = Hls.DefaultConfig.loader;

    return class LuminaryLoader extends Base {
        private liveAbort: AbortController | null = null;

        override load(
            context: LoaderContext,
            config: LoaderConfiguration,
            callbacks: LoaderCallbacks
        ): void {
            if (isKeyPlaceholder(context.url)) return this.loadKey(context, callbacks);
            if (isLivePlaylistUri(context.url)) return this.loadLive(context, config, callbacks);
            super.load(context, config, callbacks);
        }

        override abort(): void {
            this.liveAbort?.abort();
            super.abort();
        }

        override destroy(): void {
            this.liveAbort?.abort();
            super.destroy();
        }

        private loadKey(context: LoaderContext, callbacks: LoaderCallbacks): void {
            this.context = context;
            const stats = this.stats;
            const key = state.keyBytes();
            if (!key || key.byteLength === 0) {
                callbacks.onError(
                    { code: 0, text: 'No session key available for the in-memory key loader' },
                    context,
                    null,
                    stats
                );
                return;
            }
            stats.loading.start = stats.loading.first = stats.loading.end = now();
            stats.loaded = stats.total = key.byteLength;
            // Copied into a standalone buffer: hls.js keeps the result.
            callbacks.onSuccess({ url: context.url, data: key.slice().buffer, code: 200 }, stats, context, null);
        }

        private loadLive(
            context: LoaderContext,
            config: LoaderConfiguration,
            callbacks: LoaderCallbacks
        ): void {
            this.context = context;
            const stats = this.stats;
            const source = state.liveSource();
            if (!source) {
                callbacks.onError({ code: 404, text: 'No live playlist source' }, context, null, stats);
                return;
            }
            const controller = new AbortController();
            this.liveAbort = controller;
            stats.loading.start = now();

            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutMs = config.timeout;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    controller.abort();
                    stats.aborted = false;
                    callbacks.onTimeout(stats, context, null);
                }, timeoutMs);
            }

            source.resolveLive(context.url, controller.signal).then(
                (text) => {
                    if (controller.signal.aborted) return;
                    clearTimeout(timer);
                    stats.loading.first = stats.loading.end = now();
                    stats.loaded = stats.total = text.length;
                    // The playlist loader reads text for a manifest/level context.
                    callbacks.onSuccess({ url: context.url, data: text, code: 200 }, stats, context, null);
                },
                (error: unknown) => {
                    if (controller.signal.aborted) return;
                    clearTimeout(timer);
                    const status = (error as { status?: unknown })?.status;
                    callbacks.onError(
                        { code: typeof status === 'number' ? status : 0, text: String((error as Error)?.message ?? error) },
                        context,
                        null,
                        stats
                    );
                }
            );
        }
    };
}

/**
 * Time to first byte for a byte-range segment.
 *
 * Every rendition of an angle shares one chunk object, so the first request into a cold chunk waits
 * on the edge's backhaul and hls.js's 10 s default would time it out and re-request the same cold
 * object. Ten target durations is the backstop v8 used (60 s at the encoder's default).
 */
export const BYTE_RANGE_TTFB_MS = 60_000;

/** The slice of hls.js config that stays fixed across sources. */
export function loadPolicyConfig(): HlsJsConfig {
    const base = Hls.DefaultConfig.fragLoadPolicy.default;
    return {
        fragLoadPolicy: {
            default: { ...base, maxTimeToFirstByteMs: Math.max(base.maxTimeToFirstByteMs, BYTE_RANGE_TTFB_MS) },
        },
    };
}
