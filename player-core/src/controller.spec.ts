import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PlayerController,
    type PlayerControllerOptions,
} from './controller.js';
import { DEFAULT_ANGLE_ID } from './pipeline/pipeline.js';
import { DEFAULT_POLL_INTERVAL_MS } from './poller.js';
import { DEFAULT_LEAD_SECONDS, DEFAULT_WARM_BYTES } from './prefetch.js';
import { AUDIO_ONLY_ANGLE_ID, type PlayerError } from './types.js';
import {
    CHAPTERS_VTT,
    CHUNKED_MEDIA_PLAYLIST,
    FakeAdapter,
    FakeServeStrategy,
    MULTI_ANGLE_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
    SUBTITLE_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    encryptLmcenc,
    flush,
    makeFetch,
    type FakeAdapterOptions,
    type RouteBody,
} from './test-support/index.js';

const BASE = 'https://cdn.example.com/out/session';
const MASTER_URL = `${BASE}/master.m3u8`;
const EN_CHAPTERS = `${BASE}/chapters/en.vtt`;
const FR_CHAPTERS = `${BASE}/chapters/fr.vtt`;

const FR_VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nOuverture\n';

const simpleRoutes: Record<string, RouteBody> = {
    [MASTER_URL]: SIMPLE_MASTER,
    [`${BASE}/stream_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/stream_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/stream_480/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
};

const multiAngleRoutes: Record<string, RouteBody> = {
    [MASTER_URL]: MULTI_ANGLE_MASTER,
    [`${BASE}/angle0_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle0_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle1_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/audio_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/subs_en/playlist.m3u8`]: SUBTITLE_MEDIA_PLAYLIST,
    [`${BASE}/subs_en/en_0.vtt`]: CHAPTERS_VTT,
};

function setup(
    routes: Record<string, RouteBody>,
    adapterOptions: FakeAdapterOptions = {},
    options: PlayerControllerOptions = {},
) {
    const adapter = new FakeAdapter(adapterOptions);
    const fake = makeFetch(routes);
    const serveStrategy = new FakeServeStrategy();
    const controller = new PlayerController(adapter, {
        fetchImpl: fake.fetchImpl,
        serveStrategy,
        // Off by default here: chunk warming has its own spec, and every other
        // test in this file counts fetches.
        prefetch: { enabled: false },
        ...options,
    });
    const errors: PlayerError[] = [];
    controller.on('error', (error) => errors.push(error));
    return { adapter, controller, serveStrategy, errors, ...fake };
}

describe('PlayerController — load', () => {
    it('fails into state, never rejects, when no blobs can be served', async () => {
        // jsdom and some SSR runtimes have no Blob/createObjectURL, so with no
        // serveStrategy supplied the default construction throws — synchronously,
        // and a throw above load()'s try block escapes it. Hosts call load()
        // fire-and-forget because the contract is that failures surface through
        // state; a rejecting load is an unhandled rejection in every one of them.
        // Node has createObjectURL, so the environment is degraded by hand —
        // this is jsdom's actual shape, where it is absent.
        const original = URL.createObjectURL;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (URL as any).createObjectURL = undefined;
        try {
            const adapter = new FakeAdapter();
            const fake = makeFetch(simpleRoutes);
            const controller = new PlayerController(adapter, {
                fetchImpl: fake.fetchImpl,
                // no serveStrategy — the default cannot be built here
                prefetch: { enabled: false },
            });
            const errors: PlayerError[] = [];
            controller.on('error', (error) => errors.push(error));

            await expect(
                controller.load({ masterUrl: MASTER_URL }),
            ).resolves.toBeUndefined();

            expect(controller.getState().lifecycle).toBe('error');
            expect(errors).toHaveLength(1);
            controller.destroy();
        } finally {
            URL.createObjectURL = original;
        }
    });

    it('serves a munged master even for an unencrypted, un-narrowed source', async () => {
        const { adapter, controller, serveStrategy } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        expect(controller.getState().lifecycle).toBe('ready');
        expect(adapter.loads).toHaveLength(1);
        expect(adapter.loads[0]?.isBlob).toBe(true);
        expect(serveStrategy.textOf(adapter.loads[0]!.url)).toContain(
            '#EXT-X-STREAM-INF',
        );
        expect(controller.getState().qualities.map((q) => q.id)).toEqual([
            '1080',
            '720',
            '480',
        ]);
    });

    it('exposes angles including the audio-only pseudo-angle', async () => {
        const { controller } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        const state = controller.getState();
        expect(state.angles.map((a) => a.id)).toEqual([
            'angle_0',
            'angle_1',
            AUDIO_ONLY_ANGLE_ID,
        ]);
        expect(state.activeAngleId).toBe('angle_0');
        expect(state.subtitleTracks.map((t) => t.source)).toEqual(['master']);
    });

    it('applies the load-time quality cap', async () => {
        const { controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL, maxHeight: 720 });

        const state = controller.getState();
        expect(state.maxHeight).toBe(720);
        expect(state.qualities.map((q) => q.id)).toEqual(['720', '480']);
    });

    it('seeks to startPosition without autoplaying', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL, startPosition: 42 });
        expect(adapter.seeks).toEqual([42]);
        expect(adapter.playCount).toBe(0);
    });

    it('reports a fatal load failure as lifecycle error', async () => {
        const { controller, errors } = setup({
            [MASTER_URL]: { status: 500 },
        });
        await controller.load({ masterUrl: MASTER_URL });
        expect(controller.getState().lifecycle).toBe('error');
        expect(controller.getState().error?.code).toBe('fetch-failed');
        expect(errors).toHaveLength(1);
    });

    it('releases the previous generation on every load and on destroy', async () => {
        const { controller, serveStrategy } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        await controller.load({ masterUrl: MASTER_URL });
        expect(serveStrategy.releaseCount).toBe(2);
        controller.destroy();
        expect(serveStrategy.releaseCount).toBe(3);
    });

    it('hands the original URL to a nativeHls adapter without munging', async () => {
        const { adapter, controller, calls } = setup(multiAngleRoutes, {
            nativeHls: true,
        });
        await controller.load({ masterUrl: MASTER_URL, keyHex: TEST_KEY_HEX });
        expect(adapter.loads).toEqual([
            { url: MASTER_URL, isBlob: false, keyHex: TEST_KEY_HEX },
        ]);
        // Only the master was read; no sub-playlists were fetched.
        expect(calls).toEqual([MASTER_URL]);
    });
});

describe('PlayerController — coming-soon polling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([404, 403])(
        'waits on HTTP %i and loads when the master appears — no autoplay',
        async (status) => {
            const { adapter, controller, routes, calls } = setup({
                [MASTER_URL]: { status },
            });
            const available = vi.fn();
            controller.on('master-available', available);

            await controller.load({ masterUrl: MASTER_URL });
            expect(controller.getState().lifecycle).toBe('waiting-for-master');
            expect(calls).toHaveLength(1); // the immediate first check
            // Regression: a previously loaded source must not keep playing
            // (invisibly, under the coming-soon surface) while waiting.
            expect(adapter.pauseCount).toBeGreaterThan(0);
            expect(controller.getState().playing).toBe(false);

            await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS - 1);
            expect(calls).toHaveLength(1);

            for (const [url, body] of Object.entries(simpleRoutes)) {
                routes.set(url, body);
            }
            await vi.advanceTimersByTimeAsync(1);
            await flush();

            expect(available).toHaveBeenCalledTimes(1);
            expect(controller.getState().lifecycle).toBe('ready');
            expect(adapter.loads).toHaveLength(1);
            expect(adapter.playCount).toBe(0);
        },
    );

    it('keeps re-checking on the fixed cadence', async () => {
        const { controller, calls } = setup({ [MASTER_URL]: { status: 404 } });
        await controller.load({ masterUrl: MASTER_URL });

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 3);
        expect(calls).toHaveLength(4);
        controller.destroy();
    });

    it('stops polling on destroy()', async () => {
        const { controller, calls } = setup({ [MASTER_URL]: { status: 404 } });
        await controller.load({ masterUrl: MASTER_URL });
        controller.destroy();

        await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 5);
        expect(calls).toHaveLength(1);
    });

    it('fails immediately when polling is disabled', async () => {
        const { controller } = setup({ [MASTER_URL]: { status: 404 } });
        await controller.load({
            masterUrl: MASTER_URL,
            poll: { enabled: false },
        });
        expect(controller.getState().lifecycle).toBe('error');
    });
});

describe('PlayerController — setAngle', () => {
    it('preserves position and play state', async () => {
        const { adapter, controller } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.emit('playing', undefined);
        adapter.advanceTo(73.5);
        expect(controller.getState().playing).toBe(true);

        const changed = vi.fn();
        controller.on('angle-changed', changed);
        await controller.setAngle('angle_1');

        expect(controller.getState().activeAngleId).toBe('angle_1');
        expect(changed).toHaveBeenCalledWith({ angleId: 'angle_1' });
        expect(adapter.loads).toHaveLength(2);
        expect(adapter.seeks).toEqual([73.5]);
        expect(adapter.playCount).toBe(1);
    });

    it('does not resume a paused player', async () => {
        const { adapter, controller } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        adapter.advanceTo(10);

        await controller.setAngle('angle_1');
        expect(adapter.playCount).toBe(0);
        expect(adapter.seeks).toEqual([10]);
    });

    it('switches to the audio-only pseudo-angle with zero video fetches', async () => {
        const { adapter, controller, calls } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        const before = calls.length;

        await controller.setAngle(AUDIO_ONLY_ANGLE_ID);

        expect(controller.getState().isAudioOnly).toBe(true);
        const after = calls.slice(before);
        expect(after.some((url) => url.includes('angle'))).toBe(false);
        expect(adapter.loads.at(-1)?.isBlob).toBe(true);
    });

    it('ignores unknown ids and no-op re-selection', async () => {
        const { adapter, controller } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        await controller.setAngle('nope');
        await controller.setAngle('angle_0');
        expect(adapter.loads).toHaveLength(1);
    });
});

describe('PlayerController — quality and tracks', () => {
    it('maps contract quality ids onto adapter variant ids', async () => {
        const { adapter, controller } = setup(simpleRoutes, {
            variants: [
                { id: 'level-0', height: 480, bandwidth: 1_000_000 },
                { id: 'level-1', height: 720, bandwidth: 2_500_000 },
            ],
        });
        await controller.load({ masterUrl: MASTER_URL });

        expect(controller.getState().qualities.map((q) => q.id)).toEqual([
            '720',
            '480',
        ]);
        controller.setQuality('720');
        expect(adapter.variantCalls).toEqual(['level-1']);
        expect(controller.getState().activeQualityId).toBe('720');

        controller.setQuality('auto');
        expect(adapter.variantCalls).toEqual(['level-1', 'auto']);
    });

    it('takes over the audio track list when the engine publishes one', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.publishAudioTracks([
            { id: 'hls-0', lang: 'en', label: 'English' },
            { id: 'hls-1', lang: 'fr', label: 'Français' },
        ]);
        expect(controller.getState().audioTracks.map((t) => t.id)).toEqual([
            'hls-0',
            'hls-1',
        ]);

        controller.setAudioTrack('hls-1');
        expect(adapter.audioTrackCalls).toEqual(['hls-1']);
        expect(controller.getState().activeAudioTrackId).toBe('hls-1');
    });

    it('forwards subtitle selection to the adapter', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        controller.setSubtitleTrack('m::English');
        expect(adapter.activeTextTrackId).toBe('m::English');
        controller.setSubtitleTrack(null);
        expect(adapter.activeTextTrackId).toBeNull();
        expect(controller.getState().activeSubtitleTrackId).toBeNull();
    });

    it('serves sidecar subtitles to the engine as text tracks', async () => {
        const { adapter, controller, serveStrategy } = setup({
            ...simpleRoutes,
            [`${BASE}/subs/en.vtt`]: encryptLmcenc(CHAPTERS_VTT),
        });
        await controller.load({
            masterUrl: MASTER_URL,
            keyHex: TEST_KEY_HEX,
            sidecars: {
                subtitles: [
                    {
                        lang: 'en',
                        label: 'English',
                        url: `${BASE}/subs/en.vtt`,
                    },
                ],
            },
        });

        expect(adapter.textTracks).toHaveLength(1);
        expect(serveStrategy.textOf(adapter.textTracks[0]!.blobUrl)).toBe(
            CHAPTERS_VTT,
        );
        expect(
            controller.getState().subtitleTracks.map((t) => t.source),
        ).toContain('sidecar');
    });
});

describe('PlayerController — chapters', () => {
    it('loads the language matching the active audio track by default', async () => {
        const { controller, calls } = setup({
            ...simpleRoutes,
            [EN_CHAPTERS]: CHAPTERS_VTT,
            [FR_CHAPTERS]: FR_VTT,
        });

        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: {
                chapters: [
                    { lang: 'fr', label: 'Français', url: FR_CHAPTERS },
                    { lang: 'en', label: 'English', url: EN_CHAPTERS },
                ],
            },
        });
        await flush();

        const state = controller.getState();
        // The master's audio rendition is LANGUAGE="en".
        expect(state.activeChapterTrackId).toBe('c:en');
        expect(state.chapters.map((c) => c.title)).toEqual([
            'Opening',
            'The interview',
        ]);
        // Lazy: the French file was never fetched.
        expect(calls).not.toContain(FR_CHAPTERS);
    });

    it('falls back to the first sidecar when no language matches', async () => {
        const { controller } = setup({
            ...simpleRoutes,
            [FR_CHAPTERS]: FR_VTT,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { chapters: [{ lang: 'fr', url: FR_CHAPTERS }] },
        });
        await flush();

        expect(controller.getState().activeChapterTrackId).toBe('c:fr');
        expect(controller.getState().chapters).toHaveLength(1);
    });

    it('switches languages on demand and caches each one', async () => {
        const { controller, calls } = setup({
            ...simpleRoutes,
            [EN_CHAPTERS]: CHAPTERS_VTT,
            [FR_CHAPTERS]: FR_VTT,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: {
                chapters: [
                    { lang: 'en', url: EN_CHAPTERS },
                    { lang: 'fr', url: FR_CHAPTERS },
                ],
            },
        });
        await flush();

        controller.setChapterTrack('c:fr');
        await flush();
        expect(controller.getState().chapters.map((c) => c.title)).toEqual([
            'Ouverture',
        ]);

        controller.setChapterTrack('c:en');
        await flush();
        controller.setChapterTrack('c:fr');
        await flush();
        expect(calls.filter((url) => url === FR_CHAPTERS)).toHaveLength(1);
    });

    it('reads encrypted chapter sidecars with the session key', async () => {
        const { controller } = setup({
            ...simpleRoutes,
            [EN_CHAPTERS]: encryptLmcenc(CHAPTERS_VTT),
        });
        await controller.load({
            masterUrl: MASTER_URL,
            keyHex: TEST_KEY_HEX,
            sidecars: { chapters: [{ lang: 'en', url: EN_CHAPTERS }] },
        });
        await flush();
        expect(controller.getState().chapters).toHaveLength(2);
    });

    it('turns chapters off without touching playback', async () => {
        const { controller } = setup({
            ...simpleRoutes,
            [EN_CHAPTERS]: CHAPTERS_VTT,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { chapters: [{ lang: 'en', url: EN_CHAPTERS }] },
        });
        await flush();

        controller.setChapterTrack(null);
        await flush();
        expect(controller.getState().activeChapterTrackId).toBeNull();
        expect(controller.getState().chapters).toEqual([]);
        expect(controller.getState().lifecycle).toBe('ready');
    });

    it('reports a broken chapter file non-fatally', async () => {
        const { controller, errors } = setup(simpleRoutes);
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { chapters: [{ lang: 'en', url: EN_CHAPTERS }] },
        });
        await flush();

        expect(controller.getState().lifecycle).toBe('ready');
        expect(errors[0]).toMatchObject({ code: 'fetch-failed', fatal: false });
    });
});

describe('PlayerController — playback state', () => {
    it('mirrors adapter events into the store', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.emit('durationchange', { duration: 300 });
        adapter.emit('playing', undefined);
        adapter.advanceTo(12);
        expect(controller.getState()).toMatchObject({
            duration: 300,
            playing: true,
            currentTime: 12,
        });

        adapter.emit('pause', undefined);
        expect(controller.getState().playing).toBe(false);

        adapter.emit('ended', undefined);
        expect(controller.getState().ended).toBe(true);
    });

    it('togglePlay follows the current state', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        controller.togglePlay();
        expect(adapter.playCount).toBe(1);

        adapter.emit('playing', undefined);
        controller.togglePlay();
        expect(adapter.pauseCount).toBe(1);
    });

    it('notifies subscribers with frozen snapshots', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        const seen: string[] = [];
        controller.subscribe((state) => {
            expect(Object.isFrozen(state)).toBe(true);
            seen.push(state.lifecycle);
        });

        await controller.load({ masterUrl: MASTER_URL });
        adapter.emit('playing', undefined);
        expect(seen).toContain('loading');
        expect(seen).toContain('ready');
    });
});

describe('PlayerController — recovery', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('escalates in-place → 2s / 4s / 8s reloads → fatal error', async () => {
        const { adapter, controller, errors } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        const recovered: number[] = [];
        controller.on('recovered', ({ attempt }) => recovered.push(attempt));

        const fail = () =>
            adapter.emit('error', { category: 'media', fatal: true });

        fail();
        expect(adapter.recoverCalls).toEqual(['media']);
        expect(adapter.loads).toHaveLength(1);

        fail();
        await vi.advanceTimersByTimeAsync(1_999);
        expect(adapter.loads).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(adapter.loads).toHaveLength(2);

        fail();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(adapter.loads).toHaveLength(3);

        fail();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(adapter.loads).toHaveLength(4);

        fail();
        expect(controller.getState().lifecycle).toBe('error');
        expect(controller.getState().error).toMatchObject({
            code: 'media',
            fatal: true,
        });
        expect(errors).toHaveLength(1);
        expect(recovered).toEqual([1, 2, 3]);
    });

    it('ignores non-fatal engine errors', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.emit('error', { category: 'network', fatal: false });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(adapter.recoverCalls).toEqual([]);
        expect(controller.getState().lifecycle).toBe('ready');
    });

    it('maps a network category onto a network error', async () => {
        const { adapter, controller } = setup(simpleRoutes, {
            recoverResult: false,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            recovery: { maxReloadAttempts: 0 },
        });

        adapter.emit('error', { category: 'network', fatal: true });
        expect(controller.getState().error?.code).toBe('network');
    });
});

describe('PlayerController — stall watchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('nudges after 10s, then routes a wedged engine to the media-error path', async () => {
        const { adapter, controller } = setup(simpleRoutes, {
            recoverResult: false,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            recovery: { maxReloadAttempts: 0 },
        });

        adapter.currentTime = 5;
        adapter.emit('playing', undefined);
        // A wedged engine ignores the nudge.
        const seeks: number[] = [];
        vi.spyOn(adapter, 'seek').mockImplementation((s: number) => {
            seeks.push(s);
        });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(seeks).toEqual([5.1]);
        expect(controller.getState().stalled).toBe(true);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(controller.getState().lifecycle).toBe('error');
        expect(controller.getState().error?.code).toBe('media');
    });

    it('clears the stall when the nudge works', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.emit('playing', undefined);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(controller.getState().stalled).toBe(true);

        adapter.currentTime = 60;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(controller.getState().stalled).toBe(false);
        expect(controller.getState().lifecycle).toBe('ready');
    });

    it('stops watching while paused', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        adapter.emit('playing', undefined);
        adapter.emit('pause', undefined);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(controller.getState().stalled).toBe(false);
        expect(controller.getState().lifecycle).toBe('ready');
    });
});

describe('PlayerController — destroy', () => {
    it('tears the engine down and goes inert', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        const destroyed = vi.fn();
        controller.on('destroyed', destroyed);
        controller.destroy();

        expect(destroyed).toHaveBeenCalledTimes(1);
        expect(adapter.destroyed).toBe(true);
        expect(controller.getState().lifecycle).toBe('destroyed');

        await controller.load({ masterUrl: MASTER_URL });
        expect(adapter.loads).toHaveLength(1);
    });

    it('ignores adapter events after destroy', async () => {
        const { adapter, controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        controller.destroy();

        adapter.emit('timeupdate', { currentTime: 999 });
        expect(controller.getState().currentTime).not.toBe(999);
    });
});

describe('PlayerController — encrypted sources', () => {
    it('munges an encrypted session and passes the key in memory', async () => {
        const encrypted: Record<string, RouteBody> = {
            [MASTER_URL]: encryptLmcenc(SIMPLE_MASTER),
            [`${BASE}/stream_1080/playlist.m3u8`]:
                encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
            [`${BASE}/stream_720/playlist.m3u8`]:
                encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
            [`${BASE}/stream_480/playlist.m3u8`]:
                encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
            [`${BASE}/audio_hi_128kbps/playlist.m3u8`]:
                encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
            [`${BASE}/audio_lo_64kbps/playlist.m3u8`]:
                encryptLmcenc(PLAIN_MEDIA_PLAYLIST),
        };
        const { adapter, controller, serveStrategy } = setup(encrypted);
        await controller.load({ masterUrl: MASTER_URL, keyHex: TEST_KEY_HEX });

        expect(controller.getState().lifecycle).toBe('ready');
        expect(adapter.loads[0]).toMatchObject({
            isBlob: true,
            keyHex: TEST_KEY_HEX,
        });
        // Memory key delivery: no key bytes are ever served.
        expect(serveStrategy.contentTypes()).not.toContain(
            'application/octet-stream',
        );
    });

    it('fails with key-required when the key is missing', async () => {
        const { controller } = setup({
            [MASTER_URL]: encryptLmcenc(SIMPLE_MASTER),
        });
        await controller.load({ masterUrl: MASTER_URL });
        expect(controller.getState().error?.code).toBe('key-required');
    });
});

describe('PlayerController — preservePosition across sources', () => {
    it('carries position and play state into the next load', async () => {
        const { adapter, controller } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        adapter.emit('playing', undefined);
        adapter.advanceTo(120);

        await controller.load({
            masterUrl: MASTER_URL,
            preservePosition: true,
        });
        expect(adapter.seeks).toEqual([120]);
        expect(adapter.playCount).toBe(1);
        expect(controller.getState().lifecycle).toBe('ready');
    });
});

/**
 * The warming LOOP belongs to the adapter (`PlayerAdapter.warmChunks`), so
 * what is checked here is the handover: the right chains, fully resolved
 * options, and a stop at every point the source goes away.
 */
describe('PlayerController — chunk warming', () => {
    const chunkedRoutes: Record<string, RouteBody> = {
        ...simpleRoutes,
        [`${BASE}/stream_1080/playlist.m3u8`]: CHUNKED_MEDIA_PLAYLIST,
        [`${BASE}/stream_720/playlist.m3u8`]: CHUNKED_MEDIA_PLAYLIST,
        [`${BASE}/stream_480/playlist.m3u8`]: CHUNKED_MEDIA_PLAYLIST,
    };

    it('hands the adapter the attached chains with every option resolved', async () => {
        const { adapter, controller, fetchImpl } = setup(
            chunkedRoutes,
            {},
            { prefetch: { enabled: true } },
        );
        await controller.load({ masterUrl: MASTER_URL });

        const warmed = adapter.warmCalls.filter(
            (call) => call.schedules.length > 0,
        );
        expect(warmed).toHaveLength(1);
        expect(warmed[0]?.schedules[0]).toEqual([
            { url: `${BASE}/media/v0_0.m4s`, start: 0, end: 8 },
            { url: `${BASE}/media/v0_1.m4s`, start: 8, end: 12 },
        ]);
        // Defaults are applied here, not left for the adapter to guess.
        expect(warmed[0]?.options).toEqual({
            leadSeconds: DEFAULT_LEAD_SECONDS,
            warmBytes: DEFAULT_WARM_BYTES,
            fetchImpl,
        });
    });

    it('passes the host overrides through, log included', async () => {
        const { adapter, controller } = setup(
            chunkedRoutes,
            {},
            {
                prefetch: {
                    enabled: true,
                    leadSeconds: 2,
                    warmBytes: 1024,
                    debug: true,
                },
            },
        );
        await controller.load({ masterUrl: MASTER_URL });

        const warmed = adapter.warmCalls.at(-1);
        expect(warmed?.options.leadSeconds).toBe(2);
        expect(warmed?.options.warmBytes).toBe(1024);
        expect(typeof warmed?.options.log).toBe('function');
    });

    it('stops warming when the source goes away', async () => {
        const { adapter, controller } = setup(
            chunkedRoutes,
            {},
            { prefetch: { enabled: true } },
        );
        await controller.load({ masterUrl: MASTER_URL });
        controller.destroy();

        expect(adapter.warmCalls.at(-1)?.schedules).toEqual([]);
    });

    it('never arms warming when the host switched it off', async () => {
        const { adapter, controller } = setup(
            chunkedRoutes,
            {},
            { prefetch: { enabled: false } },
        );
        await controller.load({ masterUrl: MASTER_URL });

        expect(
            adapter.warmCalls.every((call) => call.schedules.length === 0),
        ).toBe(true);
    });

    it('has nothing to warm in output without byte ranges', async () => {
        const { adapter, controller } = setup(
            simpleRoutes,
            {},
            { prefetch: { enabled: true } },
        );
        await controller.load({ masterUrl: MASTER_URL });

        expect(
            adapter.warmCalls.every((call) => call.schedules.length === 0),
        ).toBe(true);
    });

    it('drives an adapter that implements no warming at all', async () => {
        const { adapter, controller } = setup(
            chunkedRoutes,
            {},
            { prefetch: { enabled: true } },
        );
        adapter.warmChunks = undefined;

        await controller.load({ masterUrl: MASTER_URL });
        expect(controller.getState().lifecycle).toBe('ready');
    });
});

describe('PlayerController — default angle', () => {
    it('pins the master DEFAULT=YES angle rather than leaving ABR free', async () => {
        const { controller, adapter } = setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        expect(controller.getState().activeAngleId).toBe('angle_0');
        expect(adapter.loads[0]?.isBlob).toBe(true);
    });

    it('uses the synthesized Default angle for a single-angle master', async () => {
        const { controller } = setup(simpleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        expect(controller.getState().activeAngleId).toBe(DEFAULT_ANGLE_ID);
    });
});

describe('PlayerController — scrub thumbnails', () => {
    const THUMBS_URL = `${BASE}/thumbnails.vtt`;
    const THUMBS_VTT = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:10.000',
        'sprite_0.jpg#xywh=0,0,160,90',
        '',
        '00:00:10.000 --> 00:00:20.000',
        'sprite_0.jpg#xywh=160,0,160,90',
        '',
    ].join('\n');

    const routes = { ...simpleRoutes, [THUMBS_URL]: THUMBS_VTT };

    it('reports readiness and answers lookups once loaded', async () => {
        const { controller } = setup(routes);

        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { thumbnails: { url: THUMBS_URL } },
        });

        expect(controller.state.thumbnailsReady).toBe(true);
        expect(controller.thumbnailAt(3)).toMatchObject({ x: 0 });
        expect(controller.thumbnailAt(15)).toMatchObject({ x: 160 });
        // Past the last cue there is no frame to show, and guessing one would
        // show a viewer the wrong moment with full confidence.
        expect(controller.thumbnailAt(9999)).toBeNull();
    });

    it('stays quiet and unready when no sidecar is passed', async () => {
        // The common case: audio-only encodes and sessions made with
        // `thumbnails: false` have no VTT, and neither is an error.
        const { controller, errors } = setup(routes);

        await controller.load({ masterUrl: MASTER_URL });

        expect(controller.state.thumbnailsReady).toBe(false);
        expect(controller.thumbnailAt(3)).toBeNull();
        expect(errors).toEqual([]);
    });

    it('does not surface a missing sidecar as an error', async () => {
        const { controller, errors } = setup(routes);

        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { thumbnails: { url: `${BASE}/absent.vtt` } },
        });

        expect(controller.state.thumbnailsReady).toBe(false);
        expect(errors).toEqual([]);
    });

    it("does not carry one source's frames into the next", async () => {
        /*
         * The failure this prevents: load a video with sprites, then load one
         * without, and the scrubber previews frames from the first video —
         * confidently, and at the wrong moments.
         */
        const { controller } = setup(routes);
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { thumbnails: { url: THUMBS_URL } },
        });
        expect(controller.thumbnailAt(3)).not.toBeNull();

        await controller.load({ masterUrl: MASTER_URL });

        expect(controller.state.thumbnailsReady).toBe(false);
        expect(controller.thumbnailAt(3)).toBeNull();
    });
});
