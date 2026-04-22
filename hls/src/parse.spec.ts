import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist } from './parse.js';

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
            { bandwidth: 1000000, resolution: '1280x720', codecs: 'avc1.64001f,mp4a.40.2', uri: 'v0/playlist.m3u8' },
            { bandwidth: 500000, resolution: '640x360', uri: 'v1/playlist.m3u8' },
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
});
