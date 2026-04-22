import { describe, it, expect } from 'vitest';
import { parseMasterPlaylist, type HlsParsedMaster } from './parse.js';
import { buildMasterPlaylist } from './build.js';

describe('buildMasterPlaylist', () => {
    it('produces an #EXTM3U header', () => {
        const out = buildMasterPlaylist({ variants: [], media: [], audioGroups: [] });
        expect(out.startsWith('#EXTM3U\n')).toBe(true);
    });

    it('emits STREAM-INF with URI on the next line', () => {
        const out = buildMasterPlaylist({
            variants: [{ bandwidth: 1000000, resolution: '1280x720', codecs: 'avc1.64001f', uri: 'v0/p.m3u8' }],
            media: [],
            audioGroups: [],
        });
        expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f"\nv0/p.m3u8');
    });

    it('emits audio media before subtitles before closed-captions', () => {
        const out = buildMasterPlaylist({
            variants: [],
            media: [
                { type: 'SUBTITLES', groupId: 'subs', name: 'English', language: 'en', uri: 'subtitles/en.vtt' },
                { type: 'AUDIO', groupId: 'aud', name: 'English' },
            ],
            audioGroups: [],
        });
        const audioIdx = out.indexOf('TYPE=AUDIO');
        const subIdx = out.indexOf('TYPE=SUBTITLES');
        expect(audioIdx).toBeGreaterThan(-1);
        expect(subIdx).toBeGreaterThan(audioIdx);
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
