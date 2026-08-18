import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist, type HlsParsedMaster } from './parse.js';
import { buildMasterPlaylist } from './build.js';

const EMPTY: HlsParsedMaster = {
    variants: [],
    media: [],
    audioGroups: [],
    videoGroups: [],
};

describe('buildMasterPlaylist', () => {
    it('produces an #EXTM3U header', () => {
        const out = buildMasterPlaylist(EMPTY);
        expect(out.startsWith('#EXTM3U\n')).toBe(true);
    });

    it('emits STREAM-INF with URI on the next line', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            variants: [{ bandwidth: 1000000, resolution: '1280x720', codecs: 'avc1.64001f', uri: 'v0/p.m3u8' }],
        });
        expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f"\nv0/p.m3u8');
    });

    it('emits audio media before subtitles before closed-captions', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            media: [
                { type: 'SUBTITLES', groupId: 'subs', name: 'English', language: 'en', uri: 'subtitles/en.vtt' },
                { type: 'AUDIO', groupId: 'aud', name: 'English' },
            ],
        });
        const audioIdx = out.indexOf('TYPE=AUDIO');
        const subIdx = out.indexOf('TYPE=SUBTITLES');
        expect(audioIdx).toBeGreaterThan(-1);
        expect(subIdx).toBeGreaterThan(audioIdx);
    });

    it('lowercases LANGUAGE attributes when building media entries', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            media: [
                { type: 'AUDIO', groupId: 'aud', name: 'English', language: 'EN', uri: 'audio/en.m3u8' },
            ],
        });
        expect(out).toContain('LANGUAGE="en"');
    });

    it('emits an explicit DEFAULT=NO, and nothing at all when the flag is absent', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            media: [
                { type: 'VIDEO', groupId: 'main', name: 'Main', default: true },
                { type: 'VIDEO', groupId: 'side', name: 'Side', default: false },
                { type: 'VIDEO', groupId: 'other', name: 'Other' },
            ],
        });
        expect(out).toContain('GROUP-ID="main",NAME="Main",DEFAULT=YES');
        expect(out).toContain('GROUP-ID="side",NAME="Side",DEFAULT=NO');
        expect(out).toContain('GROUP-ID="other",NAME="Other"\n');
    });

    it('writes the version and independent-segments header', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            version: 7,
            independentSegments: true,
        });
        expect(out).toBe('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n');
    });

    it('emits group references and extended bitrate attributes', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            variants: [
                {
                    bandwidth: 1000000,
                    averageBandwidth: 900000,
                    resolutionParsed: { width: 1280, height: 720 },
                    frameRate: 25,
                    codecs: 'avc1.64001f,mp4a.40.2',
                    videoGroup: 'main',
                    audioGroup: 'aud',
                    subtitlesGroup: 'subs',
                    uri: 'v0/p.m3u8',
                },
            ],
        });
        expect(out).toContain(
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=900000,RESOLUTION=1280x720,FRAME-RATE=25,CODECS="avc1.64001f,mp4a.40.2",VIDEO="main",AUDIO="aud",SUBTITLES="subs"'
        );
    });

    it('emits I-frame streams', () => {
        const out = buildMasterPlaylist({
            ...EMPTY,
            iFrameStreams: [
                { bandwidth: 180000, resolution: '1280x720', uri: 'v0/iframes.m3u8' },
            ],
        });
        expect(out).toContain(
            '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,RESOLUTION=1280x720,URI="v0/iframes.m3u8"'
        );
    });

    it('round-trips parse → build → parse', () => {
        const original = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Forced",LANGUAGE="en",FORCED=YES,URI="subtitles/en-forced.vtt"',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
            'v0/playlist.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360',
            'v1/playlist.m3u8',
        ].join('\n');

        const parsed1: HlsParsedMaster = parseMasterPlaylist(original);
        const rebuilt = buildMasterPlaylist(parsed1);
        const parsed2 = parseMasterPlaylist(rebuilt);

        expect(parsed2.variants).toEqual(parsed1.variants);
        expect(parsed2.media).toEqual(parsed1.media);
        expect(parsed2.audioGroups).toEqual(parsed1.audioGroups);
    });

    it('round-trips a playlist with no media entries', () => {
        const original = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1920x1080',
            'v0/playlist.m3u8',
        ].join('\n');

        const p1 = parseMasterPlaylist(original);
        const p2 = parseMasterPlaylist(buildMasterPlaylist(p1));
        expect(p2).toEqual(p1);
    });

    it('round-trips an audio-only master (no STREAM-INF with RESOLUTION)', () => {
        const original = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
            'audio/playlist.m3u8',
        ].join('\n');

        const p1 = parseMasterPlaylist(original);
        const p2 = parseMasterPlaylist(buildMasterPlaylist(p1));
        expect(p2).toEqual(p1);
    });
});
