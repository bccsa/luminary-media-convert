/**
 * The VHS request-factory seam.
 *
 * `@videojs/http-streaming` routes every request a source makes — playlists,
 * keys, init and media segments — through one per-handler factory,
 * `tech.vhs.xhr`, which `handleSource` creates fresh on every `player.src()`
 * and announces with `xhr-hooks-ready`. Replacing that property is how this
 * package answers key requests from memory (`vhsKeyInterceptor`) and how it
 * re-times byte-range segment requests (`vhsRequestTimeout`): two policies on
 * one mechanism, which lives here so neither has to know the mechanism's rules.
 *
 * Internal VHS API, pinned to the 3.17.x bundled in the video.js this
 * workspace installs. The factory is callable *and* carries hook plumbing VHS
 * reads off it — `beforeRequest`, the on/off request-response hooks and their
 * backing sets — so a wrapper that does not carry those across silently stops
 * every hook a host registered. The sets are shared by reference: VHS
 * allocates them lazily on whichever object a hook was registered through, so
 * a set registered on the wrapper would be invisible to the original, which is
 * what actually runs a real request. Both must point at one instance, which
 * means it has to exist before either can make its own.
 *
 * Wrappers chain: a second install wraps the first. Uninstall in reverse
 * order to unwind cleanly. Each uninstall restores only if the factory is
 * still the one it installed, so a later source that replaced the whole
 * handler is left alone rather than handed a factory from a dead load.
 */

import type Player from 'video.js/dist/types/player';
import type Tech from 'video.js/dist/types/tech/tech';
import type { VhsHandler, VhsXhrFactory } from '../types/videojs-vhs';

const HOOK_PROPERTIES = [
    'beforeRequest',
    'onRequest',
    'onResponse',
    'offRequest',
    'offResponse',
] as const;

const HOOK_CALLBACK_SETS = ['_requestCallbackSet', '_responseCallbackSet'] as const;

/** The tech currently driving the player, or null before one exists. */
export function vhsTech(player: Player): Tech | null {
    try {
        // `||`, not `??`: between unloading one tech and being handed the next,
        // video.js reports `false`.
        return player.tech({ IWillNotUseThisInPlugins: true }) || null;
    } catch {
        // tech() throws before a tech exists; treat it as "nothing yet".
        return null;
    }
}

/**
 * The VHS handler for the source currently loaded, or null when VHS is not
 * driving this tech (native playback, YouTube, or no source yet).
 */
export function vhsHandler(player: Player): VhsHandler | null {
    return vhsTech(player)?.vhs ?? null;
}

/**
 * Replace `tech.vhs.xhr` with `wrap(original, vhs)`, carrying VHS's hook
 * plumbing across. Returns the uninstall function. A no-op — returning a
 * function that does nothing — when there is no VHS handler to wrap.
 */
export function wrapVhsXhr(
    player: Player,
    wrap: (original: VhsXhrFactory, vhs: VhsHandler) => VhsXhrFactory,
): () => void {
    const vhs = vhsHandler(player);
    const original = vhs?.xhr;
    if (!vhs || typeof original !== 'function') return () => {};

    const wrapper = wrap(original, vhs);
    for (const property of HOOK_PROPERTIES) {
        if (original[property] !== undefined) wrapper[property] = original[property];
    }
    for (const property of HOOK_CALLBACK_SETS) {
        original[property] ??= new Set();
        wrapper[property] = original[property];
    }

    vhs.xhr = wrapper;

    return () => {
        if (vhs.xhr === wrapper) vhs.xhr = original;
    };
}
