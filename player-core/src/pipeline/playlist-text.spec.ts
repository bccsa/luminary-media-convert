import { afterEach, describe, expect, it } from 'vitest';
import {
    absolutize,
    collectMasterRefs,
    hasAes128Key,
    hasVideoVariants,
    isMasterPlaylistText,
    listSegmentUris,
    parseMasterText,
    substituteMasterRefs,
} from './playlist-text.js';
import {
    AUDIO_ONLY_MASTER,
    ENCRYPTED_MEDIA_PLAYLIST,
    MULTI_ANGLE_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
} from '../test-support/index.js';

describe('isMasterPlaylistText', () => {
    it('recognizes masters by line, not by substring', () => {
        expect(isMasterPlaylistText(SIMPLE_MASTER)).toBe(true);
        expect(isMasterPlaylistText(PLAIN_MEDIA_PLAYLIST)).toBe(false);
    });

    it('does not fire on a media playlist that merely mentions the tag', () => {
        const sneaky = [
            '#EXTM3U',
            '# note: rewritten from #EXT-X-STREAM-INF by the packager',
            '#EXTINF:4.0,',
            'a.m4s',
        ].join('\n');
        expect(isMasterPlaylistText(sneaky)).toBe(false);
    });
});

describe('parseMasterText', () => {
    it('reads resolutions, bandwidths and rendition groups', () => {
        const parsed = parseMasterText(MULTI_ANGLE_MASTER);
        expect(parsed.variants).toHaveLength(3);
        expect(parsed.variants[0]).toMatchObject({
            uri: 'angle0_1080/playlist.m3u8',
            bandwidth: 5_000_000,
            width: 1920,
            height: 1080,
            groups: { VIDEO: 'angle_0', AUDIO: 'aud', SUBTITLES: 'subs' },
        });
        expect(parsed.media.map((m) => m.type)).toEqual([
            'VIDEO',
            'VIDEO',
            'AUDIO',
            'SUBTITLES',
        ]);
    });

    it('does not confuse AVERAGE-BANDWIDTH with BANDWIDTH', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=111,BANDWIDTH=999,RESOLUTION=640x360',
            'a.m3u8',
        ].join('\n');
        expect(parseMasterText(text).variants[0]?.bandwidth).toBe(999);
    });

    it('treats resolution-less variants as height-less', () => {
        const parsed = parseMasterText(AUDIO_ONLY_MASTER);
        expect(parsed.variants[0]?.height).toBeUndefined();
    });
});

describe('collectMasterRefs / substituteMasterRefs', () => {
    it('collects variant and media playlist URIs once each', () => {
        expect(collectMasterRefs(MULTI_ANGLE_MASTER)).toEqual([
            { uri: 'angle0_1080/playlist.m3u8', kind: 'variant' },
            { uri: 'angle0_720/playlist.m3u8', kind: 'variant' },
            { uri: 'angle1_1080/playlist.m3u8', kind: 'variant' },
            {
                uri: 'audio_128kbps/playlist.m3u8',
                kind: 'media',
                mediaType: 'AUDIO',
            },
            {
                uri: 'subs_en/playlist.m3u8',
                kind: 'media',
                mediaType: 'SUBTITLES',
            },
        ]);
    });

    it('substitutes both variant lines and URI attributes', () => {
        const out = substituteMasterRefs(
            MULTI_ANGLE_MASTER,
            new Map([
                ['angle0_1080/playlist.m3u8', 'blob:one'],
                ['audio_128kbps/playlist.m3u8', 'blob:audio'],
            ]),
        );
        expect(out).toContain('\nblob:one\n');
        expect(out).toContain('URI="blob:audio"');
        // Untouched refs stay as written.
        expect(out).toContain('angle0_720/playlist.m3u8');
    });

    it('carries unmodeled tags and attributes through the substitution', () => {
        const master = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Demo"',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",CHARACTERISTICS="public.accessibility",URI="audio/playlist.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=29.970,HDCP-LEVEL=TYPE-0,AUDIO="aud",CLOSED-CAPTIONS=NONE',
            'v720/playlist.m3u8',
            '',
        ].join('\n');

        // Nothing to replace → byte-identical output.
        expect(substituteMasterRefs(master, new Map())).toBe(master);

        const out = substituteMasterRefs(
            master,
            new Map([['v720/playlist.m3u8', 'blob:v720']]),
        );
        expect(out).toContain('\nblob:v720\n');
        expect(out).toContain(
            '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Demo"',
        );
        expect(out).toContain('CHARACTERISTICS="public.accessibility"');
        // Attribute order, unknown attributes and numeric spelling all survive.
        expect(out).toContain(
            'BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=29.970,HDCP-LEVEL=TYPE-0,AUDIO="aud",CLOSED-CAPTIONS=NONE',
        );
    });
});

