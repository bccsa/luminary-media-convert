import { describe, expect, it } from 'vitest';
import { relabelGeneratedSubtitleNames } from './relabel.js';

const master = (lines: string[]): string => ['#EXTM3U', ...lines, ''].join('\n');
const subtitle = (name: string, language: string, group = 'subs'): string =>
    `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${group}",NAME="${name}",LANGUAGE="${language}",DEFAULT=NO,URI="${name}.m3u8"`;

describe('relabelGeneratedSubtitleNames', () => {
    it('names a generated subtitle by its language, in the viewer\'s language', () => {
        const text = master([subtitle('stream_0', 'en'), subtitle('stream_2', 'fr'), subtitle('Track 3', 'el')]);
        expect(relabelGeneratedSubtitleNames(text, 'en')).toContain('NAME="English"');
        expect(relabelGeneratedSubtitleNames(text, 'en')).toContain('NAME="French"');
        expect(relabelGeneratedSubtitleNames(text, 'en')).toContain('NAME="Greek"');
        expect(relabelGeneratedSubtitleNames(text, 'fr')).toContain('NAME="Français"');
    });

    it('leaves a name a person wrote, and a track with no language', () => {
        const text = master([subtitle('English SDH', 'en'), '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="stream_1",URI="x.m3u8"']);
        expect(relabelGeneratedSubtitleNames(text, 'en')).toBe(text);
    });

    it('numbers two generated tracks of one language in a group, and leaves audio and the rest of the text alone', () => {
        const text = master([
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="stream_9",LANGUAGE="en",URI="a.m3u8"',
            subtitle('stream_0', 'en'),
            subtitle('stream_1', 'en'),
            '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"',
            'v.m3u8',
        ]);
        const out = relabelGeneratedSubtitleNames(text, 'en');
        expect(out).toContain('NAME="English",LANGUAGE="en"');
        expect(out).toContain('NAME="English 2"');
        expect(out).toContain('TYPE=AUDIO,GROUP-ID="aud",NAME="stream_9"');
        expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nv.m3u8');
    });

    it('does nothing for a master with no subtitles, or a language that is not one', () => {
        const plain = master(['#EXT-X-STREAM-INF:BANDWIDTH=1000', 'v.m3u8']);
        expect(relabelGeneratedSubtitleNames(plain, 'en')).toBe(plain);
        const odd = master([subtitle('stream_0', 'not a code!')]);
        expect(relabelGeneratedSubtitleNames(odd, 'en')).toBe(odd);
    });
});
