import { describe, it, expect } from 'vitest';
import { matchesPreferredLanguage, findPreferredTrack } from '../src/audioTrackLanguage';

describe('matchesPreferredLanguage', () => {
    it('matches across the code sets a browser might report', () => {
        // iOS Safari says `en`, Android Chrome says `eng`; the host asked once.
        expect(matchesPreferredLanguage('en', 'eng')).toBe(true);
        expect(matchesPreferredLanguage('eng', 'en')).toBe(true);
    });

    it('treats the bibliographic and terminological codes as one language', () => {
        // ger/deu are both German, and which one a device picks is not a rule.
        expect(matchesPreferredLanguage('ger', 'deu')).toBe(true);
        expect(matchesPreferredLanguage('ger', 'de')).toBe(true);
        expect(matchesPreferredLanguage('deu', 'ger')).toBe(true);
    });

    it('canonicalises the host side too, not only the track', () => {
        // The failing case in the earlier version: only the track was mapped.
        expect(matchesPreferredLanguage('fr', 'fra')).toBe(true);
        expect(matchesPreferredLanguage('fre', 'fra')).toBe(true);
    });

    it('ignores region and case', () => {
        expect(matchesPreferredLanguage('en-US', 'EN')).toBe(true);
        expect(matchesPreferredLanguage('pt-BR', 'por')).toBe(true);
    });

    it('still matches a language that has no two-letter code', () => {
        expect(matchesPreferredLanguage('fil', 'fil')).toBe(true);
        expect(matchesPreferredLanguage('haw', 'HAW')).toBe(true);
    });

    it('does not match different languages', () => {
        expect(matchesPreferredLanguage('en', 'de')).toBe(false);
        expect(matchesPreferredLanguage('eng', 'ger')).toBe(false);
    });

    it('never matches an unknown language', () => {
        // "unknown" is not a language; matching it would enable a wrong track.
        expect(matchesPreferredLanguage('', 'en')).toBe(false);
        expect(matchesPreferredLanguage('en', '')).toBe(false);
        expect(matchesPreferredLanguage(null, null)).toBe(false);
        expect(matchesPreferredLanguage(undefined, 'en')).toBe(false);
    });
});

describe('findPreferredTrack', () => {
    const tracks = [
        { id: 'a', lang: 'eng' },
        { id: 'b', lang: 'deu' },
        { id: 'c', lang: 'ger' },
        { id: 'd' },
    ];

    it('finds the track by any spelling of the language', () => {
        expect(findPreferredTrack(tracks, 'en')).toBe('a');
        expect(findPreferredTrack(tracks, 'de')).toBe('b');
    });

    it('takes the first of two tracks naming one language', () => {
        // deu before ger: picking between them by any invented rule is guessing.
        expect(findPreferredTrack(tracks, 'ger')).toBe('b');
    });

    it('returns null rather than selecting nothing', () => {
        // Null means "leave the selection alone"; selecting nothing mutes the video.
        expect(findPreferredTrack(tracks, 'fr')).toBeNull();
        expect(findPreferredTrack(tracks, null)).toBeNull();
        expect(findPreferredTrack([], 'en')).toBeNull();
    });

    it('skips a track with no language rather than treating it as a match', () => {
        expect(findPreferredTrack([{ id: 'd' }], 'en')).toBeNull();
    });
});
