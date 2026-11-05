import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseMasterPlaylist } from '@luminary-media-converter/hls-core';
import {
    listSubtitleTracks,
    removeSubtitleLines,
    segmentUriOf,
    subtitleFileNames,
    subtitlePlaylist,
    upsertSubtitleLines,
} from './subtitle-tracks.js';

const MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_mid",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="stream_mid/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_mid"',
    'stream_720p/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_mid"',
    'stream_360p/playlist.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="stream_720p/iframes.m3u8"',
    '',
].join('\n');

const fr = { language: 'fr', name: 'Français', uri: 'subtitles/fr_aa.m3u8' };
const en = { language: 'en', name: 'English', uri: 'subtitles/en_bb.m3u8' };

describe('upsertSubtitleLines', () => {
    it("gives a video its first subtitles: a rendition, not on by itself, and every variant joins the group", () => {
        const out = upsertSubtitleLines(MASTER, fr);
        const lines = out.split('\n');
        expect(lines[3]).toBe(
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,URI="subtitles/fr_aa.m3u8"'
        );
        expect(lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:'))).toEqual([
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_mid",SUBTITLES="subs"',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_mid",SUBTITLES="subs"',
        ]);
        // An I-frame variant takes no SUBTITLES.
        expect(lines.at(-2)).toBe('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="stream_720p/iframes.m3u8"');

        // The players see it as the encoder lists it.
        const parsed = parseMasterPlaylist(out);
        expect(parsed.variants.every((v) => v.subtitlesGroup === 'subs')).toBe(true);
        expect(listSubtitleTracks(parsed)).toEqual([
            { language: 'fr', name: 'Français', uri: 'subtitles/fr_aa.m3u8', default: false },
        ]);
    });

    it('adds another language after the first, leaving the variants as they are', () => {
        const once = upsertSubtitleLines(MASTER, fr);
        const twice = upsertSubtitleLines(once, en);
        const lines = twice.split('\n');
        expect(lines[4]).toContain('LANGUAGE="en"');
        expect(twice.match(/SUBTITLES="subs"/g)).toHaveLength(2);
        expect(listSubtitleTracks(parseMasterPlaylist(twice)).map((t) => t.language)).toEqual(['fr', 'en']);
    });

    it('moves a language it has to its new files and name, keeping the rest of its line', () => {
        const once = upsertSubtitleLines(MASTER, fr).replace('DEFAULT=NO', 'DEFAULT=YES');
        const again = upsertSubtitleLines(once, { ...fr, name: 'French', uri: 'subtitles/fr_cc.m3u8' });
        expect(again.split('\n')[3]).toBe(
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="subtitles/fr_cc.m3u8"'
        );
        expect(again.match(/TYPE=SUBTITLES/g)).toHaveLength(1);
    });

    it("joins the group a video's subtitles already have", () => {
        const master = MASTER.replace(
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Deutsch",LANGUAGE="de",URI="text/de.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000'
        ).replace(/AUDIO="group_mid"\n/g, 'AUDIO="group_mid",SUBTITLES="text"\n');
        const out = upsertSubtitleLines(master, fr);
        expect(out).toContain('GROUP-ID="text",NAME="Français"');
        expect(out).not.toContain('"subs"');
    });

    it('refuses a bad language, or a name another language has', () => {
        expect(() => upsertSubtitleLines(MASTER, { ...fr, language: 'French' })).toThrow(BadRequestException);
        const once = upsertSubtitleLines(MASTER, fr);
        expect(() => upsertSubtitleLines(once, { ...en, name: 'Français' })).toThrow(/already called/);
    });

    it('keeps CRLF line ends', () => {
        const out = upsertSubtitleLines(MASTER.replace(/\n/g, '\r\n'), fr);
        expect(out.split('\r\n')).toHaveLength(MASTER.split('\n').length + 1);
        expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    });
});

describe('removeSubtitleLines', () => {
    it('takes a language out, and the variants leave the group with the last one', () => {
        const both = upsertSubtitleLines(upsertSubtitleLines(MASTER, fr), en);
        const one = removeSubtitleLines(both, 'fr');
        expect(one.uri).toBe('subtitles/fr_aa.m3u8');
        expect(one.text).not.toContain('LANGUAGE="fr"');
        expect(one.text.match(/SUBTITLES="subs"/g)).toHaveLength(2);

        const none = removeSubtitleLines(one.text, 'en');
        expect(none.text).toBe(MASTER);
    });

    it('refuses a language the video has no subtitles in', () => {
        expect(() => removeSubtitleLines(MASTER, 'fr')).toThrow(BadRequestException);
        expect(() => removeSubtitleLines(upsertSubtitleLines(MASTER, fr), 'en')).toThrow(/no "en"/);
    });
});

describe('a language’s files', () => {
    it('is a one-segment playlist the length of the video, in a new name each save', () => {
        const names = subtitleFileNames('fr', '1a2b');
        expect(names).toEqual({ playlist: 'subtitles/fr_1a2b.m3u8', vtt: 'fr_1a2b.vtt' });
        const playlist = subtitlePlaylist(names.vtt, 3599.4);
        expect(playlist).toContain('#EXT-X-TARGETDURATION:3600');
        expect(playlist).toContain('#EXTINF:3599.400,');
        expect(playlist).toContain('#EXT-X-ENDLIST');
        expect(segmentUriOf(playlist)).toBe('fr_1a2b.vtt');
    });
});
