import { describe, expect, it } from 'vitest';
import {
    listVideoAngles as listAnglesInPlayer,
    parseMasterPlaylist,
} from '@luminary-media-converter/hls-core';
import {
    addVideoAngleLines,
    angleGroupId,
    listVideoAngles,
    rewriteVideoAngles,
    type AddedAngleVariant,
} from './video-angles.js';

const SINGLE = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,URI="stream_English_192kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5128000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE',
    'stream_0_1920x1080/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2628000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE',
    'stream_1_1280x720/playlist.m3u8',
    '',
].join('\n');

const MULTI = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="Main Camera",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="Pulpit",DEFAULT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=4177777,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",VIDEO="main",AUDIO="group_tier_0"',
    'stream_main_1280x720/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1868063,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",VIDEO="pulpit",AUDIO="group_tier_0"',
    'stream_pulpit_854x480/playlist.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,RESOLUTION=1280x720,CODECS="avc1.640028",VIDEO="main",URI="stream_main_1280x720/iframes.m3u8"',
    '',
].join('\n');

const AUDIO_ONLY = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="a"',
    'stream_English/playlist.m3u8',
    '',
].join('\n');

const variant = (
    referenceUri: string,
    uri: string,
    resolution: string
): AddedAngleVariant => ({
    referenceUri,
    uri,
    bandwidth: 3000000,
    averageBandwidth: 2800000,
    resolution,
    frameRate: 29.97,
    codecs: 'avc1.640028,mp4a.40.2',
});

describe('listVideoAngles', () => {
    it('lists a single picture as one unnamed angle', () => {
        expect(listVideoAngles(parseMasterPlaylist(SINGLE))).toEqual([
            { id: '', name: '', default: true, renditions: 2 },
        ]);
    });

    it('lists each video group with its variant count', () => {
        expect(listVideoAngles(parseMasterPlaylist(MULTI))).toEqual([
            { id: 'main', name: 'Main Camera', default: true, renditions: 1 },
            { id: 'pulpit', name: 'Pulpit', default: false, renditions: 1 },
        ]);
    });

    it('lists no angle for an audio-only video', () => {
        expect(listVideoAngles(parseMasterPlaylist(AUDIO_ONLY))).toEqual([]);
    });
});

describe('angleGroupId', () => {
    it('derives the id as the encoder does, and keeps it unique', () => {
        const taken = new Set(['main']);
        expect(angleGroupId('Main', taken)).toBe('Main');
        expect(angleGroupId('main', taken)).toBe('main_2');
        expect(angleGroupId('Côté gauche', taken)).toBe('C_t_gauche');
        expect(angleGroupId('***', taken)).toBe('angle');
    });
});

