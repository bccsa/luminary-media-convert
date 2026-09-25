import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `videojs-youtube` loads the YouTube iframe API once, when it is imported, and
 * has no `error` handler for it: a failed load left every YouTube player waiting
 * for good, with nothing raised. These pin the watch kept on that load from
 * outside the plugin, and the retry that replaces it.
 */
const holder = vi.hoisted(() => ({ tech: {} as { isApiReady?: boolean; apiReadyQueue?: unknown[] } }));

vi.mock('video.js', () => ({ default: { getTech: () => holder.tech } }));

const IFRAME_API = 'https://www.youtube.com/iframe_api';
const WIDGET = 'https://www.youtube.com/s/player/abc/www-widgetapi.vflset/www-widgetapi.js';

/** The module holds page-wide state, so each test gets a fresh copy. */
async function fresh() {
    vi.resetModules();
    return import('../src/vjs/youtubeApi');
}

function script(src: string): HTMLScriptElement {
    const el = document.createElement('script');
    el.src = src;
    document.head.appendChild(el);
    return el;
}

const fire = (el: Element, type: 'load' | 'error') => el.dispatchEvent(new Event(type));

/** A `YT` as the API script defines it: `ready` callbacks held until it is ready. */
function apiGlobal() {
    const callbacks: (() => void)[] = [];
    const YT = {
        loaded: 0,
        ready: (callback: () => void) => (YT.loaded ? callback() : callbacks.push(callback)),
    };
    (globalThis as any).YT = YT;
    return {
        becomeReady() {
            YT.loaded = 1;
            callbacks.splice(0).forEach((callback) => callback());
        },
    };
}

/** How the load has settled so far, without waiting for it to. */
async function settledSoFar(api: Awaited<ReturnType<typeof fresh>>) {
    let outcome = 'pending';
    void api.whenYouTubeApiSettles().then((result) => (outcome = result));
    await Promise.resolve();
    return outcome;
}

beforeEach(() => {
    holder.tech = {};
});

afterEach(() => {
    // Settles any copy still watching, so it cannot answer the next test's events.
    fire(script('https://www.youtube.com/done.js'), 'error');
    document.querySelectorAll('script').forEach((el) => el.remove());
    (globalThis as any).YT = undefined;
});

describe('watching the YouTube iframe API load', () => {
    it('fails when the API script does', async () => {
        // A network that blocks YouTube, or Safari's redirect loop on Google's
        // unusual-traffic block.
        const api = await fresh();
        api.watchYouTubeApi();

        fire(script(IFRAME_API), 'error');

        expect(await api.whenYouTubeApiSettles()).toBe('failed');
    });

    it('fails when what loaded is not the API', async () => {
        // An HTML page served with a 200 loads as a script and defines nothing.
        const api = await fresh();
        api.watchYouTubeApi();

        fire(script(IFRAME_API), 'load');

        expect(await api.whenYouTubeApiSettles()).toBe('failed');
    });

    it('is ready when the API says so, not when its script loads', async () => {
        const api = await fresh();
        api.watchYouTubeApi();
        const yt = apiGlobal();

        fire(script(IFRAME_API), 'load');
        expect(await settledSoFar(api)).toBe('pending');

        yt.becomeReady();
        expect(await settledSoFar(api)).toBe('ready');
    });

    it('fails when the widget script the API loads does', async () => {
        const api = await fresh();
        api.watchYouTubeApi();
        apiGlobal();

        fire(script(IFRAME_API), 'load');
        fire(script(WIDGET), 'error');

        expect(await api.whenYouTubeApiSettles()).toBe('failed');
    });

    it('ignores every other script', async () => {
        const api = await fresh();
        api.watchYouTubeApi();

        fire(script('https://cdn.example.com/other.js'), 'error');

        expect(await settledSoFar(api)).toBe('pending');
    });

    it('is ready at once when the API already is', async () => {
        holder.tech.isApiReady = true;
        const api = await fresh();

        api.watchYouTubeApi();

        expect(await api.whenYouTubeApiSettles()).toBe('ready');
    });

    it('leaves a load the plugin started for the plugin to finish', async () => {
        // Its own callback hands the queued players over; doing it as well would
        // start each of them twice.
        const queued = { initYTPlayer: vi.fn() };
        holder.tech.apiReadyQueue = [queued];
        const api = await fresh();
        api.watchYouTubeApi();
        const yt = apiGlobal();

        fire(script(IFRAME_API), 'load');
        yt.becomeReady();
        await api.whenYouTubeApiSettles();

        expect(queued.initYTPlayer).not.toHaveBeenCalled();
    });
});

describe('loading the YouTube iframe API again', () => {
    /** A watched load that has failed. */
    async function failed() {
        const api = await fresh();
        api.watchYouTubeApi();
        fire(script(IFRAME_API), 'error');
        await api.whenYouTubeApiSettles();
        return api;
    }

    it('does nothing unless the last attempt failed', async () => {
        const api = await fresh();
        api.watchYouTubeApi();

        api.retryYouTubeApi();

        expect(document.querySelectorAll('script')).toHaveLength(0);
    });

    it('replaces the failed script with a new one, and waits on it', async () => {
        const api = await failed();

        api.retryYouTubeApi();

        expect([...document.querySelectorAll('script')].map((el) => el.src)).toEqual([IFRAME_API]);
        expect(await settledSoFar(api)).toBe('pending');
    });

    it('hands the players the plugin queued to the API once it loads', async () => {
        // The plugin's own callback belonged to the script that failed.
        const queued = { initYTPlayer: vi.fn() };
        holder.tech.apiReadyQueue = [queued];
        const api = await failed();

        api.retryYouTubeApi();
        const yt = apiGlobal();
        fire(document.querySelector('script')!, 'load');
        yt.becomeReady();

        expect(await api.whenYouTubeApiSettles()).toBe('ready');
        expect(queued.initYTPlayer).toHaveBeenCalledTimes(1);
        expect(holder.tech.isApiReady).toBe(true);
        expect(holder.tech.apiReadyQueue).toEqual([]);
    });

    it('fails again when the new script does', async () => {
        const api = await failed();

        api.retryYouTubeApi();
        fire(document.querySelector('script')!, 'error');

        expect(await api.whenYouTubeApiSettles()).toBe('failed');
    });

    it('clears a YT left half-loaded, so the API fetches its widget script again', async () => {
        // The API script only fetches the widget script when no YT is loading.
        const api = await fresh();
        api.watchYouTubeApi();
        apiGlobal();
        fire(script(IFRAME_API), 'load');
        fire(script(WIDGET), 'error');
        await api.whenYouTubeApiSettles();

        api.retryYouTubeApi();

        expect((globalThis as any).YT).toBeUndefined();
    });
});
