import { describe, expect, it } from 'vitest';
import {
    ISO_639_2_CODES,
    LANGUAGE_OPTIONS,
    isValidLanguageCode,
    languageName,
    normalizeLanguageInput,
} from './language-codes';

describe('normalizeLanguageInput', () => {
    it('lower-cases and trims, so ENG and eng are one entry', () => {
        // These strings reach `#EXT-X-MEDIA:LANGUAGE=` verbatim; a player
        // matching on them sees two languages where the user meant one.
        expect(normalizeLanguageInput('ENG')).toBe('eng');
        expect(normalizeLanguageInput('  Eng ')).toBe('eng');
        expect(normalizeLanguageInput('eng')).toBe('eng');
    });

    it('treats absent and blank alike', () => {
        expect(normalizeLanguageInput(undefined)).toBe('');
        expect(normalizeLanguageInput(null)).toBe('');
        expect(normalizeLanguageInput('   ')).toBe('');
    });
});

describe('isValidLanguageCode', () => {
    it('accepts mul and und, which are codes and not escape hatches', () => {
        // Both are in the register — multiple languages, and undetermined — and
        // this app already emits `und` for an untagged track.
        expect(isValidLanguageCode('und')).toBe(true);
        expect(isValidLanguageCode('mul')).toBe(true);
    });

    it('accepts both the bibliographic and terminology code for one language', () => {
        // ger/deu and fre/fra are both German and both French. Refusing either
        // would refuse a correct answer.
        for (const code of ['ger', 'deu', 'fre', 'fra']) {
            expect(isValidLanguageCode(code), code).toBe(true);
        }
    });

    it('accepts a code whatever case it arrives in', () => {
        expect(isValidLanguageCode('ENG')).toBe(true);
        expect(isValidLanguageCode(' Nor ')).toBe(true);
    });

    it('accepts the local-use range, and only within it', () => {
        /*
         * ISO 639-2 reserves qaa–qtz for languages with no registered code, and
         * the register lists them as one range rather than 520 entries — so they
         * cannot be a set membership test, and the literal "qaa-qtz" is not
         * itself a code. Found by a test asserting every code was three letters,
         * which the range entry failed.
         */
        expect(isValidLanguageCode('qaa')).toBe(true);
        expect(isValidLanguageCode('qtz')).toBe(true);
        expect(isValidLanguageCode('qmm')).toBe(true);
        // `que` is a registered code (Quechua) and sits past the range's end,
        // so it passes on membership rather than on the pattern.
        expect(isValidLanguageCode('que')).toBe(true);
        // `quz` is Cusco Quechua in ISO 639-**3**, which this field is not.
        // Outside the local-use range too, so it is refused — the register is
        // the authority here, and 639-3 has thousands of codes HLS does not
        // want in a LANGUAGE attribute.
        expect(isValidLanguageCode('quz')).toBe(false);
        expect(isValidLanguageCode('qzz')).toBe(false);
        // The range's own name is not a code.
        expect(isValidLanguageCode('qaa-qtz')).toBe(false);
    });

    it('rejects a three-letter string that is not a language', () => {
        // The point of validating against the register rather than /^[a-z]{3}$/:
        // this has the shape of a code and travels all the way to the player.
        expect(isValidLanguageCode('zzz')).toBe(false);
        expect(isValidLanguageCode('xxy')).toBe(false);
    });

    it('rejects two-letter ISO 639-1 codes, which HLS does not want here', () => {
        expect(isValidLanguageCode('en')).toBe(false);
        expect(isValidLanguageCode('de')).toBe(false);
    });

    it('accepts empty, because an unstated language is a normal state', () => {
        // The encoder writes no LANGUAGE attribute rather than guessing one.
        expect(isValidLanguageCode('')).toBe(true);
        expect(isValidLanguageCode(undefined)).toBe(true);
    });
});

describe('the register itself', () => {
    it('came from the real list, not a hand-picked subset', () => {
        // ISO 639-2 has ~480 languages, several with two codes. A number this
        // size is the difference between the register and someone's shortlist.
        expect(ISO_639_2_CODES.size).toBeGreaterThan(480);
    });

    it('carries a name for every code it accepts', () => {
        // The names are what make the picker usable — nobody remembers `nob`.
        const nameless = [...ISO_639_2_CODES].filter((c) => !languageName(c));
        expect(nameless).toEqual([]);
    });

    it('holds every code exactly once, and all of them three letters', () => {
        const codes = LANGUAGE_OPTIONS.map(([code]) => code);
        expect(new Set(codes).size).toBe(codes.length);
        expect(codes.filter((c) => !/^[a-z]{3}$/.test(c))).toEqual([]);
    });

    it('names the codes this app is most likely to write', () => {
        expect(languageName('eng')).toBe('English');
        expect(languageName('und')).toBe('Undetermined');
        expect(languageName('nor')).toBe('Norwegian');
    });
});
