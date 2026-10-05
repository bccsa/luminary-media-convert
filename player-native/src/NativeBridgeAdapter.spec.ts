import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RECOVERY_POLICY,
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
    type PlayerError,
} from '@luminary-media-converter/player-core';
import {
    CHAPTERS_VTT,
    CHUNKED_MEDIA_PLAYLIST,
    ENCRYPTED_MEDIA_PLAYLIST,
    MULTI_ANGLE_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
    SUBTITLE_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    flush,
    makeFetch,
    type RouteBody,
} from '../../player-core/src/test-support/index.js';
import type {
    BridgeCapabilities,
    BridgeEventMap,
    BridgeEventName,
    LoadArgs,
} from './bridge.js';
import { createNativePlayer } from './createNativePlayer.js';
import { FakePlugin } from './test-support/fakePlugin.js';

const BASE = 'https://cdn.example.com/out/session';
const MASTER_URL = `${BASE}/master.m3u8`;
const PLAYER_ID = 'player-1';

function routesFor(master: string, media: string): Record<string, RouteBody> {
    return {
        [MASTER_URL]: master,
        [`${BASE}/stream_1080/playlist.m3u8`]: media,
        [`${BASE}/stream_720/playlist.m3u8`]: media,
        [`${BASE}/stream_480/playlist.m3u8`]: media,
        [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: media,
        [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: media,
    };
}

const simpleRoutes = routesFor(SIMPLE_MASTER, PLAIN_MEDIA_PLAYLIST);

const multiAngleRoutes: Record<string, RouteBody> = {
    [MASTER_URL]: MULTI_ANGLE_MASTER,
    [`${BASE}/angle0_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle0_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle1_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/audio_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/subs_en/playlist.m3u8`]: SUBTITLE_MEDIA_PLAYLIST,
    [`${BASE}/subs_en/en_0.vtt`]: CHAPTERS_VTT,
};

async function setup(
    routes: Record<string, RouteBody> = simpleRoutes,
    capabilities: Partial<BridgeCapabilities> = {},
    prefetch = false,
) {
    const plugin = new FakePlugin(capabilities);
    const fake = makeFetch(routes);
    const reports: string[] = [];
    const { controller, adapter } = await createNativePlayer({
        plugin,
        controller: { fetchImpl: fake.fetchImpl, prefetch: { enabled: prefetch } },
        report: (method) => reports.push(method),
    });
    const errors: PlayerError[] = [];
    controller.on('error', (error) => errors.push(error));

    const loads = () => plugin.argsOf<LoadArgs>('load');
    const currentLoadId = () =>
        plugin.calls
            .filter((call) => call.method === 'load' || call.method === 'reattach')
            .map((call) => (call.args as { loadId: string }).loadId)
            .at(-1)!;
    const emit: FakePlugin['emit'] = (name, ids, payload) => plugin.emit(name, ids, payload);
    const emitNow = <E extends BridgeEventName>(name: E, payload: BridgeEventMap[E]) =>
        plugin.emit(name, { playerId: PLAYER_ID, loadId: currentLoadId() }, payload);

    return { plugin, controller, adapter, reports, errors, loads, currentLoadId, emit, emitNow };
}

describe('NativeBridgeAdapter — load', () => {
    it('sends the munged master and its media playlists inline, in one generation', async () => {
        const { controller, plugin, loads } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        const [load] = loads();
        expect(load).toMatchObject({
            playerId: PLAYER_ID,
            generation: 1,
            recovery: DEFAULT_RECOVERY_POLICY,
        });
        expect(load!.keyHex).toBeUndefined();
        // The master plus three video and two audio playlists.
        expect(load!.assets).toHaveLength(6);
        expect(load!.assets.every((asset) => asset.uri.startsWith('luminary://asset/1/'))).toBe(true);
        expect(load!.assets.every((asset) => asset.contentType === PLAYLIST_CONTENT_TYPE)).toBe(true);
        const master = load!.assets.find((asset) => asset.uri === load!.masterUri);
        expect(master?.text).toContain('#EXT-X-STREAM-INF');
        // Generation 0 never reached native, so there was nothing to release.
        expect(plugin.methods()).toEqual(['getInfo', 'reset', 'create', 'load']);
    });

    it('hands over the key and delivers it from memory, never as an asset', async () => {
        const { controller, loads } = await setup(
            routesFor(SIMPLE_MASTER, ENCRYPTED_MEDIA_PLAYLIST),
        );
        await controller.load({ masterUrl: MASTER_URL, keyHex: TEST_KEY_HEX });

        const [load] = loads();
        expect(load!.keyHex).toBe(TEST_KEY_HEX);
        const media = load!.assets.filter((asset) => asset.uri !== load!.masterUri);
        expect(media.every((asset) => asset.text.includes('URI="luminary://key"'))).toBe(true);
    });

    it('sends only what is new on an angle switch within the generation', async () => {
        const { controller, loads, plugin } = await setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });

        await controller.setAngle('angle_1');
        await controller.setAngle('angle_0');

        const [first, second, third] = loads();
        expect(new Set([first!.generation, second!.generation, third!.generation])).toEqual(
            new Set([1]),
        );
        // A new master, and the one playlist angle_1 adds.
        expect(second!.assets.map((asset) => asset.uri)).toHaveLength(2);
        expect(second!.assets.map((asset) => asset.uri)).toContain(second!.masterUri);
        // Back to an angle already served: only the master is new.
        expect(third!.assets.map((asset) => asset.uri)).toEqual([third!.masterUri]);
        expect(plugin.methods()).not.toContain('releaseAssets');
    });

    it('releases the previous generation before loading the next source', async () => {
        const { controller, loads, plugin } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        await controller.load({ masterUrl: MASTER_URL });

        const methods = plugin.methods().filter((method) => method !== 'seek');
        expect(methods.slice(3)).toEqual(['load', 'releaseAssets', 'load']);
        expect(plugin.argsOf('releaseAssets')).toEqual([{ playerId: PLAYER_ID, generation: 1 }]);
        const second = loads()[1]!;
        expect(second.generation).toBe(2);
        expect(second.assets.every((asset) => asset.uri.startsWith('luminary://asset/2/'))).toBe(true);
    });

    it('never sends side-loaded subtitles, which native cannot render', async () => {
        const vttUrl = `${BASE}/subtitles/fr.vtt`;
        const { controller, loads, plugin } = await setup({
            ...multiAngleRoutes,
            [vttUrl]: CHAPTERS_VTT,
        });
        await controller.load({
            masterUrl: MASTER_URL,
            sidecars: { subtitles: [{ lang: 'fr', label: 'Français', url: vttUrl }] },
        });
        await flush();
        await controller.setAngle('angle_1');

        const sent = loads().flatMap((load) => load.assets);
        expect(sent.some((asset) => asset.contentType === VTT_CONTENT_TYPE)).toBe(false);
        expect(plugin.methods()).not.toContain('putAssets');
    });

    it('surfaces a rejected load as a failed load', async () => {
        const { controller, plugin } = await setup();
        plugin.failWith('load', 'engine');
        await controller.load({ masterUrl: MASTER_URL });

        expect(controller.getState().lifecycle).toBe('error');
    });
});

