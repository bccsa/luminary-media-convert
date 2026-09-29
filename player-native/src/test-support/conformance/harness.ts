/**
 * The native test seam, in TypeScript: what the Kotlin and Swift
 * `ConformanceHarness` declare, member for member. The reference native side
 * implements it so the native half of every scenario runs in Vitest too.
 */

import type { JsonObject } from './scenario.js';

export type CallResult =
    | { resolved: JsonObject }
    | { rejected: { code: string; message: string } };

export type RouteResult =
    | { served: { bytes: Uint8Array; contentType: string } }
    | { failed: 'not-found' | 'key-required' };

export interface ConformanceHarness {
    /** Starts a registry reporting these capabilities (every key present). */
    start(capabilities: JsonObject): void;
    /** Goes through the same decoding and validation as `LuminaryPlayerPlugin`. */
    call(method: string, args: JsonObject): CallResult;
    engine(signal: string, args: JsonObject): void;
    advanceClock(seconds: number): void;
    /** `{ name, payload }` per event, in emission order, since the last drain. */
    drainEvents(): JsonObject[];
    /** `{ method, …args }` per engine call, since the last drain. */
    drainEngineCalls(): JsonObject[];
    /** Through the `UriRouter` of the most recently created player, even once destroyed. */
    route(uri: string): RouteResult;
}

/** The JSON a scenario's `route.expect` is matched against. */
export function routeJson(result: RouteResult): JsonObject {
    if ('failed' in result) return { error: result.failed };
    const { bytes, contentType } = result.served;
    const view: JsonObject = {
        contentType,
        bytes: bytes.length,
        hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
    try {
        view.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        // Not text: the view has no `text`, as on the native runners.
    }
    return view;
}
