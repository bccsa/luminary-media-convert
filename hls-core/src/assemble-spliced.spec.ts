import { describe, it, expect } from 'vitest';
import {
    assembleSplicedMediaPlaylist,
    buildSplicedMediaPlaylist,
    type SplicedPart,
} from './assemble-spliced.js';
import { buildMediaPlaylist, parseMediaPlaylist } from './media-playlist.js';

const THREE_PARTS: SplicedPart[] = [
    // head bridge: own init, one short segment
    {
        mapUri: 'init_0.mp4',
        segments: [{ uri: 'segment_0000000.m4s', duration: 0.25 }],
    },
    // copied span: own init, muxer-length segments
    {
        mapUri: 'init_100000.mp4',
        segments: [
            { uri: 'segment_0100000.m4s', duration: 6 },
            { uri: 'segment_0100001.m4s', duration: 2.06 },
        ],
    },
    // tail bridge
    {
        mapUri: 'init_200000.mp4',
        segments: [{ uri: 'segment_0200000.m4s', duration: 0.88 }],
    },
];

describe('assembleSplicedMediaPlaylist', () => {
    it('emits parts in order: MAP, segments, DISCONTINUITY before each later part', () => {
        expect(buildSplicedMediaPlaylist(THREE_PARTS)).toBe(
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-TARGETDURATION:6',
                '#EXT-X-MEDIA-SEQUENCE:0',
                '#EXT-X-PLAYLIST-TYPE:VOD',
                '#EXT-X-INDEPENDENT-SEGMENTS',
                '#EXT-X-MAP:URI="init_0.mp4"',
                '#EXTINF:0.250000,',
                'segment_0000000.m4s',
                '#EXT-X-DISCONTINUITY',
                '#EXT-X-MAP:URI="init_100000.mp4"',
                '#EXTINF:6.000000,',
                'segment_0100000.m4s',
                '#EXTINF:2.060000,',
                'segment_0100001.m4s',
                '#EXT-X-DISCONTINUITY',
                '#EXT-X-MAP:URI="init_200000.mp4"',
                '#EXTINF:0.880000,',
                'segment_0200000.m4s',
                '#EXT-X-ENDLIST',
                '',
            ].join('\n')
        );
    });

    it('round-trips byte-losslessly through parse and build', () => {
        const text = buildSplicedMediaPlaylist(THREE_PARTS);
        const reparsed = parseMediaPlaylist(text);
        expect(reparsed.maps).toHaveLength(3);
        expect(reparsed.segments).toHaveLength(4);
        expect(buildMediaPlaylist(reparsed)).toBe(text);
    });

    it('degenerates to an ordinary playlist for a single part', () => {
        const text = buildSplicedMediaPlaylist([THREE_PARTS[1]]);
        expect(text).not.toContain('#EXT-X-DISCONTINUITY');
        const parsed = parseMediaPlaylist(text);
        expect(parsed.maps).toEqual([{ uri: 'init_100000.mp4' }]);
        expect(parsed.segments).toHaveLength(2);
    });

    it('emits a discontinuity without a MAP for a part continuing the previous init', () => {
        const text = buildSplicedMediaPlaylist([
            THREE_PARTS[1],
            {
                segments: [{ uri: 'segment_0300000.m4s', duration: 3.5 }],
            },
        ]);
        expect(text).toContain(
            [
                'segment_0100001.m4s',
                '#EXT-X-DISCONTINUITY',
                '#EXTINF:3.500000,',
                'segment_0300000.m4s',
            ].join('\n')
        );
        expect(parseMediaPlaylist(text).maps).toHaveLength(1);
    });

    it('sets TARGETDURATION to the ceiling of the longest segment', () => {
        const playlist = assembleSplicedMediaPlaylist(THREE_PARTS);
        expect(playlist.targetDuration).toBe(6);
        expect(
            assembleSplicedMediaPlaylist([
                { mapUri: 'i.mp4', segments: [{ uri: 's.m4s', duration: 6.02 }] },
            ]).targetDuration
        ).toBe(7);
    });

    it('honours options and defaults', () => {
        const playlist = assembleSplicedMediaPlaylist(THREE_PARTS, {
            version: 6,
            mediaSequence: 5,
            independentSegments: false,
        });
        expect(playlist.version).toBe(6);
        expect(playlist.mediaSequence).toBe(5);
        expect(playlist.independentSegments).toBeUndefined();
        expect(playlist.playlistType).toBe('VOD');
        expect(playlist.endList).toBe(true);
    });

    it('refuses empty input', () => {
        expect(() => assembleSplicedMediaPlaylist([])).toThrow('no parts');
        expect(() =>
            assembleSplicedMediaPlaylist([{ mapUri: 'i.mp4', segments: [] }])
        ).toThrow('part 0 has no segments');
    });
});