describe('media playlist helpers', () => {
    it('detects AES-128 keys and ignores METHOD=NONE', () => {
        expect(hasAes128Key(ENCRYPTED_MEDIA_PLAYLIST)).toBe(true);
        expect(hasAes128Key(PLAIN_MEDIA_PLAYLIST)).toBe(false);
        expect(
            hasAes128Key('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts'),
        ).toBe(false);
    });

    it('lists only segment lines', () => {
        expect(listSegmentUris(ENCRYPTED_MEDIA_PLAYLIST)).toEqual([
            'data_0.m4s',
            'data_0.m4s',
        ]);
    });
});

describe('hasVideoVariants', () => {
    it('is true for video masters and false for audio-only ones', () => {
        expect(hasVideoVariants(SIMPLE_MASTER)).toBe(true);
        expect(hasVideoVariants(MULTI_ANGLE_MASTER)).toBe(true);
        expect(hasVideoVariants(AUDIO_ONLY_MASTER)).toBe(false);
    });
});

describe('absolutize', () => {
    const base = 'https://cdn.example.com/out/session/master.m3u8?token=xyz';

    it('resolves relative URIs against the playlist URL', () => {
        expect(absolutize('stream_720/playlist.m3u8', base)).toBe(
            'https://cdn.example.com/out/session/stream_720/playlist.m3u8',
        );
    });

    it('preserves query strings on the referenced URI', () => {
        // The old pipeline used endsWith('.m3u8') and skipped these entirely.
        expect(absolutize('playlist.m3u8?audio=2&token=abc', base)).toBe(
            'https://cdn.example.com/out/session/playlist.m3u8?audio=2&token=abc',
        );
    });

    it('handles absolute, root-relative and protocol-relative URIs', () => {
        expect(absolutize('https://other/x.m3u8', base)).toBe(
            'https://other/x.m3u8',
        );
        expect(absolutize('/root/x.m3u8', base)).toBe(
            'https://cdn.example.com/root/x.m3u8',
        );
        expect(absolutize('//other/x.m3u8', base)).toBe('https://other/x.m3u8');
    });

    it('leaves blob and data URIs alone', () => {
        expect(absolutize('blob:https://app/abc', base)).toBe(
            'blob:https://app/abc',
        );
        expect(absolutize('data:text/vtt,WEBVTT', base)).toBe(
            'data:text/vtt,WEBVTT',
        );
    });

    describe('with a relative base', () => {
        // A same-origin app hands over `/api/…/playlist.m3u8` with no scheme or
        // host. `new URL(uri, base)` refuses that, and returning `uri` unchanged
        // let the browser resolve `r0/playlist.m3u8` against the page — the SPA
        // fallback then answered with index.html where a playlist should be.
        const relativeBase = '/api/sessions/abc/preview/playlist.m3u8?token=t';
        const savedDocument = (globalThis as any).document;

        afterEach(() => {
            (globalThis as any).document = savedDocument;
        });

        it('anchors the base to the document when there is one', () => {
            (globalThis as any).document = {
                baseURI: 'http://127.0.0.1:31711/sessions/abc',
            };
            expect(absolutize('r0/playlist.m3u8?token=t', relativeBase)).toBe(
                'http://127.0.0.1:31711/api/sessions/abc/preview/r0/playlist.m3u8?token=t',
            );
        });

        it('never resolves against the page path itself', () => {
            (globalThis as any).document = {
                baseURI: 'http://127.0.0.1:31711/sessions/abc',
            };
            // Resolving through the browser's baseURI gives the wrong answer.
            expect(absolutize('r0/playlist.m3u8', relativeBase)).not.toContain(
                '/sessions/abc/r0/',
            );
        });

        it('returns the uri unchanged when there is no document to anchor to', () => {
            (globalThis as any).document = undefined;
            expect(absolutize('r0/playlist.m3u8', relativeBase)).toBe(
                'r0/playlist.m3u8',
            );
        });
    });
});
