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

describe('mergeWaveMasters — codecs the encoder vouches for', () => {
    // The ladder that surfaced the gap, as ffmpeg wrote it: five renditions on
    // two audio groups, split into waves of three, so the bandwidth-saving
    // group is referenced only by the wave that carried no audio. Its variants
    // came back with neither AUDIO= nor an audio codec, and no first-wave
    // variant had ever named that group's codec for the merge to learn.
    const header = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_mid",NAME="eng",DEFAULT=YES,LANGUAGE="eng",CHANNELS="1",URI="stream_mid_Standard/playlist.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_low",NAME="eng",DEFAULT=YES,LANGUAGE="eng",CHANNELS="1",URI="stream_low_Bandwidth_Saving/playlist.m3u8"',
    ];
    const waveOne = [
        ...header,
        '#EXT-X-STREAM-INF:BANDWIDTH=2555112,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_mid"',
        'stream_720p_1280x720/playlist.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=615606,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_mid"',
        'stream_360p_640x360/playlist.m3u8',
        '',
    ].join('\n');
    const waveTwo = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-STREAM-INF:BANDWIDTH=307656,RESOLUTION=426x240,CODECS="avc1.640015"',
        'stream_240p_426x240/playlist.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=155230,RESOLUTION=256x144,CODECS="avc1.64000c"',
        'stream_144p_256x144/playlist.m3u8',
        '',
    ].join('\n');

    const groupFor = (uri: string) =>
        ({
            stream_720p_1280x720: 'mid',
            stream_360p_640x360: 'mid',
            stream_240p_426x240: 'low',
            stream_144p_256x144: 'low',
        })[uri.split('/')[0]];

    const encoderSays = (id: string) =>
        ({ mid: ['mp4a.40.2'], low: ['mp4a.40.2'] })[id];

    const variantLine = (merged: string, resolution: string) =>
        merged.split('\n').find((l) => l.includes(`RESOLUTION=${resolution}`))!;

    it('vouches for a group no first-wave variant names', () => {
        const merged = mergeWaveMasters(
            [waveOne, waveTwo],
            groupFor,
            encoderSays
        );

        expect(variantLine(merged, '426x240')).toContain(
            'CODECS="avc1.640015,mp4a.40.2",AUDIO="group_low"'
        );
        expect(variantLine(merged, '256x144')).toContain(
            'CODECS="avc1.64000c,mp4a.40.2",AUDIO="group_low"'
        );
    });

    it('is, without that knowledge, the defect the fix is for', () => {
        // Pinned so the gap stays visible: the group is restored, the codec is
        // not, and a player that counts codecs refuses the variant.
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor);

        expect(variantLine(merged, '426x240')).toContain(
            'CODECS="avc1.640015",AUDIO="group_low"'
        );
    });

    it('leaves the first wave exactly as ffmpeg wrote it', () => {
        const merged = mergeWaveMasters(
            [waveOne, waveTwo],
            groupFor,
            encoderSays
        );

        expect(variantLine(merged, '1280x720')).toBe(
            variantLine(waveOne, '1280x720')
        );
        expect(variantLine(merged, '640x360')).toBe(
            variantLine(waveOne, '640x360')
        );
    });

    it("prefers what a first-wave variant declared over the encoder's answer", () => {
        // ffmpeg read its codec off the stream it wrote; that word wins.
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor, (id) =>
            id === 'mid' ? ['mp4a.40.5'] : encoderSays(id)
        );

        expect(variantLine(merged, '1280x720')).toContain('mp4a.40.2');
        expect(variantLine(merged, '1280x720')).not.toContain('mp4a.40.5');
    });

    it('completes a variant that kept its group but lost its audio codec', () => {
        const keptGroup = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=307656,RESOLUTION=426x240,CODECS="avc1.640015",AUDIO="group_low"',
            'stream_240p_426x240/playlist.m3u8',
            '',
        ].join('\n');

        const merged = mergeWaveMasters(
            [waveOne, keptGroup],
            groupFor,
            encoderSays
        );

        expect(variantLine(merged, '426x240')).toContain(
            'CODECS="avc1.640015,mp4a.40.2",AUDIO="group_low"'
        );
        expect(variantLine(merged, '426x240').match(/AUDIO=/g)).toHaveLength(1);
    });

    it('adds nothing a variant already lists', () => {
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor, (id) =>
            id === 'mid' ? ['mp4a.40.2'] : encoderSays(id)
        );

        expect(
            variantLine(merged, '640x360').match(/mp4a\.40\.2/g)
        ).toHaveLength(1);
    });

    it('adds nothing to a variant that carries no CODECS attribute at all', () => {
        // ffmpeg drops the whole attribute when it cannot name a codec; a
        // playlist with no CODECS is degraded, not wrong, and is left alone.
        const bare = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=307656,RESOLUTION=426x240',
            'stream_240p_426x240/playlist.m3u8',
            '',
        ].join('\n');

        const merged = mergeWaveMasters([waveOne, bare], groupFor, encoderSays);

        expect(variantLine(merged, '426x240')).toBe(
            '#EXT-X-STREAM-INF:BANDWIDTH=307656,RESOLUTION=426x240,AUDIO="group_low"'
        );
    });

    it('leaves a group nobody can vouch for as it was', () => {
        // A copy-mode group whose init could not be read: the group comes
        // back, the codec does not, and no codec is invented to fill the gap.
        const merged = mergeWaveMasters([waveOne, waveTwo], groupFor, (id) =>
            id === 'mid' ? ['mp4a.40.2'] : undefined
        );

        expect(variantLine(merged, '426x240')).toContain(
            'CODECS="avc1.640015",AUDIO="group_low"'
        );
    });

    it('still attaches exactly one AUDIO attribute to every variant', () => {
        const merged = mergeWaveMasters(
            [waveOne, waveTwo],
            groupFor,
            encoderSays
        );

        for (const line of merged.split('\n')) {
            if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
            expect(line.match(/AUDIO=/g)).toHaveLength(1);
        }
    });
});
