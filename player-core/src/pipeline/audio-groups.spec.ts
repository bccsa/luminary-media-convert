import { describe, expect, it } from 'vitest';
import { collapseAudioGroups } from './audio-groups.js';

/** As Nimble serves it: each language in a stereo and a mono group, each rendition once per group. */
const NIMBLE = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="Stereo",LANGUAGE="mul",NAME="Untranslated",DEFAULT="YES",AUTOSELECT="YES",URI="a.m3u8?i=1"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="Mono",LANGUAGE="mul",NAME="Untranslated",DEFAULT="NO",AUTOSELECT="YES",URI="a.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="Stereo",LANGUAGE="eng",NAME="English",DEFAULT="NO",AUTOSELECT="YES",URI="a.m3u8?i=4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="Mono",LANGUAGE="eng",NAME="English",DEFAULT="NO",AUTOSELECT="YES",URI="a.m3u8?i=3"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="Stereo",NAME="Main - 720p"',
    'v.m3u8?i=4',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="Mono",NAME="Main - 720p"',
    'v.m3u8?i=4',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240,AUDIO="Stereo",NAME="Main - 240p"',
    'v.m3u8?i=1',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240,AUDIO="Mono",NAME="Main - 240p"',
    'v.m3u8?i=1',
].join('\n');

describe('collapseAudioGroups', () => {
    it('keeps one of two groups holding the same languages, and the renditions that use it', () => {
        const out = collapseAudioGroups(NIMBLE);
        expect(out).not.toContain('GROUP-ID="Mono"');
        expect(out).not.toContain('AUDIO="Mono"');
        expect(out.match(/TYPE=AUDIO/g)).toHaveLength(2);
        expect(out.match(/#EXT-X-STREAM-INF/g)).toHaveLength(2);
        expect(out).toContain('v.m3u8?i=4');
        expect(out).toContain('v.m3u8?i=1');
    });

    it('keeps the group with more channels', () => {
        const withChannels = NIMBLE.replace(/GROUP-ID="Mono",/g, 'GROUP-ID="Mono",CHANNELS="6",');
        const out = collapseAudioGroups(withChannels);
        expect(out).toContain('GROUP-ID="Mono"');
        expect(out).not.toContain('GROUP-ID="Stereo"');
    });

    it('leaves groups with different languages alone', () => {
        const different = NIMBLE.replace('GROUP-ID="Mono",LANGUAGE="eng",NAME="English"', 'GROUP-ID="Mono",LANGUAGE="fra",NAME="Français"');
        expect(collapseAudioGroups(different)).toBe(different);
    });

    it('leaves a group alone when a rendition on it has no twin on the group kept', () => {
        const lonely = `${NIMBLE}\n#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=256x144,AUDIO="Mono"\nv.m3u8?i=0`;
        expect(collapseAudioGroups(lonely)).toBe(lonely);
    });

    it('leaves a master with one audio group, or none, as it is', () => {
        const single = NIMBLE.split('\n').filter((line) => !line.includes('Mono')).join('\n');
        expect(collapseAudioGroups(single)).toBe(single);
        const none = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8';
        expect(collapseAudioGroups(none)).toBe(none);
    });
});