describe('NativeBridgeAdapter — events', () => {
    it('feeds the controller from the current load only', async () => {
        const { controller, emit, emitNow, currentLoadId } = await setup(multiAngleRoutes);
        await controller.load({ masterUrl: MASTER_URL });
        const firstLoadId = currentLoadId();
        await controller.setAngle('angle_1');

        emitNow('timeupdate', { currentTime: 12 });
        emit('timeupdate', { playerId: PLAYER_ID, loadId: firstLoadId }, { currentTime: 99 });
        emit('timeupdate', { playerId: 'player-2', loadId: currentLoadId() }, { currentTime: 77 });

        expect(controller.getState().currentTime).toBe(12);
    });

    it('reads an unbounded duration off the wire as Infinity', async () => {
        const { controller, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        emitNow('durationchange', { duration: null });
        expect(controller.getState().duration).toBe(Infinity);
        emitNow('durationchange', { duration: 120 });
        expect(controller.getState().duration).toBe(120);
    });

    it('passes play state, buffering and stalls through', async () => {
        const { controller, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        emitNow('playing', {});
        emitNow('progress', { bufferedEnd: 30 });
        emitNow('stalled', { stalled: true });
        expect(controller.getState()).toMatchObject({
            playing: true,
            bufferedEnd: 30,
            stalled: true,
        });
        emitNow('pause', {});
        expect(controller.getState()).toMatchObject({ playing: false, stalled: false });
    });

    it('ends playback on a fatal error, and ignores a non-fatal one', async () => {
        const { controller, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        emitNow('error', { category: 'network', fatal: false, code: 'timeout', message: 'slow' });
        expect(controller.getState().lifecycle).toBe('ready');

        emitNow('error', { category: 'media', fatal: true, code: 'decode', message: 'bad frame' });
        expect(controller.getState()).toMatchObject({
            lifecycle: 'error',
            error: { code: 'media', fatal: true },
        });
    });

    it('rebuilds the munged source when native asks', async () => {
        const { controller, emitNow, loads } = await setup();
        const recovered: number[] = [];
        controller.on('recovered', ({ attempt }) => recovered.push(attempt));
        await controller.load({ masterUrl: MASTER_URL });

        emitNow('reload-requested', { reason: 'fatal', attempt: 2 });
        await flush();

        const [, again] = loads();
        expect(again!.generation).toBe(1);
        expect(again!.assets.map((asset) => asset.uri)).toEqual([again!.masterUri]);
        expect(recovered).toEqual([2]);
    });
});

describe('NativeBridgeAdapter — audio tracks', () => {
    const tracks = [
        { id: 'en', lang: 'en', label: 'English' },
        { id: 'fr', lang: 'fr', label: 'Français' },
    ];

    it('reports no tracks from a load until native lists the new ones', async () => {
        const { controller, adapter, plugin, emitNow } = await setup();
        let announced = 0;
        adapter.on('audiotracks-updated', () => announced++);
        await controller.load({ masterUrl: MASTER_URL });

        expect(announced).toBe(1);
        expect(adapter.getAudioTracks()).toEqual([]);
        adapter.setAudioTrack('fr');
        expect(plugin.methods()).not.toContain('setAudioTrack');

        emitNow('audiotracks-updated', { tracks, activeId: 'en' });
        controller.setAudioTrack('fr');
        expect(plugin.argsOf('setAudioTrack')).toEqual([{ playerId: PLAYER_ID, id: 'fr' }]);
    });

    it('hands a chosen track back after a reattach', async () => {
        const { controller, adapter, plugin, emitNow, currentLoadId } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        emitNow('audiotracks-updated', { tracks, activeId: 'en' });
        controller.setAudioTrack('fr');
        const before = currentLoadId();

        await adapter.reattach();
        expect(currentLoadId()).not.toBe(before);
        expect(plugin.argsOf('reattach')).toEqual([{ playerId: PLAYER_ID, loadId: currentLoadId() }]);

        emitNow('audiotracks-updated', { tracks, activeId: 'en' });
        await flush();
        expect(plugin.argsOf('setAudioTrack')).toEqual([
            { playerId: PLAYER_ID, id: 'fr' },
            { playerId: PLAYER_ID, id: 'fr' },
        ]);
    });

    it('does not reattach before anything is loaded', async () => {
        const { adapter, plugin } = await setup();
        await adapter.reattach();
        expect(plugin.methods()).not.toContain('reattach');
    });
});

describe('NativeBridgeAdapter — viewer choices', () => {
    const tracks = [
        { id: 'en', lang: 'en', label: 'English' },
        { id: 'fr', lang: 'fr', label: 'Français' },
    ];

    it('takes the default of a new list for nobody\'s choice', async () => {
        const { controller, adapter, plugin, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        emitNow('audiotracks-updated', { tracks, activeId: 'en' });
        controller.setAudioTrack('fr');
        emitNow('audiotracks-updated', { tracks, activeId: 'fr' });

        await adapter.reattach();
        emitNow('audiotracks-updated', { tracks, activeId: 'en' });
        await flush();

        expect(controller.getState().activeAudioTrackId).toBe('fr');
        expect(plugin.argsOf('setAudioTrack').at(-1)).toEqual({ playerId: PLAYER_ID, id: 'fr' });
    });

    it('lets a rejected call go, so the viewer\'s next pick still counts', async () => {
        const { controller, plugin, reports, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        plugin.failWith('setRate', 'unknown-player');
        controller.setPlaybackRate(2);
        await flush();
        expect(reports).toEqual(['setRate']);

        emitNow('ratechange', { rate: 1.5 });
        expect(controller.getState().playbackRate).toBe(1.5);
    });

    it('takes a rate native reports for the outgoing load as the answer it was waiting for', async () => {
        const { controller, plugin, currentLoadId, emit, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        const outgoing = currentLoadId();
        controller.setPlaybackRate(2);
        await controller.load({ masterUrl: MASTER_URL });
        emit('ratechange', { playerId: PLAYER_ID, loadId: outgoing }, { rate: 2 });

        // The viewer's own pick, in native full-screen, counts again.
        emitNow('ratechange', { rate: 1.5 });
        expect(controller.getState().playbackRate).toBe(1.5);
        expect(plugin.argsOf('setRate')).toHaveLength(1);
    });

    it('drops what it was waiting for once native has answered a resume', async () => {
        const { controller, adapter, plugin, currentLoadId, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        controller.setPlaybackRate(2);
        plugin.resumeResult = {
            loadId: currentLoadId(),
            snapshot: { currentTime: 0, duration: 120, bufferedEnd: 0, playing: false },
        };

        // The answer to setRate was lost while JavaScript was suspended.
        await adapter.resume();
        emitNow('ratechange', { rate: 1.5 });
        expect(controller.getState().playbackRate).toBe(1.5);
    });

    it('stops relaying once destroyed', async () => {
        const { controller, adapter, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        const choices: unknown[] = [];
        adapter.onViewerChoice((choice) => choices.push(choice));

        emitNow('ratechange', { rate: 1.5 });
        adapter.destroy();
        emitNow('ratechange', { rate: 2 });
        expect(choices).toEqual([{ kind: 'rate', rate: 1.5 }]);
    });
});

describe('NativeBridgeAdapter — capabilities', () => {
    it('declines variant pinning and warming when native does', async () => {
        const { adapter, plugin } = await setup();
        expect(adapter.capabilities).toEqual({
            nativeHls: false,
            keyDelivery: 'memory',
            variantSwitching: false,
            renderText: false,
        });
        expect(adapter.warmChunks).toBeUndefined();
        adapter.setVariant('720');
        expect(plugin.methods()).not.toContain('setVariant');
    });

    it('pins a rendition through native when it can', async () => {
        const { controller, plugin, emitNow } = await setup(simpleRoutes, { variantSwitching: true });
        await controller.load({ masterUrl: MASTER_URL });

        emitNow('variants-updated', {
            variants: [
                { id: 'v0', height: 1080, bandwidth: 5_000_000 },
                { id: 'v1', height: 720, bandwidth: 2_500_000 },
            ],
        });
        expect(controller.getState().qualities.map((quality) => quality.id)).toEqual(['1080', '720']);
        controller.setQuality('720');
        expect(plugin.argsOf('setVariant')).toEqual([{ playerId: PLAYER_ID, id: 'v1' }]);
    });

    it('hands the warming schedules to native with the load they belong to', async () => {
        const { controller, plugin, currentLoadId } = await setup(
            routesFor(SIMPLE_MASTER, CHUNKED_MEDIA_PLAYLIST),
            { chunkWarming: true },
            true,
        );
        await controller.load({ masterUrl: MASTER_URL });

        const warms = plugin.argsOf<{ loadId: string; schedules: unknown[]; leadSeconds: number }>(
            'warmChunks',
        );
        const last = warms.at(-1)!;
        expect(last.loadId).toBe(currentLoadId());
        expect(last.schedules.length).toBeGreaterThan(0);
        expect(last.leadSeconds).toBe(60);
    });
});

describe('NativeBridgeAdapter — transport', () => {
    it('answers the position from the mirror as soon as a seek is asked', async () => {
        const { controller, adapter, plugin } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        controller.seek(42);
        expect(adapter.getCurrentTime()).toBe(42);
        expect(plugin.argsOf('seek').at(-1)).toEqual({ playerId: PLAYER_ID, position: 42 });
    });

    it('reports a failed fire-and-forget call instead of throwing it', async () => {
        const { controller, plugin, reports } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        plugin.failWith('pause', 'unknown-player');

        controller.pause();
        await flush();
        expect(reports).toEqual(['pause']);
    });
});

describe('NativeBridgeAdapter — resume', () => {
    it('re-emits the snapshot, then the reload native held', async () => {
        const { controller, adapter, plugin, currentLoadId, loads } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        plugin.resumeResult = {
            loadId: currentLoadId(),
            snapshot: { currentTime: 42, duration: 120, bufferedEnd: 50, playing: true },
            pendingReload: { reason: 'wedged', attempt: 1 },
        };

        await adapter.resume();
        expect(controller.getState()).toMatchObject({
            currentTime: 42,
            duration: 120,
            bufferedEnd: 50,
            playing: true,
        });
        await flush();
        expect(loads()).toHaveLength(2);
    });

    it('asks native once for signals that arrive together', async () => {
        const { controller, adapter, plugin, currentLoadId } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        plugin.resumeResult = {
            loadId: currentLoadId(),
            snapshot: { currentTime: 0, duration: 0, bufferedEnd: 0, playing: false },
        };

        await Promise.all([adapter.resume(), adapter.resume()]);
        expect(plugin.argsOf('resumed')).toHaveLength(1);
    });

    it('ignores an answer about an older load', async () => {
        const { controller, adapter, plugin } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        plugin.resumeResult = {
            loadId: 'load-0',
            snapshot: { currentTime: 42, duration: 120, bufferedEnd: 50, playing: true },
        };

        await adapter.resume();
        expect(controller.getState().currentTime).toBe(0);
    });
});

describe('NativeBridgeAdapter — destroy', () => {
    it('releases the generation, destroys the native player and stops listening', async () => {
        const { controller, plugin, emitNow } = await setup();
        await controller.load({ masterUrl: MASTER_URL });

        controller.destroy();
        await flush();

        expect(plugin.methods().slice(-2)).toEqual(['releaseAssets', 'destroy']);
        expect(plugin.listenerCount()).toBe(0);
        expect(() => emitNow('timeupdate', { currentTime: 5 })).not.toThrow();
    });

    it('still destroys the native player when a host teardown throws', async () => {
        const { controller, adapter, plugin, reports } = await setup();
        await controller.load({ masterUrl: MASTER_URL });
        adapter.onDestroy(() => {
            throw new TypeError('handle.then is not a function');
        });

        controller.destroy();
        await flush();

        expect(plugin.methods().slice(-2)).toEqual(['releaseAssets', 'destroy']);
        expect(plugin.listenerCount()).toBe(0);
        expect(reports).toEqual(['destroy']);
    });
});
