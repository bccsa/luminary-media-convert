import { describe, expect, it } from 'vitest';
import {
    mergeWaveMasters,
    planLadderWaves,
    waveMasterName,
} from './ladder-waves';
import type { VideoRenditionDto } from '../dto/encode-config.dto.js';

function rendition(
    height: number,
    overrides: Partial<VideoRenditionDto> = {}
): VideoRenditionDto {
    return {
        width: (height * 16) / 9,
        height,
        videoBitrateKbps: height * 3,
        copyStream: false,
        audioGroupId: 'hd',
        label: `${height}p`,
        ...overrides,
    } as VideoRenditionDto;
}

describe('planLadderWaves', () => {
    it('leaves a ladder that fits the cap as one run writing master.m3u8', () => {
        const renditions = [rendition(1080), rendition(720), rendition(480)];

        const waves = planLadderWaves(renditions, 3);

        // The single-wave plan has to stay byte-identical to the behaviour that
        // predates waves — no merge step, no renamed master.
        expect(waves).toHaveLength(1);
        expect(waves[0].masterName).toBe('master.m3u8');
        expect(waves[0].renditions).toEqual(renditions);
        expect(waves[0].includeAudio).toBe(true);
        expect(waves[0].sessionCount).toBe(3);
    });

    it('splits a ladder past the cap into waves of at most the cap', () => {
        const renditions = [
            rendition(2160),
            rendition(1440),
            rendition(1080),
            rendition(720),
            rendition(480),
            rendition(360),
        ];

        const waves = planLadderWaves(renditions, 3);

        expect(waves).toHaveLength(2);
        expect(waves.map((w) => w.sessionCount)).toEqual([3, 3]);
        expect(waves[0].renditions.map((r) => r.height)).toEqual([
            2160, 1440, 1080,
        ]);
        expect(waves[1].renditions.map((r) => r.height)).toEqual([
            720, 480, 360,
        ]);
    });

    it('never plans a wave that would exceed the cap', () => {
        for (let count = 1; count <= 12; count++) {
            const renditions = Array.from({ length: count }, (_, i) =>
                rendition(360 + i)
            );
            for (const cap of [1, 2, 3, 5]) {
                const waves = planLadderWaves(renditions, cap);
                for (const wave of waves) {
                    expect(wave.sessionCount).toBeLessThanOrEqual(cap);
                }
                // Every rendition is encoded exactly once.
                expect(waves.reduce((n, w) => n + w.sessionCount, 0)).toBe(
                    count
                );
            }
        }
    });

    it('gives audio to the first wave only', () => {
        const waves = planLadderWaves(
            Array.from({ length: 5 }, (_, i) => rendition(360 + i)),
            2
        );

        expect(waves.map((w) => w.includeAudio)).toEqual([true, false, false]);
    });

    it('names every wave after the first so their masters do not collide', () => {
        const waves = planLadderWaves(
            Array.from({ length: 6 }, (_, i) => rendition(360 + i)),
            2
        );

        expect(waves.map((w) => w.masterName)).toEqual([
            waveMasterName(0),
            waveMasterName(1),
            waveMasterName(2),
        ]);
        expect(new Set(waves.map((w) => w.masterName)).size).toBe(3);
    });

    it('rides copy-stream renditions along without counting them', () => {
        const copy = rendition(1080, { copyStream: true, label: 'source' });
        const renditions = [
            copy,
            rendition(720),
            rendition(480),
            rendition(360),
        ];

        const waves = planLadderWaves(renditions, 2);

        // Copying opens no encoder, so it costs no session and belongs wherever
        // it is cheapest — the first run, which is happening anyway.
        expect(waves.map((w) => w.sessionCount)).toEqual([2, 1]);
        expect(waves[0].renditions).toContain(copy);
        expect(waves[1].renditions).not.toContain(copy);
    });

    it('treats a nonsensical cap as one rendition per wave rather than looping', () => {
        const renditions = [rendition(720), rendition(480)];

        expect(planLadderWaves(renditions, 0)).toHaveLength(2);
        expect(planLadderWaves(renditions, -5)).toHaveLength(2);
    });
});

describe('mergeWaveMasters', () => {
    // Taken from a real two-wave encode, not hand-written: the HLS muxer renames
    // an agroup of `hd` to GROUP-ID="group_hd", which a fixture that echoed the
    // config's own id would have hidden.
    const waveOne = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd",NAME="audio_3",DEFAULT=YES,CHANNELS="2",URI="stream_hd_128/playlist.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=24520,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_hd"',
        'stream_1080p_640x360/playlist.m3u8',
        '',
    ].join('\n');

    // No AUDIO and no audio codec: this run was given no audio streams, so
    // ffmpeg had neither a group to point at nor a codec to declare.
    const waveTwo = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-STREAM-INF:BANDWIDTH=15373,RESOLUTION=256x144,CODECS="avc1.64000c"',
        'stream_360p_256x144/playlist.m3u8',
        '',
    ].join('\n');

    const groupFor = (uri: string) =>
        ({
            stream_1080p_640x360: 'hd',
            stream_360p_256x144: 'hd',
        })[uri.split('/')[0]];

    const variantLine = (merged: string, resolution: string) =>
        merged.split('\n').find((l) => l.includes(`RESOLUTION=${resolution}`))!;

    it('keeps the audio rendition declarations from the wave that encoded them', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(merged).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_hd"');
        expect(merged.match(/#EXT-X-MEDIA:/g)).toHaveLength(1);
    });

    it('carries every variant through, in ladder order', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(merged.indexOf('stream_1080p')).toBeLessThan(
            merged.indexOf('stream_360p')
        );
        expect(merged.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(2);
    });

    it('points a later wave at the group ffmpeg declared, not the config id', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        // AUDIO="hd" would name a group that appears nowhere in the playlist,
        // and the rendition would play silent.
        expect(variantLine(merged, '256x144')).toContain('AUDIO="group_hd"');
        expect(merged).not.toContain('AUDIO="hd"');
    });

    it('adds the audio codec a run without audio could not declare', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(variantLine(merged, '256x144')).toContain(
            'CODECS="avc1.64000c,mp4a.40.2"'
        );
    });

    it('resolves a group whose declared id needs no renaming', () => {
        const plain = waveOne.replace(/group_hd/g, 'hd');

        const merged = mergeWaveMasters([plain, waveTwo], groupFor);

        expect(variantLine(merged, '256x144')).toContain('AUDIO="hd"');
    });

    it('does not add a second AUDIO attribute to a variant that has one', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(variantLine(merged, '640x360').match(/AUDIO=/g)).toHaveLength(1);
    });

    it('leaves a variant alone when the ladder has no group for it', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], () => undefined);

        expect(variantLine(merged, '256x144')).not.toContain('AUDIO=');
        expect(variantLine(merged, '256x144')).toContain(
            'CODECS="avc1.64000c"'
        );
    });

    it('leaves a variant alone when its group was never declared', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], () => 'sd');

        expect(variantLine(merged, '256x144')).not.toContain('AUDIO=');
    });

    it('emits one header, not one per wave', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(merged.match(/#EXTM3U/g)).toHaveLength(1);
        expect(merged.match(/#EXT-X-VERSION/g)).toHaveLength(1);
        expect(merged.startsWith('#EXTM3U\n')).toBe(true);
    });
});
