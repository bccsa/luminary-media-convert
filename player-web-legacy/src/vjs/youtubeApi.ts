/**
 * Whether the YouTube iframe API loaded, and loading it again when it did not.
 *
 * `videojs-youtube` injects `https://www.youtube.com/iframe_api` once, as a side
 * effect of being imported, with a `load` handler and no `error` handler. When
 * the script fails, every YouTube player waits for an API that is not coming,
 * nothing is raised anywhere, and it stays that way until the page is reloaded.
 * A network that blocks YouTube does that, and so does Google's unusual-traffic
 * block, which Safari — every iOS browser, being WebKit — turns into a redirect
 * loop: the CAPTCHA exemption is a cookie youtube.com has to keep, and WebKit
 * keeps no cookies on a cross-site request.
 *
 * So the load is watched from outside the plugin, and restarted on request.
 * video.js 10's `@videojs/youtube-video` does both itself; this goes when the
 * player moves to it.
 */
import videojs from 'video.js';

/** The script `videojs-youtube` loads; its own constant, mirrored. */
export const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

/** Every script of the API — `iframe_api` and the widget script it loads. */
const YOUTUBE_SCRIPT_PREFIX = 'https://www.youtube.com/';

export type YouTubeApiOutcome = 'ready' | 'failed';

/** The `YT` global the API defines; only `ready` is used here. */
interface YouTubeGlobal {
    loaded?: number;
    ready?(callback: () => void): void;
}

/**
 * The statics of the tech `videojs-youtube` registers (3.0.1, pinned): the flag
 * a new player checks, and the queue a player joins while the API loads.
 */
interface YouTubeTechStatics {
    isApiReady?: boolean;
    apiReadyQueue?: { initYTPlayer(): void }[];
}

let status: 'loading' | YouTubeApiOutcome | null = null;
/**
 * Whether the load in flight is one this module started. Only then does it
 * hand the queued players to the API: the plugin's own callback belonged to the
 * script that failed, and a load the plugin started, it finishes itself.
 */
let restarted = false;
let settleWaiters: ((outcome: YouTubeApiOutcome) => void)[] = [];

function youTubeGlobal(): YouTubeGlobal | undefined {
    return (globalThis as { YT?: YouTubeGlobal }).YT;
}

function techStatics(): YouTubeTechStatics | undefined {
    return videojs.getTech('Youtube') as unknown as YouTubeTechStatics | undefined;
}

function settle(outcome: YouTubeApiOutcome): void {
    status = outcome;
    document.removeEventListener('load', onScriptEvent, true);
    document.removeEventListener('error', onScriptEvent, true);
    const waiters = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiters) resolve(outcome);
}

/**
 * Resource `load` and `error` events do not bubble, but they pass through the
 * document in the capture phase, so one listener there sees the plugin's script
 * without a reference to it — and cannot miss an error, however early, because
 * it is in place before the plugin is imported. The document and not `window`:
 * a `load` event's path stops at the document, so a listener on `window` hears
 * scripts fail and never hears one load.
 */
function onScriptEvent(event: Event): void {
    const script = event.target;
    if (status !== 'loading') return;
    if (!(script instanceof HTMLScriptElement)) return;
    if (!script.src.startsWith(YOUTUBE_SCRIPT_PREFIX)) return;

    if (event.type === 'error') {
        settle('failed');
        return;
    }
    // The widget script's own `load` says nothing: the API is ready when it
    // says so, through `YT.ready`.
    if (script.src !== YOUTUBE_IFRAME_API_URL) return;

    const api = youTubeGlobal();
    if (!api?.ready) {
        // Loaded, but not the API — an HTML page served with a 200, say.
        settle('failed');
        return;
    }
    api.ready(() => {
        if (restarted) {
            const tech = techStatics();
            if (tech) {
                // What the plugin's own callback does, for the players it queued.
                tech.isApiReady = true;
                const queued = tech.apiReadyQueue?.splice(0) ?? [];
                for (const player of queued) player.initYTPlayer();
            }
        }
        settle('ready');
    });
}

function listen(): void {
    document.addEventListener('load', onScriptEvent, true);
    document.addEventListener('error', onScriptEvent, true);
}

/**
 * Starts watching, before `videojs-youtube` is imported: importing it is what
 * starts the load. Idempotent.
 */
export function watchYouTubeApi(): void {
    if (status !== null || typeof document === 'undefined') return;
    if (techStatics()?.isApiReady || youTubeGlobal()?.loaded) {
        status = 'ready';
        return;
    }
    status = 'loading';
    listen();
}

/** How the load under way ends, or how the last one ended. */
export function whenYouTubeApiSettles(): Promise<YouTubeApiOutcome> {
    if (status === 'ready' || status === 'failed') return Promise.resolve(status);
    return new Promise((resolve) => settleWaiters.push(resolve));
}

/**
 * Loads the API again if the last attempt failed; otherwise does nothing.
 *
 * The failed scripts are removed first. A `YT` left behind by an attempt whose
 * widget script failed is cleared as well: the API script only starts loading
 * the widget script when there is no `YT` loading already. It is assigned
 * rather than deleted, because a top-level `var` in a classic script makes a
 * global that cannot be deleted.
 */
export function retryYouTubeApi(): void {
    if (status !== 'failed') return;

    document
        .querySelectorAll<HTMLScriptElement>(`script[src^="${YOUTUBE_SCRIPT_PREFIX}"]`)
        .forEach((script) => script.remove());
    const api = youTubeGlobal();
    if (api && !api.loaded) (globalThis as { YT?: YouTubeGlobal }).YT = undefined;

    status = 'loading';
    restarted = true;
    listen();
    const script = document.createElement('script');
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    document.head.appendChild(script);
}
