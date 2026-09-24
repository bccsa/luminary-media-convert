import { describe, expect, it } from 'vitest';
import { parseMediaPlaylist } from '@luminary-media-converter/hls-core';
import {
    scanMediaPlaylist,
    type MediaPlaylistScan,
    type SegmentRun,
} from './media-scan.js';
import {
    CHUNKED_MEDIA_PLAYLIST,
    ENCRYPTED_MEDIA_PLAYLIST,
    LIVE_MEDIA_PLAYLIST,
    PLAIN_MEDIA_PLAYLIST,
    SUBTITLE_MEDIA_PLAYLIST,
} from '../test-support/index.js';

/**
 * What `hls-core`'s lossless model says about a playlist, in the scan's terms.
 *
 * The scan exists to answer these questions without the model's cost, never to
 * answer them differently, so the model is the oracle: every case below is
 * checked against it rather than against numbers written down by hand, and a
 * playlist the two disagree about is a bug in the scan.
 */
function modelAnswer(text: string): MediaPlaylistScan {
    const playlist = parseMediaPlaylist(text);
    const runs: SegmentRun[] = [];
    let elapsed = 0;
    for (const segment of playlist.segments) {
        const start = elapsed;
        elapsed += segment.duration;
        const last = runs.at(-1);
        if (last && last.uri === segment.uri) {
            last.count += 1;
            last.end = elapsed;
        } else {
            runs.push({ uri: segment.uri, count: 1, start, end: elapsed });
        }
    }
    return {
        isLive: !playlist.endList,
        targetDurationSec: playlist.targetDuration ?? 0,
        mediaSequence: playlist.mediaSequence ?? 0,
        hasAes128Key: playlist.keys.some((key) => key.method !== 'NONE'),
        hasByteRanges: playlist.segments.some(
            (segment) => segment.byteRange !== undefined,
        ),
        runs,
    };
}

/** A two-hour byte-range rendition: 1200 segments over ten chunk objects. */
function twoHourChain(durations: (i: number) => string): string {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x01',
    ];
    for (let i = 0; i < 1200; i++) {
        lines.push(
            `#EXTINF:${durations(i)},`,
            `#EXT-X-BYTERANGE:1000@${(i % 120) * 1000}`,
            `../media/v0_${Math.floor(i / 120)}.m4s`,
        );
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
}

// Characters named by code point: every one of them is invisible, or looks
// like a character it is not, and a spec whose inputs cannot be read cannot be
// trusted to be testing what it says it tests.
const char = (code: number): string => String.fromCharCode(code);
const NO_BREAK_SPACE = char(0x00a0);
const EM_SPACE = char(0x2003);
const IDEOGRAPHIC_SPACE = char(0x3000);
const LINE_SEPARATOR = char(0x2028);
const PARAGRAPH_SEPARATOR = char(0x2029);
const VERTICAL_TAB = char(0x000b);
const BYTE_ORDER_MARK = char(0xfeff);
/** A digit, but not one `\d` matches. */
const ARABIC_INDIC_THREE = char(0x0663);

/**
 * Every character `String.prototype.trim` removes, bar the ASCII space: the
 * ASCII controls it counts as whitespace, the no-break and Unicode spaces, the
 * line and paragraph separators, and the byte order mark.
 */
const TRIMMED_CHARACTERS = [
    0x0009, 0x000b, 0x000c, 0x000d, 0x00a0, 0x1680, 0x2003, 0x2028, 0x2029,
    0x202f, 0x205f, 0x3000, 0xfeff,
].map(char);

function padded(text: string): string {
    const pad = (i: number) =>
        TRIMMED_CHARACTERS[i % TRIMMED_CHARACTERS.length];
    return text
        .split('\n')
        .map((line, i) => `${pad(i)}${line}${pad(i + 5)}`)
        .join('\n');
}

