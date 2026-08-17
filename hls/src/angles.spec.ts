import { describe, it, expect } from 'vitest';
import {
    extractAngle,
    extractAnglePlaylist,
    extractAudioOnlyPlaylist,
    listAngles,
    listVideoAngles,
} from './angles';
import { buildMasterPlaylist } from './build';
import { parseMasterPlaylist } from './parse';
import {
    AUDIO_ONLY_MASTER,
    MULTI_ANGLE_MASTER,
    MULTI_ANGLE_WITH_SUBTITLES_MASTER,
    SINGLE_ANGLE_MASTER,
} from './fixtures';

describe('listVideoAngles', () => {
    it('lists the video rendition groups of a multi-angle master', () => {
        expect(listVideoAngles(MULTI_ANGLE_MASTER)).toEqual([
            { id: 'main', name: 'main', isDefault: true },
            { id: 'pulpit', name: 'pulpit', isDefault: false },
        ]);
    });

    it('returns nothing for a single-angle master', () => {
        expect(listVideoAngles(SINGLE_ANGLE_MASTER)).toEqual([]);
    });

    it('deduplicates a group named by more than one media entry', () => {
        const master = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="Main",DEFAULT=YES',
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="Main again"',
        ].join('\n');
        expect(listVideoAngles(master)).toHaveLength(1);
    });

    it('works against an already-parsed master', () => {
        expect(listAngles(parseMasterPlaylist(MULTI_ANGLE_MASTER))).toEqual(
            listVideoAngles(MULTI_ANGLE_MASTER)
        );
    });
});

describe('extractAngle', () => {
    it('keeps only the chosen angle and drops the VIDEO plumbing', () => {
        const master = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        const pinned = extractAngle(master, 'pulpit');

        expect(pinned.variants).toHaveLength(1);
        expect(pinned.variants[0].uri).toBe('stream_pulpit_854x480/playlist.m3u8');
        expect(pinned.variants[0].videoGroup).toBeUndefined();
        expect(pinned.videoGroups).toEqual([]);
        expect(pinned.media.map((m) => m.type)).toEqual(['AUDIO']);
    });

    it('does not touch the master it was given', () => {
        const master = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        const before = JSON.parse(JSON.stringify(master));

        extractAngle(master, 'main');

        expect(JSON.parse(JSON.stringify(master))).toEqual(before);
    });

    it('returns the same object when there is nothing to narrow', () => {
        const single = parseMasterPlaylist(SINGLE_ANGLE_MASTER);
        expect(extractAngle(single, 'main')).toBe(single);

        const multi = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        expect(extractAngle(multi, 'nope')).toBe(multi);
    });

    it('carries subtitles, independent-segments and I-frame streams through', () => {
        const master = parseMasterPlaylist(MULTI_ANGLE_WITH_SUBTITLES_MASTER);
        const pinned = extractAngle(master, 'main');

        expect(pinned.independentSegments).toBe(true);
        expect(pinned.media.filter((m) => m.type === 'SUBTITLES')).toHaveLength(2);
        expect(pinned.iFrameStreams).toHaveLength(1);
        expect(pinned.iFrameStreams![0].videoGroup).toBeUndefined();
    });

    it('drops I-frame streams belonging to a different angle', () => {
        const master = parseMasterPlaylist(MULTI_ANGLE_WITH_SUBTITLES_MASTER);
        expect(extractAngle(master, 'pulpit').iFrameStreams).toBeUndefined();
    });

    it('builds a playlist that still parses as the narrowed master', () => {
        const pinned = extractAngle(
            parseMasterPlaylist(MULTI_ANGLE_WITH_SUBTITLES_MASTER),
            'main'
        );
        const reparsed = parseMasterPlaylist(buildMasterPlaylist(pinned));

        expect(reparsed.variants.map((v) => v.uri)).toEqual(
            pinned.variants.map((v) => v.uri)
        );
        expect(reparsed.videoGroups).toEqual([]);
        expect(reparsed.independentSegments).toBe(true);
    });

    it('composes with a quality cap applied to the narrowed model', () => {
        const master = parseMasterPlaylist(MULTI_ANGLE_MASTER);
        const pinned = extractAngle(master, 'main');
        const capped = {
            ...pinned,
            variants: pinned.variants.filter(
                (v) => (v.resolutionParsed?.height ?? 0) <= 480
            ),
        };

        expect(buildMasterPlaylist(capped)).not.toContain('1280x720');
    });
});

describe('extractAnglePlaylist', () => {
    it('narrows a multi-angle master to one angle', () => {
        expect(extractAnglePlaylist(MULTI_ANGLE_MASTER, 'main')).toBe(
            [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=4177777,AVERAGE-BANDWIDTH=3822202,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0"',
                'stream_main_1280x720/playlist.m3u8',
                '',
            ].join('\n')
        );
    });

    it('returns the master untouched when it has no angles', () => {
        expect(extractAnglePlaylist(SINGLE_ANGLE_MASTER, 'main')).toBe(
            SINGLE_ANGLE_MASTER
        );
    });

    it('returns the master untouched when the angle matches nothing', () => {
        expect(extractAnglePlaylist(MULTI_ANGLE_MASTER, 'nope')).toBe(
            MULTI_ANGLE_MASTER
        );
    });
});

describe('extractAudioOnlyPlaylist', () => {
    it('promotes each audio group to a variant of its own', () => {
        expect(extractAudioOnlyPlaylist(MULTI_ANGLE_MASTER)).toBe(
            [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
                '',
                '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="group_tier_0"',
                'stream_English_128kbps/playlist.m3u8',
                '',
            ].join('\n')
        );
    });

    it('carries no video URI at all', () => {
        const audioOnly = extractAudioOnlyPlaylist(MULTI_ANGLE_MASTER)!;
        expect(audioOnly).not.toContain('stream_main_1280x720');
        expect(audioOnly).not.toContain('stream_pulpit_854x480');
        expect(audioOnly).not.toContain('RESOLUTION=');
    });

    it('returns null when the master has no audio rendition groups', () => {
        const noAudio = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
            'v0/playlist.m3u8',
        ].join('\n');
        expect(extractAudioOnlyPlaylist(noAudio)).toBeNull();
    });

    it('handles a master that is already audio-only', () => {
        expect(extractAudioOnlyPlaylist(AUDIO_ONLY_MASTER)).toContain(
            'AUDIO="group_tier_0"'
        );
    });
});
