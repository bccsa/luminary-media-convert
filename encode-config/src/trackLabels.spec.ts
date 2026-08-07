import { describe, expect, it } from 'vitest';
import { applySavedTrackLabels } from './trackLabels';
import type { AudioTrackInfo, VideoTrackInfo } from './types';

function audio(
    index: number,
    overrides: Partial<AudioTrackInfo> = {}
): AudioTrackInfo {
    return {
        index,
        codec: 'aac',
        bitrateKbps: 2824,
        channels: 2,
        sampleRate: 48000,
        ...overrides,
    };
}

function video(index: number, name?: string): VideoTrackInfo {
    return {
        index,
        codec: 'hevc',
        width: 1920,
        height: 1080,
        bitrateKbps: 1478,
        frameRate: 50,
        name,
    } as VideoTrackInfo;
}

/** What the broadcast on staging actually carried. */
const fromSource = () => [
    audio(0, { name: 'CH_0_MUL' }),
    audio(1, { name: 'CH_1_ENG' }),
    audio(2, { name: 'CH_2_FRA' }),
    audio(3, { name: 'CH_3_NYA' }),
    audio(4, { name: 'CH_4_SWA' }),
];

/** What someone had typed once against the same layout. */
const savedLabels = {
    audioTrackMetadata: [
        { index: 0, name: 'English', language: 'eng' },
        { index: 1, name: 'NA', language: 'und' },
        { index: 2, name: 'NA', language: 'und' },
        { index: 3, name: 'NA', language: 'und' },
        { index: 4, name: 'NA', language: 'und' },
    ],
};

describe('applySavedTrackLabels', () => {
    describe('automatic restore (overwrite: false)', () => {
        it('keeps names the source provided', () => {
            // Applied unconditionally this replaced five identifiable languages
            // with one "English" and four "NA" — strictly less than the file
            // carried, and unrecoverable from the form.
            const tracks = fromSource();

            applySavedTrackLabels(savedLabels, [], tracks, false);

            expect(tracks.map((t) => t.name)).toEqual([
                'CH_0_MUL',
                'CH_1_ENG',
                'CH_2_FRA',
                'CH_3_NYA',
                'CH_4_SWA',
            ]);
        });

        it('still fills a name the source left blank', () => {
            const tracks = [audio(0), audio(1, { name: 'CH_1_ENG' })];

            applySavedTrackLabels(savedLabels, [], tracks, false);

            expect(tracks[0].name).toBe('English');
            expect(tracks[1].name).toBe('CH_1_ENG');
        });

        it('fills a language the source left blank', () => {
            const tracks = [audio(0, { name: 'CH_0_MUL' })];

            applySavedTrackLabels(savedLabels, [], tracks, false);

            expect(tracks[0].language).toBe('eng');
        });

        it('keeps a language the source provided', () => {
            const tracks = [audio(1, { name: 'CH_1_ENG', language: 'eng' })];

            applySavedTrackLabels(
                { audioTrackMetadata: [{ index: 1, language: 'und' }] },
                [],
                tracks,
                false
            );

            expect(tracks[0].language).toBe('eng');
        });

        it('keeps video track names the source provided', () => {
            const tracks = [video(0, 'Camera A')];

            applySavedTrackLabels(
                { videoTrackNames: [{ index: 0, name: 'Angle 0' }] },
                tracks,
                [],
                false
            );

            expect(tracks[0].name).toBe('Camera A');
        });
    });

    /**
     * The probe now reports no language at all for an untagged stream, where it
     * used to pass ffprobe's literal `und` through. That placeholder is truthy,
     * so the fill-blanks-only guard treated it as a language already present and
     * skipped the saved one — saved names came back and saved languages did not,
     * which read as arbitrary rather than as a rule.
     */
    describe('a source with no language of its own', () => {
        it('restores a saved language onto a track that has none', () => {
            const tracks = [audio(0, { name: 'CH_0_MUL' })];

            applySavedTrackLabels(
                { audioTrackMetadata: [{ index: 0, language: 'nor' }] },
                [],
                tracks,
                false
            );

            expect(tracks[0].language).toBe('nor');
        });

        it('still refuses to overwrite a language the source carries', () => {
            // The rule this guard exists for: real metadata always wins.
            const tracks = [audio(0, { language: 'eng' })];

            applySavedTrackLabels(
                { audioTrackMetadata: [{ index: 0, language: 'nor' }] },
                [],
                tracks,
                false
            );

            expect(tracks[0].language).toBe('eng');
        });
    });

    describe('explicit restore (overwrite: true)', () => {
        it('replaces what is there, because the user asked for it', () => {
            const tracks = fromSource();

            applySavedTrackLabels(savedLabels, [], tracks, true);

            expect(tracks.map((t) => t.name)).toEqual([
                'English',
                'NA',
                'NA',
                'NA',
                'NA',
            ]);
            expect(tracks[1].language).toBe('und');
        });
    });

    it('leaves tracks with no saved entry untouched', () => {
        const tracks = [audio(7, { name: 'CH_7_XYZ' })];

        applySavedTrackLabels(savedLabels, [], tracks, true);

        expect(tracks[0].name).toBe('CH_7_XYZ');
    });

    it('does nothing when nothing was saved', () => {
        const tracks = fromSource();

        applySavedTrackLabels({}, [], tracks, false);

        expect(tracks.map((t) => t.name)).toEqual([
            'CH_0_MUL',
            'CH_1_ENG',
            'CH_2_FRA',
            'CH_3_NYA',
            'CH_4_SWA',
        ]);
    });
});