const PLAYLISTS: Record<string, string> = {
    'AES-128 byte-range output, as the encoder writes it':
        ENCRYPTED_MEDIA_PLAYLIST,
    'a chunk chain': CHUNKED_MEDIA_PLAYLIST,
    'a plain VOD playlist': PLAIN_MEDIA_PLAYLIST,
    'a live window': LIVE_MEDIA_PLAYLIST,
    'a subtitles playlist': SUBTITLE_MEDIA_PLAYLIST,
    'two hours of one duration': twoHourChain(() => '6.000000'),
    'two hours of drifting durations': twoHourChain((i) =>
        (6 + (i % 7) * 0.0333333).toFixed(6),
    ),
    'CRLF line endings': CHUNKED_MEDIA_PLAYLIST.replace(/\n/g, '\r\n'),
    'lone CR line endings': CHUNKED_MEDIA_PLAYLIST.replace(/\n/g, '\r'),
    'a byte order mark': `${BYTE_ORDER_MARK}${CHUNKED_MEDIA_PLAYLIST}`,
    'indented lines': CHUNKED_MEDIA_PLAYLIST.split('\n')
        .map((line) => `  ${line}\t`)
        .join('\n'),
    'every kind of whitespace trim removes': padded(CHUNKED_MEDIA_PLAYLIST),
    'whitespace inside values': [
        '#EXTM3U',
        `#EXT-X-TARGETDURATION:${NO_BREAK_SPACE}6${IDEOGRAPHIC_SPACE}`,
        `#EXT-X-MEDIA-SEQUENCE:${LINE_SEPARATOR} 7`,
        `#EXTINF:${NO_BREAK_SPACE}4.5${EM_SPACE},title`,
        `#EXT-X-BYTERANGE:${IDEOGRAPHIC_SPACE} 10@0${NO_BREAK_SPACE}`,
        `${NO_BREAK_SPACE}a.m4s${PARAGRAPH_SEPARATOR}`,
        `#EXT-X-ENDLIST${VERTICAL_TAB}`,
    ].join('\n'),
    'a duration respelled between segments': [
        '#EXTM3U',
        '#EXTINF:6,',
        'a.ts',
        '#EXTINF:6,',
        'b.ts',
        '#EXTINF: 6,',
        'c.ts',
        '#EXTINF:6.5,',
        'd.ts',
        '#EXTINF:6,',
        'e.ts',
        '#EXTINF:,',
        'f.ts',
        '#EXTINF:abc,',
        'g.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'durations with no comma': [
        '#EXTM3U',
        '#EXTINF:4',
        'a.ts',
        '#EXTINF: 5 ',
        'b.ts',
        '#EXTINF:',
        'c.ts',
        '#EXTINF:,x,y',
        'd.ts',
        '#EXTINF:4',
        ',e.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'numbers JavaScript reads generously': [
        '#EXTM3U',
        '#EXTINF:1e1,',
        'a.ts',
        '#EXTINF:0x10,',
        'b.ts',
        '#EXTINF:Infinity,',
        'c.ts',
        '#EXTINF:-3,',
        'd.ts',
        '#EXTINF:.5,',
        'e.ts',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'byte ranges that are not byte ranges': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:10 @0',
        'a.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:10@',
        'b.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:@10',
        'c.m4s',
        '#EXTINF:4,',
        `#EXT-X-BYTERANGE:${ARABIC_INDIC_THREE}@0`,
        'd.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:',
        'e.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:10',
        'f.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'a byte range before its #EXTINF': [
        '#EXTM3U',
        '#EXT-X-BYTERANGE:10@0',
        '#EXTINF:4,',
        'a.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'a second byte range that does not parse': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:10@0',
        '#EXT-X-BYTERANGE:bad',
        'a.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'tags between an #EXTINF and its URI': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-PROGRAM-DATE-TIME:2020-01-01T00:00:00Z',
        'a.m4s',
        '#EXTINF:4,',
        '# a comment',
        'b.m4s',
        '#EXTINF:4,',
        '#EXTM3U',
        'c.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'tags cut short': [
        '#EXTM3U',
        '#EXTINF',
        'a.ts',
        '#EXT-X-KEY',
        '#EXT-X-BYTERANGE',
        '#EXT-X-TARGETDURATION',
        '#EXT-X-ENDLIS',
        '#',
        '##EXTINF:4,',
        'b.ts',
    ].join('\n'),
    'a URI that begins with the one before it': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1@0',
        'a.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1@1',
        'a.m4sx',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1@2',
        'a.m4',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'an #EXTINF at the end with no URI':
        '#EXTM3U\n#EXTINF:4,\na.m4s\n#EXTINF:4,\n',
    'METHOD=NONE': '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n',
    'a quoted METHOD="NONE"':
        '#EXTM3U\n#EXT-X-KEY:METHOD="NONE"\n#EXTINF:4,\na.ts\n',
    'a lower-case method':
        '#EXTM3U\n#EXT-X-KEY:METHOD=none\n#EXTINF:4,\na.ts\n',
    'METHOD inside a quoted URI': [
        '#EXTM3U',
        '#EXT-X-KEY:URI="k,METHOD=NONE",METHOD=AES-128',
        '#EXTINF:4,',
        'a.ts',
    ].join('\n'),
    'a key with no METHOD': '#EXTM3U\n#EXT-X-KEY:URI="k"\n#EXTINF:4,\na.ts\n',
    'a key with an empty METHOD':
        '#EXTM3U\n#EXT-X-KEY:METHOD=,URI="k"\n#EXTINF:4,\na.ts\n',
    'spaces around a key attribute': [
        '#EXTM3U',
        `  #EXT-X-KEY: METHOD = NONE ${NO_BREAK_SPACE}`,
        '#EXTINF:4,',
        'a.ts',
    ].join('\n'),
    'SAMPLE-AES':
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\na.ts\n',
    'a key that starts part-way through': [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:4,',
        'a.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="k2"',
        '#EXTINF:4,',
        'b.ts',
    ].join('\n'),
    'headers that repeat or do not parse': [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:x',
        '#EXT-X-TARGETDURATION:',
        '#EXT-X-MEDIA-SEQUENCE:12',
        '#EXT-X-MEDIA-SEQUENCE:13',
        '#EXT-X-TARGETDURATION:0x10',
        '#EXTINF:4',
        'a.ts',
    ].join('\n'),
    'an end tag with more on the line':
        '#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST:x\n',
    'an end tag between an #EXTINF and its URI': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-ENDLIST',
        'a.ts',
        '#EXTINF:4,',
        'b.ts',
    ].join('\n'),
    'durations that are not numbers': [
        '#EXTM3U',
        '#EXTINF:abc,',
        '#EXT-X-BYTERANGE:1@0',
        'a.m4s',
        '#EXTINF:,',
        '#EXT-X-BYTERANGE:1@1',
        'a.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'one chunk spelled two ways': [
        '#EXTM3U',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1@0',
        '../media/a.m4s',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1@1',
        '/out/session/media/a.m4s',
        '#EXT-X-ENDLIST',
    ].join('\n'),
    'nothing at all': '',
    'only the header': '#EXTM3U',
    'only newlines': '\n\n\n',
    'no newline at the end': '#EXTM3U\n#EXTINF:4,\na.ts',
};

