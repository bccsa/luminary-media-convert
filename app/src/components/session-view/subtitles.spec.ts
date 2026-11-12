import { describe, expect, it } from 'vitest';
import {
    compareRows,
    copyTimings,
    languageName,
    readSubtitleFile,
    shiftLines,
    shortTime,
    subtitlesToSrt,
    subtitlesToVtt,
} from './subtitles';

const SRT = [
    '﻿1',
    '00:00:01,000 --> 00:00:03,500',
    'Hello <i>there</i>',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    'Tom & Jerry',
    'second line',
    '',
].join('\r\n');

const cue = (inSec: number, outSec: number, label: string) => ({ id: `${inSec}`, inSec, outSec, label });

describe('readSubtitleFile', () => {
    it('reads an .srt file: numbered cues, comma milliseconds, no header, a BOM and CRLF', () => {
        const cues = readSubtitleFile(SRT);
        expect(cues.map((c) => [c.inSec, c.outSec, c.label])).toEqual([
            [1, 3.5, 'Hello <i>there</i>'],
            [4, 6, 'Tom & Jerry\nsecond line'],
        ]);
    });

    it("reads a .vtt file, undoing WebVTT's escapes", () => {
        const cues = readSubtitleFile('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry &lt;3\n');
        expect(cues[0]!.label).toBe('Tom & Jerry <3');
    });
});

describe('writing subtitles', () => {
    const cues = readSubtitleFile(SRT);

    it('writes WebVTT that keeps the shared tags and escapes the rest', () => {
        expect(subtitlesToVtt([...cues, cue(7, 8, 'a < b')])).toBe(
            [
                'WEBVTT',
                '',
                '1',
                '00:00:01.000 --> 00:00:03.500',
                'Hello <i>there</i>',
                '',
                '2',
                '00:00:04.000 --> 00:00:06.000',
                'Tom &amp; Jerry\nsecond line',
                '',
                '3',
                '00:00:07.000 --> 00:00:08.000',
                'a &lt; b',
                '',
            ].join('\n')
        );
    });

    it('writes .srt as it was read, and the two round-trip', () => {
        const srt = subtitlesToSrt(cues);
        expect(srt).toBe(
            '1\n00:00:01,000 --> 00:00:03,500\nHello <i>there</i>\n\n2\n00:00:04,000 --> 00:00:06,000\nTom & Jerry\nsecond line\n'
        );
        expect(readSubtitleFile(subtitlesToVtt(readSubtitleFile(srt))).map((c) => c.label)).toEqual(
            cues.map((c) => c.label)
        );
    });

    it('leaves out cues without words, and orders by time', () => {
        expect(subtitlesToSrt([cue(5, 6, 'later'), cue(1, 2, '  '), cue(2, 3, 'first')])).toBe(
            '1\n00:00:02,000 --> 00:00:03,000\nfirst\n\n2\n00:00:05,000 --> 00:00:06,000\nlater\n'
        );
    });

    describe('WebVTT tags', () => {
        const vttText = (label: string) => subtitlesToVtt([cue(1, 2, label)]).split('\n')[4];

        it.each([
            ['voice', '<v Roger Bingham>We are in New York City</v>'],
            ['voice with a class', '<v.loud Esme>Hello</v>'],
            ['class', 'The <c.yellow.bg_blue>sky</c> is blue'],
            ['bold, italic and underline with classes', '<b.loud>Go</b> <i.sung>now</i> <u.x>here</u>'],
            ['ruby', '<ruby>漢<rt>kan</rt>字<rt>ji</rt></ruby>'],
            ['language', '<lang en-GB>colour</lang>'],
            ['timestamp', 'Never <00:00:01.500>drink <01:00:02.000>liquid'],
        ])('keeps %s', (_kind, text) => {
            expect(vttText(text)).toBe(text);
        });

        it('escapes text that only looks like a tag', () => {
            expect(vttText('<script>x</script> <v> <lang> a<b <c.> <00:01.5> <br/>')).toBe(
                '&lt;script&gt;x&lt;/script&gt; &lt;v&gt; &lt;lang&gt; a&lt;b &lt;c.&gt; &lt;00:01.5&gt; &lt;br/&gt;'
            );
        });

        it('escapes & and > in the text around the tags', () => {
            expect(vttText('<v Tom>Tom & Jerry -> home</v>')).toBe('<v Tom>Tom &amp; Jerry -&gt; home</v>');
        });

        it('read back, the cue is as it was typed', () => {
            const text = '<v Tom>Tom & <c.red>Jerry</c> <3</v>';
            expect(readSubtitleFile(subtitlesToVtt([cue(1, 2, text)]))[0]!.label).toBe(text);
        });

        it('.srt keeps only the tags it shares with WebVTT', () => {
            expect(subtitlesToSrt([cue(1, 2, '<v Tom>Hi <i>you</i> <c.red>there</c></v> <3')])).toBe(
                '1\n00:00:01,000 --> 00:00:02,000\nHi <i>you</i> there <3\n'
            );
        });
    });
});

describe('translating', () => {
    const original = [cue(1, 3, 'Hello'), cue(4, 6, 'How are you?'), cue(7, 9, 'Goodbye')];

    it("starts a language on the original's timings, with no words yet", () => {
        const copy = copyTimings(original);
        expect(copy.map((c) => [c.inSec, c.outSec, c.label])).toEqual([
            [1, 3, ''],
            [4, 6, ''],
            [7, 9, ''],
        ]);
        expect(copy[0]!.id).not.toBe(original[0]!.id);
    });

    it("puts what the original says beside each cue, and shows the original's lines no cue covers", () => {
        const translation = [cue(1, 3.2, 'Bonjour'), cue(3.5, 6.5, 'Comment ça va ?')];
        const rows = compareRows(original, translation);
        expect(rows.map((r) => [r.inSec, r.original, r.cue?.label])).toEqual([
            [1, 'Hello', 'Bonjour'],
            [3.5, 'How are you?', 'Comment ça va ?'],
            [7, 'Goodbye', undefined],
        ]);
    });

    it('joins the original lines a long cue spans', () => {
        const rows = compareRows(original, [cue(0, 10, 'Tout')]);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.original).toBe('Hello\nHow are you?\nGoodbye');
    });
});

describe('languageName', () => {
    it('names a language in itself, and falls back to its code', () => {
        expect(languageName('fr')).toBe('Français');
        expect(languageName('en')).toBe('English');
        expect(languageName('not a code')).toBe('not a code');
    });
});

describe('shiftLines', () => {
    const cues = [
        { id: 'a', inSec: 0.4, outSec: 1, label: 'gone' },
        { id: 'b', inSec: 1, outSec: 3, label: 'clipped' },
        { id: 'c', inSec: 5, outSec: 6, label: 'moved' },
    ];

    it('moves every line, later or earlier, keeping what still shows', () => {
        expect(shiftLines(cues, 2).map((c) => [c.inSec, c.outSec])).toEqual([[2.4, 3], [3, 5], [7, 8]]);
        expect(shiftLines(cues, -1.5).map((c) => [c.label, c.inSec, c.outSec])).toEqual([
            ['clipped', 0, 1.5],
            ['moved', 3.5, 4.5],
        ]);
    });
});

describe('shortTime', () => {
    it('reads as a list shows it', () => {
        expect(shortTime(12.46)).toBe('0:12.5');
        expect(shortTime(62)).toBe('1:02.0');
        expect(shortTime(3723)).toBe('1:02:03.0');
    });
});