describe('addVideoAngleLines', () => {
    it('gives a single-picture video angles: the picture is named and stays the default', () => {
        const out = addVideoAngleLines(
            SINGLE,
            { name: 'Pulpit', mainName: 'Stage' },
            [
                variant(
                    'stream_0_1920x1080/playlist.m3u8',
                    'stream_addab_0_Pulpit_1080p/playlist.m3u8',
                    '1920x1080'
                ),
                variant(
                    'stream_1_1280x720/playlist.m3u8',
                    'stream_addab_1_Pulpit_720p/playlist.m3u8',
                    '1280x720'
                ),
            ]
        );
        const lines = out.split('\n');
        expect(lines).toContain(
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Stage",NAME="Stage",DEFAULT=YES'
        );
        expect(lines).toContain(
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Pulpit",NAME="Pulpit",DEFAULT=NO'
        );
        // The existing variants name the main angle and keep everything else.
        expect(lines[6]).toBe(
            '#EXT-X-STREAM-INF:BANDWIDTH=5128000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE,VIDEO="Stage"'
        );
        // The new ones take their audio and captions from the variant beside them.
        expect(out).toContain(
            '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2800000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE,VIDEO="Pulpit"\nstream_addab_1_Pulpit_720p/playlist.m3u8'
        );
        expect(out.endsWith('stream_addab_1_Pulpit_720p/playlist.m3u8\n')).toBe(
            true
        );

        const parsed = parseMasterPlaylist(out);
        expect(listVideoAngles(parsed).map((a) => a.name)).toEqual([
            'Stage',
            'Pulpit',
        ]);
        expect(
            parsed.variants.map((v) => [v.videoGroup, v.audioGroup])
        ).toEqual([
            ['Stage', 'group_tier_0'],
            ['Stage', 'group_tier_0'],
            ['Pulpit', 'group_tier_0'],
            ['Pulpit', 'group_tier_0'],
        ]);
        // What the players read: two angles, the main one first.
        expect(listAnglesInPlayer(out)).toEqual([
            { id: 'Stage', name: 'Stage', isDefault: true },
            { id: 'Pulpit', name: 'Pulpit', isDefault: false },
        ]);
    });

    it('adds a third angle to a video with angles, leaving every existing line as it was', () => {
        const out = addVideoAngleLines(MULTI, { name: 'Choir' }, [
            variant(
                'stream_main_1280x720/playlist.m3u8',
                'stream_addcd_0_Choir_720p/playlist.m3u8',
                '1280x720'
            ),
        ]);
        const before = MULTI.split('\n');
        const after = out.split('\n');
        for (const line of before) expect(after).toContain(line);
        expect(after[5]).toBe(
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="Choir",NAME="Choir",DEFAULT=NO'
        );
        expect(listVideoAngles(parseMasterPlaylist(out))).toHaveLength(3);
        // The I-frame line stays last; the variant goes after the last variant.
        expect(after.indexOf('stream_addcd_0_Choir_720p/playlist.m3u8')).toBe(
            after.indexOf('stream_pulpit_854x480/playlist.m3u8') + 2
        );
    });

    it('names the I-frame playlists of a single picture too', () => {
        const withIframes = SINGLE.replace(
            /\n$/,
            '\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="stream_0_1920x1080/iframes.m3u8"\n'
        );
        const out = addVideoAngleLines(withIframes, { name: 'Side' }, [
            variant(
                'stream_0_1920x1080/playlist.m3u8',
                'stream_addab_0_Side/playlist.m3u8',
                '1920x1080'
            ),
        ]);
        expect(out).toContain(
            '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="stream_0_1920x1080/iframes.m3u8",VIDEO="Main"'
        );
    });

    it('keeps CRLF line ends', () => {
        const out = addVideoAngleLines(
            MULTI.replace(/\n/g, '\r\n'),
            { name: 'Choir' },
            [
                variant(
                    'stream_main_1280x720/playlist.m3u8',
                    'x/playlist.m3u8',
                    '1280x720'
                ),
            ]
        );
        expect(out.split('\r\n').join('')).not.toContain('\n');
    });

    it('refuses a name an angle already has, an audio-only video, and an unknown reference', () => {
        const one = [
            variant('stream_main_1280x720/playlist.m3u8', 'x/p.m3u8', '1x1'),
        ];
        expect(() =>
            addVideoAngleLines(MULTI, { name: 'pulpit' }, one)
        ).toThrow(/already has an angle/);
        expect(() => addVideoAngleLines(SINGLE, { name: 'Main' }, one)).toThrow(
            /already has an angle/
        );
        expect(() =>
            addVideoAngleLines(AUDIO_ONLY, { name: 'Side' }, one)
        ).toThrow(/no picture/);
        expect(() =>
            addVideoAngleLines(MULTI, { name: 'Side' }, [
                variant('nope/playlist.m3u8', 'x/p.m3u8', '1x1'),
            ])
        ).toThrow(/no variant/);
        expect(() => addVideoAngleLines(MULTI, { name: 'a"b' }, one)).toThrow(
            /angle name/
        );
    });
});

describe('rewriteVideoAngles', () => {
    it('renames an angle and changes nothing else', () => {
        const out = rewriteVideoAngles(MULTI, [
            { id: 'pulpit', name: 'Pulpit camera' },
        ]);
        expect(out).toBe(
            MULTI.replace('NAME="Pulpit"', 'NAME="Pulpit camera"')
        );
    });

    it('takes an angle out with its variants and I-frames, moving the default', () => {
        const out = rewriteVideoAngles(MULTI, [], ['main']);
        expect(out).not.toContain('stream_main_1280x720');
        expect(out).not.toContain('GROUP-ID="main"');
        expect(out).toContain(
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="Pulpit",DEFAULT=YES'
        );
        expect(parseMasterPlaylist(out).variants.map((v) => v.uri)).toEqual([
            'stream_pulpit_854x480/playlist.m3u8',
        ]);
    });

    it('refuses what would leave a broken master', () => {
        expect(() => rewriteVideoAngles(MULTI, [], ['main', 'pulpit'])).toThrow(
            /at least one angle/
        );
        expect(() => rewriteVideoAngles(MULTI, [], ['side'])).toThrow(
            /No angle/
        );
        expect(() =>
            rewriteVideoAngles(MULTI, [{ id: 'main', name: 'x' }], ['main'])
        ).toThrow(/both renamed and removed/);
        expect(() =>
            rewriteVideoAngles(MULTI, [{ id: 'main', name: 'pulpit' }])
        ).toThrow(/same name/);
        expect(() =>
            rewriteVideoAngles(SINGLE, [{ id: '', name: 'x' }])
        ).toThrow(/No angle/);
    });
});
