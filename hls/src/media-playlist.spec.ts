import { describe, it, expect } from 'vitest';
import {
    buildMediaPlaylist,
    formatByteRange,
    getMediaPlaylistLayout,
    parseByteRange,
    parseMediaPlaylist,
} from './media-playlist';
import { BYTE_RANGE_MEDIA_PLAYLIST, PLAIN_MEDIA_PLAYLIST } from './fixtures';

describe('parseMediaPlaylist', () => {
    it('reads the header of a byte-range fMP4 playlist', () => {
        const playlist = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);

        expect(playlist.version).toBe(7);
        expect(playlist.targetDuration).toBe(4);
        expect(playlist.mediaSequence).toBe(0);
        expect(playlist.playlistType).toBe('VOD');
        expect(playlist.endList).toBe(true);
        expect(playlist.maps).toEqual([{ uri: 'init.mp4' }]);
    });

    it('reads the injected AES-128 key', () => {
        const [key] = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST).keys;
        expect(key).toEqual({
            method: 'AES-128',
            uri: 'luminary://key',
            iv: '0x8f3b1c0d5e6a7b8c9d0e1f2a3b4c5d6e',
        });
    });

    it('attaches each byte range to the segment whose URI follows it', () => {
        const { segments } = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);

        expect(segments).toEqual([
            {
                duration: 4,
                title: '',
                byteRange: { length: 1048576, offset: 0 },
                uri: 'media_0.m4s',
            },
            {
                duration: 4,
                title: '',
                byteRange: { length: 1048576, offset: 1048576 },
                uri: 'media_0.m4s',
            },
            {
                duration: 2.133333,
                title: '',
                byteRange: { length: 524288, offset: 0 },
                uri: 'media_1.m4s',
            },
        ]);
    });

    it('reads a plain MPEG-TS playlist with no encryption or ranges', () => {
        const playlist = parseMediaPlaylist(PLAIN_MEDIA_PLAYLIST);

        expect(playlist.keys).toEqual([]);
        expect(playlist.maps).toEqual([]);
        expect(playlist.segments.map((s) => s.uri)).toEqual([
            'segment_00000.ts',
            'segment_00001.ts',
            'segment_00002.ts',
        ]);
    });

    it('tolerates the offset-omitted continuation form of a byte range', () => {
        const text = [
            '#EXTM3U',
            '#EXTINF:4.000000,',
            '#EXT-X-BYTERANGE:1000@0',
            'media.ts',
            '#EXTINF:4.000000,',
            '#EXT-X-BYTERANGE:2000',
            'media.ts',
            '',
        ].join('\n');

        const { segments } = parseMediaPlaylist(text);
        expect(segments[1].byteRange).toEqual({ length: 2000 });
        expect(buildMediaPlaylist(parseMediaPlaylist(text))).toBe(text);
    });

    it('reads an #EXT-X-MAP byte range', () => {
        const { maps } = parseMediaPlaylist(
            ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"', ''].join('\n')
        );
        expect(maps).toEqual([{ uri: 'init.mp4', byteRange: { length: 800, offset: 0 } }]);
    });

    it('keeps an #EXTINF that never got a URI as text rather than inventing a segment', () => {
        const text = ['#EXTM3U', '#EXTINF:4.000000,', '#EXT-X-ENDLIST', ''].join('\n');

        const playlist = parseMediaPlaylist(text);
        expect(playlist.segments).toEqual([]);
        expect(getMediaPlaylistLayout(playlist)).toContain('#EXTINF:4.000000,');
    });
});

describe('media playlist round-trip', () => {
    it.each([
        ['byte-range fMP4 playlist', BYTE_RANGE_MEDIA_PLAYLIST],
        ['plain MPEG-TS playlist', PLAIN_MEDIA_PLAYLIST],
    ])('%s survives parse → build byte for byte', (_name, text) => {
        expect(buildMediaPlaylist(parseMediaPlaylist(text))).toBe(text);
    });

    it('preserves the source spelling of durations', () => {
        const rebuilt = buildMediaPlaylist(
            parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST)
        );
        expect(rebuilt).toContain('#EXTINF:4.000000,');
    });

    it('keeps unknown tags and comments in position', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '# hand-written note',
            '#EXT-X-PROGRAM-DATE-TIME:2026-08-05T12:00:00Z',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:4.000000,',
            'segment_00000.ts',
            '#EXT-X-ENDLIST',
            '',
        ].join('\n');

        expect(buildMediaPlaylist(parseMediaPlaylist(text))).toBe(text);
    });

    it('parses identically after a round-trip', () => {
        const first = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);
        const second = parseMediaPlaylist(buildMediaPlaylist(first));
        expect(second).toEqual(first);
    });

    it('rewrites a key URI without disturbing the rest of the playlist', () => {
        const playlist = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);
        playlist.keys[0].uri = 'blob:https://app.example/deadbeef';

        const rebuilt = buildMediaPlaylist(playlist);
        expect(rebuilt).toContain(
            '#EXT-X-KEY:METHOD=AES-128,URI="blob:https://app.example/deadbeef",IV=0x8f3b1c0d5e6a7b8c9d0e1f2a3b4c5d6e'
        );
        expect(rebuilt).toContain('#EXT-X-BYTERANGE:1048576@1048576');
    });

    it('absolutizes segment and map URIs in place', () => {
        const playlist = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);
        const base = 'https://cdn.example/out/stream_0/playlist.m3u8';
        for (const segment of playlist.segments) {
            segment.uri = new URL(segment.uri, base).toString();
        }
        for (const map of playlist.maps) {
            map.uri = new URL(map.uri, base).toString();
        }

        const rebuilt = buildMediaPlaylist(playlist);
        expect(rebuilt).toContain(
            '#EXT-X-MAP:URI="https://cdn.example/out/stream_0/init.mp4"'
        );
        expect(rebuilt).toContain(
            'https://cdn.example/out/stream_0/media_0.m4s'
        );
    });

    it('rebuilds canonically once the model has been through JSON', () => {
        const parsed = parseMediaPlaylist(BYTE_RANGE_MEDIA_PLAYLIST);
        const viaJson = JSON.parse(JSON.stringify(parsed));
        expect(parseMediaPlaylist(buildMediaPlaylist(viaJson))).toEqual(parsed);
    });
});

describe('byte ranges', () => {
    it('parses both forms', () => {
        expect(parseByteRange('1000@200')).toEqual({ length: 1000, offset: 200 });
        expect(parseByteRange('1000')).toEqual({ length: 1000 });
        expect(parseByteRange('nonsense')).toBeUndefined();
    });

    it('formats both forms', () => {
        expect(formatByteRange({ length: 1000, offset: 200 })).toBe('1000@200');
        expect(formatByteRange({ length: 1000 })).toBe('1000');
    });
});
