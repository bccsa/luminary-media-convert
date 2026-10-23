import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
    buildMasterPlaylist,
    parseMasterPlaylist,
} from '@luminary-media-converter/hls-core';
import { applyAudioTrackEdits, listAudioTracks } from './audio-tracks.js';

/** Two audio tiers, as an encode with a mono fallback writes them. */
const MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_stereo",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="stream_1_English/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_stereo",NAME="Francais",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="stream_2_Francais/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_mono",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="1",URI="stream_3_English/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_mono",NAME="Francais",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="1",URI="stream_4_Francais/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud_stereo"',
    'stream_0/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud_mono"',
    'stream_5/playlist.m3u8',
    '',
].join('\n');

describe('listAudioTracks', () => {
    it('lists each language and name once, with the groups that carry it', () => {
        expect(listAudioTracks(parseMasterPlaylist(MASTER))).toEqual([
            {
                language: 'en',
                name: 'English',
                groups: ['aud_stereo', 'aud_mono'],
                default: true,
            },
            {
                language: 'fr',
                name: 'Francais',
                groups: ['aud_stereo', 'aud_mono'],
                default: false,
            },
        ]);
    });

    it('has nothing to list for a master without audio renditions', () => {
        const muxed =
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nv0/playlist.m3u8\n';
        expect(listAudioTracks(parseMasterPlaylist(muxed))).toEqual([]);
    });
});

describe('applyAudioTrackEdits', () => {
    it('renames a track in every group and changes nothing else', () => {
        const master = parseMasterPlaylist(MASTER);
        applyAudioTrackEdits(master, [
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'fra', name: 'Français' },
            },
        ]);
        const expected = MASTER.replaceAll(
            'NAME="Francais",LANGUAGE="fr"',
            'NAME="Français",LANGUAGE="fra"'
        );
        expect(buildMasterPlaylist(master)).toBe(expected);
    });

    it('changes nothing at all without edits: the master comes back byte for byte', () => {
        const master = parseMasterPlaylist(MASTER);
        applyAudioTrackEdits(master, []);
        expect(buildMasterPlaylist(master)).toBe(MASTER);
    });

    it('can swap two tracks over', () => {
        const master = parseMasterPlaylist(MASTER);
        applyAudioTrackEdits(master, [
            {
                from: { language: 'en', name: 'English' },
                to: { language: 'fr', name: 'Francais' },
            },
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'en', name: 'English' },
            },
        ]);
        expect(listAudioTracks(master).map((t) => t.language)).toEqual([
            'fr',
            'en',
        ]);
    });

    it.each([
        [
            'an unknown track',
            {
                from: { language: 'de', name: 'Deutsch' },
                to: { language: 'de', name: 'Deutsch' },
            },
        ],
        [
            'a language that is not a code',
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'French', name: 'Francais' },
            },
        ],
        [
            'an empty name',
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'fr', name: '  ' },
            },
        ],
        [
            'a name with a quote',
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'fr', name: 'Le "bon" son' },
            },
        ],
        [
            'a name that clashes with another track',
            {
                from: { language: 'fr', name: 'Francais' },
                to: { language: 'en', name: 'English' },
            },
        ],
    ])('refuses %s and leaves the master as it was', (_, edit) => {
        const master = parseMasterPlaylist(MASTER);
        expect(() => applyAudioTrackEdits(master, [edit])).toThrow(
            BadRequestException
        );
        expect(buildMasterPlaylist(master)).toBe(MASTER);
    });

    it('refuses editing one track twice', () => {
        const master = parseMasterPlaylist(MASTER);
        const edit = {
            from: { language: 'fr', name: 'Francais' },
            to: { language: 'fr', name: 'French' },
        };
        expect(() => applyAudioTrackEdits(master, [edit, edit])).toThrow(
            BadRequestException
        );
    });
});
