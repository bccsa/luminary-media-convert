import { describe, expect, it } from 'vitest';
import {
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
} from '@luminary-media-converter/player-core';
import { AssetBatch } from './assetBatch.js';
import { NativeServeStrategy } from './NativeServeStrategy.js';
import { FakePlugin } from './test-support/fakePlugin.js';

function setup({ live = false } = {}) {
    const plugin = new FakePlugin();
    const batch = new AssetBatch();
    const reports: string[] = [];
    const strategy = new NativeServeStrategy({
        plugin,
        playerId: 'player-1',
        batch,
        live,
        report: (method) => reports.push(method),
    });
    return { plugin, batch, strategy, reports };
}

describe('NativeServeStrategy', () => {
    it('mints asset addresses in the current generation, by content type', () => {
        const { batch, strategy } = setup();
        strategy.release();

        const playlist = strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
        const vtt = strategy.serve('WEBVTT\n', VTT_CONTENT_TYPE);

        expect(playlist).toBe('luminary://asset/1/1.m3u8');
        expect(vtt).toBe('luminary://asset/1/2.vtt');
        expect(batch.take()).toEqual([
            { uri: playlist, contentType: PLAYLIST_CONTENT_TYPE, text: '#EXTM3U\n' },
            { uri: vtt, contentType: VTT_CONTENT_TYPE, text: 'WEBVTT\n' },
        ]);
    });

    it('never reuses an address, across generations either', () => {
        const { strategy } = setup();
        const first = strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
        strategy.release();
        const second = strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);

        expect(first).toBe('luminary://asset/0/1.m3u8');
        expect(second).toBe('luminary://asset/1/2.m3u8');
    });

    it('refuses bytes, and content types the bridge has no extension for', () => {
        const { strategy } = setup();
        expect(() =>
            strategy.serve(new Uint8Array(16), 'application/octet-stream'),
        ).toThrow(/text only/);
        expect(() => strategy.serve('{}', 'application/json')).toThrow(
            /cannot serve application\/json/,
        );
    });

    it('releases a generation on native only once native has received it', () => {
        const { plugin, batch, strategy } = setup();
        strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
        strategy.release();
        expect(plugin.methods()).toEqual([]);

        strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
        batch.take();
        strategy.release();
        expect(plugin.argsOf('releaseAssets')).toEqual([
            { playerId: 'player-1', generation: 1 },
        ]);
    });

    it('drops the pending assets of a released generation', () => {
        const { batch, strategy } = setup();
        strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
        strategy.release();
        expect(batch.take()).toEqual([]);
    });

    it('reports a failed release rather than throwing it', async () => {
        const { plugin, batch, strategy, reports } = setup();
        plugin.failWith('releaseAssets', 'unknown-player');
        batch.take();
        strategy.release();
        await Promise.resolve();
        await Promise.resolve();
        expect(reports).toEqual(['releaseAssets']);
    });

    describe('live', () => {
        const spec = {
            url: 'https://live.example.com/channel/chunks.m3u8',
            baseUrl: 'https://live.example.com/channel/chunks.m3u8',
            keyUri: 'luminary://key',
            keyBytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
            refreshSec: 4,
        };

        it('offers no serveLive unless native reports live', () => {
            expect(setup().strategy.serveLive).toBeUndefined();
            expect(setup({ live: true }).strategy.serveLive).toBeTypeOf('function');
        });

        it('registers the spec with native at once, its key as hex, under a fresh address', () => {
            const { plugin, strategy } = setup({ live: true });
            strategy.release();
            const asset = strategy.serve('#EXTM3U\n', PLAYLIST_CONTENT_TYPE);
            const live = strategy.serveLive!(spec);

            expect(asset).toBe('luminary://asset/1/1.m3u8');
            expect(live).toBe('luminary://live/2');
            expect(plugin.argsOf('putLive')).toEqual([
                {
                    playerId: 'player-1',
                    generation: 1,
                    uri: live,
                    spec: {
                        url: spec.url,
                        baseUrl: spec.baseUrl,
                        keyUri: 'luminary://key',
                        keyHex: '000102030405060708090a0b0c0d0e0f',
                        refreshSec: 4,
                    },
                },
            ]);
        });

        it('releases a generation whose only delivery was a live spec', () => {
            const { plugin, strategy } = setup({ live: true });
            strategy.serveLive!({ ...spec, keyUri: undefined, keyBytes: undefined });
            strategy.release();
            expect(plugin.argsOf('releaseAssets')).toEqual([
                { playerId: 'player-1', generation: 0 },
            ]);
        });

        it('reports a failed putLive rather than throwing it', async () => {
            const { plugin, strategy, reports } = setup({ live: true });
            plugin.failWith('putLive', 'unsupported');
            strategy.serveLive!(spec);
            await Promise.resolve();
            await Promise.resolve();
            expect(reports).toEqual(['putLive']);
        });
    });
});
