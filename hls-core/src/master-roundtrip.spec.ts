import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist } from './parse.js';
import { buildMasterPlaylist } from './build.js';
import {
    MULTI_ANGLE_MASTER,
    SINGLE_ANGLE_MASTER,
    AUDIO_ONLY_MASTER,
    MULTI_ANGLE_WITH_SUBTITLES_MASTER,
    MULTI_TIER_AUDIO_MASTER,
} from './fixtures.js';

const FIXTURES: [name: string, text: string][] = [
    ['multi-angle master', MULTI_ANGLE_MASTER],
    ['single-angle master', SINGLE_ANGLE_MASTER],
    ['audio-only master', AUDIO_ONLY_MASTER],
    ['multi-angle master with SUBTITLES', MULTI_ANGLE_WITH_SUBTITLES_MASTER],
    ['multi-tier audio master', MULTI_TIER_AUDIO_MASTER],
];

describe('master playlist round-trip', () => {
    it.each(FIXTURES)('%s survives parse → build byte for byte', (_name, text) => {
        expect(buildMasterPlaylist(parseMasterPlaylist(text))).toBe(text);
    });

    it.each(FIXTURES)('%s parses identically after a round-trip', (_name, text) => {
        const first = parseMasterPlaylist(text);
        const second = parseMasterPlaylist(buildMasterPlaylist(first));
        expect(second).toEqual(first);
    });

    it('survives the HLS-edit mutate path with no operations', () => {
        // `HlsEditService.mutate()` reads master.m3u8, applies the requested
        // operations, then writes `buildMasterPlaylist(master)` back to S3 —
        // unconditionally, even for an empty operation list. Anything the
        // model dropped used to be destroyed in S3 on the first no-op edit;
        // for a multi-angle master that meant every VIDEO group.
        const master = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        const written = buildMasterPlaylist(master);

        expect(written).toBe(MULTI_ANGLE_MASTER);
        expect(written).toContain('#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main"');
        expect(written).toContain('VIDEO="pulpit"');
        expect(parseMasterPlaylist(written)).toEqual(master);
    });

    it('keeps tags the model does not understand, in position', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-VERSION:6',
            '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Sermon"',
            '# a bare comment',
            '#EXT-X-START:TIME-OFFSET=-30',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
            'v0/playlist.m3u8',
            '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="k"',
            '',
        ].join('\n');

        expect(buildMasterPlaylist(parseMasterPlaylist(text))).toBe(text);
    });

    it('keeps attributes the model does not understand', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,HDCP-LEVEL=TYPE-0,CLOSED-CAPTIONS=NONE,VIDEO-RANGE=SDR',
            'v0/playlist.m3u8',
            '',
        ].join('\n');

        expect(buildMasterPlaylist(parseMasterPlaylist(text))).toBe(text);
    });

    it('preserves the source spelling of a fractional frame rate', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,FRAME-RATE=29.970',
            'v0/playlist.m3u8',
            '',
        ].join('\n');

        const parsed = parseMasterPlaylist(text);
        expect(parsed.variants[0].frameRate).toBe(29.97);
        expect(buildMasterPlaylist(parsed)).toContain('FRAME-RATE=29.970');
    });

    it('preserves the source attribute order rather than imposing its own', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:CODECS="avc1.64001f",RESOLUTION=1280x720,BANDWIDTH=1000000',
            'v0/playlist.m3u8',
            '',
        ].join('\n');

        expect(buildMasterPlaylist(parseMasterPlaylist(text))).toBe(text);
    });

    it('re-emits an edited attribute while leaving its neighbours alone', () => {
        const parsed = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        parsed.variants[0].bandwidth = 4000000;

        const rebuilt = buildMasterPlaylist(parsed);
        expect(rebuilt).toContain(
            '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AVERAGE-BANDWIDTH=3822202,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",VIDEO="main",AUDIO="group_tier_0"'
        );
    });

    it('drops an entry removed from the model and appends one added to it', () => {
        const parsed = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        parsed.variants = parsed.variants.filter((v) => v.videoGroup === 'main');
        parsed.media.push({
            type: 'SUBTITLES',
            groupId: 'subs',
            name: 'English',
            language: 'en',
            uri: 'subtitles/en.m3u8',
        });

        const rebuilt = buildMasterPlaylist(parsed);
        expect(rebuilt).not.toContain('stream_pulpit_854x480');
        expect(rebuilt).toContain(
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subtitles/en.m3u8"'
        );
    });

    it('rebuilds canonically once the model has been through JSON', () => {
        const parsed = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        const viaJson = JSON.parse(JSON.stringify(parsed));

        // Serialization metadata does not survive JSON, so the output is
        // canonical rather than byte-identical — but it stays equivalent.
        expect(parseMasterPlaylist(buildMasterPlaylist(viaJson))).toEqual(parsed);
    });
});
