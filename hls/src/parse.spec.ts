import { describe, it, expect } from 'vitest';
import { getMasterLayout, parseMasterPlaylist, parseResolution } from './parse';
import { MULTI_ANGLE_MASTER } from './fixtures';

describe('parseMasterPlaylist', () => {
    it('parses variants with BANDWIDTH, RESOLUTION, CODECS', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
            'v0/playlist.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
            'v1/playlist.m3u8',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.variants).toEqual([
            {
                bandwidth: 1000000,
                resolution: '1280x720',
                resolutionParsed: { width: 1280, height: 720 },
                codecs: 'avc1.64001f,mp4a.40.2',
                uri: 'v0/playlist.m3u8',
            },
            {
                bandwidth: 500000,
                resolution: '640x360',
                resolutionParsed: { width: 640, height: 360 },
                uri: 'v1/playlist.m3u8',
            },
        ]);
    });

    it('parses audio media', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.audioGroups).toEqual([
            {
                type: 'AUDIO',
                groupId: 'aud',
                name: 'English',
                language: 'en',
                uri: 'audio/en.m3u8',
                default: true,
                autoselect: true,
            },
        ]);
    });

    it('parses subtitle media and exposes them via `media`', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subtitles/en.vtt"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Forced",LANGUAGE="en",FORCED=YES,URI="subtitles/en-forced.vtt"',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.audioGroups).toEqual([]);
        expect(result.media).toHaveLength(2);
        expect(result.media[0].type).toBe('SUBTITLES');
        expect(result.media[1].forced).toBe(true);
    });

    it('ignores unknown #EXT-X-MEDIA types', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=BOGUS,GROUP-ID="x",NAME="x"',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English"',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.media).toHaveLength(1);
    });

    it('skips STREAM-INF without a BANDWIDTH attribute', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:RESOLUTION=640x360',
            'v0/playlist.m3u8',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.variants).toEqual([]);
    });

    describe('video rendition groups', () => {
        it('captures TYPE=VIDEO media and the VIDEO attribute on each variant', () => {
            const result = parseMasterPlaylist(MULTI_ANGLE_MASTER);

            expect(result.videoGroups.map((g) => g.groupId)).toEqual([
                'main',
                'pulpit',
            ]);
            expect(result.videoGroups[0].default).toBe(true);
            // DEFAULT=NO is distinguishable from an absent DEFAULT.
            expect(result.videoGroups[1].default).toBe(false);
            expect(result.variants.map((v) => v.videoGroup)).toEqual([
                'main',
                'pulpit',
            ]);
            expect(result.media).toHaveLength(3);
        });

        it('reads the group references and extended bitrate attributes', () => {
            const [first] = parseMasterPlaylist(MULTI_ANGLE_MASTER).variants;

            expect(first.averageBandwidth).toBe(3822202);
            expect(first.audioGroup).toBe('group_tier_0');
            expect(first.resolutionParsed).toEqual({ width: 1280, height: 720 });
        });
    });

    it('reads the playlist version and independent-segments flag', () => {
        const result = parseMasterPlaylist(
            ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'].join('\n')
        );
        expect(result.version).toBe(7);
        expect(result.independentSegments).toBe(true);
    });

    it('models I-frame streams, whose URI is an attribute', () => {
        const result = parseMasterPlaylist(
            [
                '#EXTM3U',
                '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,RESOLUTION=1280x720,URI="v0/iframes.m3u8"',
            ].join('\n')
        );
        expect(result.iFrameStreams).toEqual([
            {
                bandwidth: 180000,
                resolution: '1280x720',
                resolutionParsed: { width: 1280, height: 720 },
                uri: 'v0/iframes.m3u8',
            },
        ]);
    });

    it('does not let a URI-less STREAM-INF steal the next variant\'s URI', () => {
        const content = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
            'v1/playlist.m3u8',
        ].join('\n');

        const result = parseMasterPlaylist(content);
        expect(result.variants).toHaveLength(1);
        expect(result.variants[0]).toMatchObject({
            bandwidth: 500000,
            uri: 'v1/playlist.m3u8',
        });
        // The orphaned line is kept as text rather than silently dropped.
        expect(getMasterLayout(result)).toContain(
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720'
        );
    });

    it('handles a comma inside a quoted attribute value', () => {
        const result = parseMasterPlaylist(
            [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.64001f,mp4a.40.2",AUDIO="a"',
                'v0.m3u8',
            ].join('\n')
        );
        expect(result.variants[0].codecs).toBe('avc1.64001f,mp4a.40.2');
        expect(result.variants[0].audioGroup).toBe('a');
    });
});

describe('parseResolution', () => {
    it('splits a RESOLUTION attribute', () => {
        expect(parseResolution('1920x1080')).toEqual({ width: 1920, height: 1080 });
    });

    it('returns undefined for anything else', () => {
        expect(parseResolution('1920')).toBeUndefined();
        expect(parseResolution('wide')).toBeUndefined();
    });
});
