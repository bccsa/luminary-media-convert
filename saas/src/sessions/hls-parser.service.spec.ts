import { describe, it, expect, beforeEach } from 'vitest';
import { HlsParserService } from './hls-parser.service.js';

describe('HlsParserService', () => {
    let service: HlsParserService;

    beforeEach(() => {
        service = new HlsParserService();
    });

    describe('parseMasterPlaylist', () => {
        it('should parse variants with bandwidth and resolution', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
                'stream_0/playlist.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
                'stream_1/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(2);
            expect(result.variants[0]).toEqual({
                bandwidth: 2000000,
                resolution: '1280x720',
                uri: 'stream_0/playlist.m3u8',
            });
            expect(result.variants[1]).toEqual({
                bandwidth: 800000,
                resolution: '640x360',
                uri: 'stream_1/playlist.m3u8',
            });
        });

        it('should parse variants with codecs', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
                'v0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(1);
            expect(result.variants[0]).toEqual({
                bandwidth: 5000000,
                resolution: '1920x1080',
                codecs: 'avc1.640028,mp4a.40.2',
                uri: 'v0/playlist.m3u8',
            });
        });

        it('should parse audio groups', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",NAME="English",LANGUAGE="en",URI="a0/playlist.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",NAME="Spanish",LANGUAGE="es",URI="a1/playlist.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
                'stream_0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.audioGroups).toHaveLength(2);
            expect(result.audioGroups[0]).toEqual({
                groupId: 'audio_0',
                name: 'English',
                language: 'en',
                uri: 'a0/playlist.m3u8',
            });
            expect(result.audioGroups[1]).toEqual({
                groupId: 'audio_0',
                name: 'Spanish',
                language: 'es',
                uri: 'a1/playlist.m3u8',
            });
        });

        it('should ignore non-AUDIO media types', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs.m3u8"',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",NAME="Main",URI="a0/playlist.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
                'v0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.audioGroups).toHaveLength(1);
            expect(result.audioGroups[0].name).toBe('Main');
        });

        it('should handle audio groups without URI or language', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_0",NAME="Default",DEFAULT=YES',
                '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
                'v0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.audioGroups).toHaveLength(1);
            expect(result.audioGroups[0]).toEqual({
                groupId: 'audio_0',
                name: 'Default',
            });
        });

        it('should return empty arrays for audio-only or minimal playlists', () => {
            const content = '#EXTM3U\n#EXT-X-VERSION:3\n';

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(0);
            expect(result.audioGroups).toHaveLength(0);
        });

        it('should handle variants without resolution (audio-only streams)', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=128000',
                'audio_0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(1);
            expect(result.variants[0]).toEqual({
                bandwidth: 128000,
                uri: 'audio_0/playlist.m3u8',
            });
            expect(result.variants[0].resolution).toBeUndefined();
        });

        it('should handle CRLF line endings', () => {
            const content =
                '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\r\nstream.m3u8\r\n';

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(1);
            expect(result.variants[0].uri).toBe('stream.m3u8');
        });

        it('should parse a full FFmpeg-style master playlist', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="audio_0",DEFAULT=YES,URI="stream_2/index.m3u8"',
                '',
                '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_A1"',
                'stream_0/index.m3u8',
                '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_A1"',
                'stream_1/index.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(2);
            expect(result.audioGroups).toHaveLength(1);
            expect(result.variants[0].bandwidth).toBe(4500000);
            expect(result.variants[0].resolution).toBe('1920x1080');
            expect(result.variants[1].bandwidth).toBe(2000000);
            expect(result.audioGroups[0].groupId).toBe('group_A1');
            expect(result.audioGroups[0].uri).toBe(
                'stream_2/index.m3u8',
            );
        });

        it('should skip blank lines between STREAM-INF and URI', () => {
            const content = [
                '#EXTM3U',
                '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
                '',
                'stream_0/playlist.m3u8',
            ].join('\n');

            const result = service.parseMasterPlaylist(content);

            expect(result.variants).toHaveLength(1);
            expect(result.variants[0].uri).toBe('stream_0/playlist.m3u8');
        });
    });
});