describe('scanMediaPlaylist', () => {
    it.each(Object.entries(PLAYLISTS))(
        'agrees with the lossless model on %s',
        (_name, text) => {
            expect(scanMediaPlaylist(text)).toEqual(modelAnswer(text));
        },
    );

    it('gathers the segments of a chunk into one run', () => {
        // The whole point of runs: byte-range output is a dozen of them where
        // a segment list would be a thousand entries.
        expect(scanMediaPlaylist(CHUNKED_MEDIA_PLAYLIST)).toEqual({
            isLive: false,
            targetDurationSec: 4,
            mediaSequence: 0,
            hasAes128Key: false,
            hasByteRanges: true,
            runs: [
                { uri: '../media/v0_0.m4s', count: 2, start: 0, end: 8 },
                { uri: '../media/v0_1.m4s', count: 1, start: 8, end: 12 },
            ],
        });
    });

    it('reads a two-hour chain as ten runs', () => {
        const scan = scanMediaPlaylist(twoHourChain(() => '6.000000'));
        expect(scan.runs).toHaveLength(10);
        expect(scan.runs.map((run) => run.count)).toEqual(Array(10).fill(120));
        expect(scan.runs.at(-1)?.end).toBe(7200);
    });

    it('reads a live window: no end tag, and where the window starts', () => {
        expect(scanMediaPlaylist(LIVE_MEDIA_PLAYLIST)).toMatchObject({
            isLive: true,
            targetDurationSec: 4,
            mediaSequence: 87996,
            hasByteRanges: false,
        });
    });

    it('reads a respelled duration afresh rather than repeating the last one', () => {
        // The scan skips re-parsing a duration written exactly as the one
        // before it; a different spelling of the same number, or a different
        // number, must still be read.
        const scan = scanMediaPlaylist(
            PLAYLISTS['a duration respelled between segments']!,
        );
        expect(scan.runs.map((run) => run.end - run.start)).toEqual([
            6,
            6,
            6,
            6.5,
            6,
            0,
            Number.NaN,
        ]);
    });

    it('reads which METHOD a key line carries, not text that looks like one', () => {
        // Quote-aware: a comma inside a quoted URI does not end the attribute.
        expect(
            scanMediaPlaylist(PLAYLISTS['METHOD inside a quoted URI']!)
                .hasAes128Key,
        ).toBe(true);
        expect(
            scanMediaPlaylist(
                '#EXTM3U\n#EXT-X-KEY:URI="k,METHOD=AES-128",METHOD=NONE\n',
            ).hasAes128Key,
        ).toBe(false);
    });
});
