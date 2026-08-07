import { describe, expect, it } from 'vitest';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    rewriteMediaPlaylist,
} from './rewrite-media.js';
import {
    ENCRYPTED_MEDIA_PLAYLIST,
    PLAIN_MEDIA_PLAYLIST,
} from '../test-support/index.js';

const BASE = 'https://cdn.example.com/out/session/stream_720/playlist.m3u8';

describe('rewriteMediaPlaylist', () => {
    it('absolutizes segment URIs and EXT-X-MAP against the ORIGINAL URL', () => {
        const out = rewriteMediaPlaylist(PLAIN_MEDIA_PLAYLIST, {
            playlistUrl: BASE,
        });
        expect(out).toContain(
            'URI="https://cdn.example.com/out/session/stream_720/init.mp4"',
        );
        expect(out).toContain(
            'https://cdn.example.com/out/session/stream_720/segment_0.m4s',
        );
    });

    it('keeps query strings on the playlist URL out of the segment URLs', () => {
        const out = rewriteMediaPlaylist(PLAIN_MEDIA_PLAYLIST, {
            playlistUrl: `${BASE}?token=abc`,
        });
        expect(out).toContain(
            'https://cdn.example.com/out/session/stream_720/segment_0.m4s',
        );
    });

    it('carries query strings on the segment URI through', () => {
        const text = '#EXTM3U\n#EXTINF:4,\nseg.m4s?v=2\n';
        const out = rewriteMediaPlaylist(text, { playlistUrl: BASE });
        expect(out).toContain(
            'https://cdn.example.com/out/session/stream_720/seg.m4s?v=2',
        );
    });

    it('leaves #EXT-X-BYTERANGE untouched — the offsets address ciphertext', () => {
        const out = rewriteMediaPlaylist(ENCRYPTED_MEDIA_PLAYLIST, {
            playlistUrl: BASE,
            keyUri: LUMINARY_KEY_PLACEHOLDER_URI,
        });
        expect(out).toContain('#EXT-X-BYTERANGE:120000@0');
        expect(out).toContain('#EXT-X-BYTERANGE:118000@120000');
    });

    describe('key policy', () => {
        it('normalizes the sentinel URI to the supplied key URI', () => {
            const out = rewriteMediaPlaylist(ENCRYPTED_MEDIA_PLAYLIST, {
                playlistUrl: BASE,
                keyUri: 'fake:served/1',
            });
            expect(out).toContain(
                '#EXT-X-KEY:METHOD=AES-128,URI="fake:served/1",IV=0x00000000000000000000000000000001',
            );
            expect(out).not.toContain(LUMINARY_KEY_PLACEHOLDER_URI);
        });

        it('overrides a REAL key URL — the supplied session key wins', () => {
            const text = ENCRYPTED_MEDIA_PLAYLIST.replace(
                LUMINARY_KEY_PLACEHOLDER_URI,
                'https://keys.example.com/session/abc.key',
            );
            const out = rewriteMediaPlaylist(text, {
                playlistUrl: BASE,
                keyUri: LUMINARY_KEY_PLACEHOLDER_URI,
            });
            expect(out).toContain(`URI="${LUMINARY_KEY_PLACEHOLDER_URI}"`);
            expect(out).not.toContain('keys.example.com');
        });

        it('preserves the IV attribute exactly', () => {
            const out = rewriteMediaPlaylist(ENCRYPTED_MEDIA_PLAYLIST, {
                playlistUrl: BASE,
                keyUri: 'fake:key',
            });
            expect(out).toContain('IV=0x00000000000000000000000000000001');
        });

        it('leaves METHOD=NONE alone', () => {
            const text = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.m4s\n';
            const out = rewriteMediaPlaylist(text, {
                playlistUrl: BASE,
                keyUri: 'fake:key',
            });
            expect(out).toContain('#EXT-X-KEY:METHOD=NONE');
            expect(out).not.toContain('fake:key');
        });

        it('leaves key lines alone when no key URI is supplied', () => {
            const out = rewriteMediaPlaylist(ENCRYPTED_MEDIA_PLAYLIST, {
                playlistUrl: BASE,
            });
            expect(out).toContain(`URI="${LUMINARY_KEY_PLACEHOLDER_URI}"`);
        });

        it('keeps KEYFORMAT attributes while normalizing the URI', () => {
            const text = [
                '#EXTM3U',
                '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x0f,KEYFORMAT="identity",KEYFORMATVERSIONS="1"',
                '#EXTINF:4,',
                'a.m4s',
                '',
            ].join('\n');
            const out = rewriteMediaPlaylist(text, {
                playlistUrl: BASE,
                keyUri: 'fake:key',
            });
            expect(out).toContain(
                '#EXT-X-KEY:METHOD=AES-128,URI="fake:key",IV=0x0f,KEYFORMAT="identity",KEYFORMATVERSIONS="1"',
            );
        });
    });

    it('preserves the #EXTINF spelling and unmodeled tags', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:4.000000,',
            'segment_0.m4s',
            '#EXT-X-ENDLIST',
            '',
        ].join('\n');

        const out = rewriteMediaPlaylist(text, { playlistUrl: BASE });
        expect(out).toContain('#EXTINF:4.000000,');
        expect(out).toContain(
            '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
        );
    });

    it('absolutizes URI attributes on tags the model does not represent', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-RENDITION-REPORT:URI="../audio/playlist.m3u8",LAST-MSN=42',
            '#EXTINF:4,',
            'a.m4s',
            '',
        ].join('\n');

        const out = rewriteMediaPlaylist(text, { playlistUrl: BASE });
        expect(out).toContain(
            'URI="https://cdn.example.com/out/session/audio/playlist.m3u8"',
        );
        expect(out).toContain('LAST-MSN=42');
    });

    it('swaps segment URLs listed in segmentReplacements', () => {
        const absolute =
            'https://cdn.example.com/out/session/stream_720/segment_0.m4s';
        const out = rewriteMediaPlaylist(PLAIN_MEDIA_PLAYLIST, {
            playlistUrl: BASE,
            segmentReplacements: new Map([[absolute, 'fake:served/9']]),
        });
        expect(out).toContain('fake:served/9');
        expect(out).not.toContain(absolute);
    });
});
