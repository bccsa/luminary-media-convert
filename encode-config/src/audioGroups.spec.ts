import { describe, expect, it } from 'vitest';
import { buildSuggestedAudioGroups } from './audioGroups';
import type { AudioTrackInfo } from './types';

function track(
    index: number,
    overrides: Partial<AudioTrackInfo> = {}
): AudioTrackInfo {
    return {
        index,
        codec: 'aac',
        bitrateKbps: 192,
        channels: 2,
        sampleRate: 48000,
        ...overrides,
    };
}

/** What each tier points at, keyed by group id. */
function tracksPerTier(groups: ReturnType<typeof buildSuggestedAudioGroups>) {
    const byTier = new Map<string, number[]>();
    for (const g of groups) {
        if (!byTier.has(g.id)) byTier.set(g.id, []);
        byTier.get(g.id)!.push(g.sourceTrackIndex!);
    }
    return byTier;
}

describe('buildSuggestedAudioGroups', () => {
    describe('tracks that are separate content', () => {
        /**
         * The reported case, from session 19a1d6fa: three languages with no
         * language metadata, so all bucketed together. Indexing into that bucket
         * by tier position walked across unrelated tracks — hd→ENG, mid→FRA,
         * low→NYA — so changing quality changed language.
         */
        const untagged = [track(1), track(2), track(3)];

        it('gives every tier the same set of source tracks', () => {
            const groups = buildSuggestedAudioGroups(untagged, 1);
            const byTier = tracksPerTier(groups);

            expect(byTier.size).toBeGreaterThan(1);
            for (const tracks of byTier.values()) {
                expect(tracks).toEqual([1, 2, 3]);
            }
        });

        it('never lets one tier carry a track another tier lacks', () => {
            const byTier = tracksPerTier(
                buildSuggestedAudioGroups(untagged, 1)
            );
            const sets = [...byTier.values()].map((t) => t.slice().sort().join(','));

            expect(new Set(sets).size).toBe(1);
        });

        it('keeps distinct languages distinct in every tier', () => {
            const tagged = [
                track(1, { language: 'eng' }),
                track(2, { language: 'fra' }),
                track(3, { language: 'nya' }),
            ];

            const byTier = tracksPerTier(buildSuggestedAudioGroups(tagged, 1));
            for (const tracks of byTier.values()) {
                expect(tracks).toEqual([1, 2, 3]);
            }
        });

        it('varies only the bitrate between tiers', () => {
            const groups = buildSuggestedAudioGroups(untagged, 1);
            const forTrack1 = groups.filter((g) => g.sourceTrackIndex === 1);

            expect(forTrack1.length).toBeGreaterThan(1);
            expect(new Set(forTrack1.map((g) => g.audioBitrateKbps)).size).toBe(
                forTrack1.length
            );
        });

        it('gives untagged tracks labels that tell them apart', () => {
            // Without this three renditions in one group read identically and a
            // listener has no way to choose between them.
            const groups = buildSuggestedAudioGroups(untagged, 1);
            const lowTier = groups.filter((g) => g.id === 'low');

            expect(new Set(lowTier.map((g) => g.label)).size).toBe(
                lowTier.length
            );
        });

        it('prefers the track name when the source provides one', () => {
            const named = [
                track(1, { name: 'Director commentary' }),
                track(2, { name: 'Main programme' }),
            ];

            const labels = buildSuggestedAudioGroups(named, 1).map((g) => g.label);
            expect(labels).toContain('Director commentary');
            expect(labels).toContain('Main programme');
        });
    });

    describe('a source that already carries its own ladder', () => {
        // Several video renditions and several tracks per language: here the
        // extra tracks really are the same audio at different bitrates, so each
        // tier should take the matching one rather than all of them.
        const ladder = [
            track(1, { language: 'eng', bitrateKbps: 256 }),
            track(2, { language: 'eng', bitrateKbps: 128 }),
            track(3, { language: 'eng', bitrateKbps: 64 }),
        ];

        it('matches each tier to its own encoding', () => {
            const byTier = tracksPerTier(buildSuggestedAudioGroups(ladder, 3));

            const picked = [...byTier.values()].map((t) => t[0]);
            expect(new Set(picked).size).toBeGreaterThan(1);
        });

        it('copies rather than re-encodes', () => {
            const groups = buildSuggestedAudioGroups(ladder, 3);

            expect(groups.every((g) => g.copyStream === true)).toBe(true);
            expect(groups.every((g) => g.vbr === false)).toBe(true);
        });
    });

    describe('a single audio track', () => {
        it('produces one group per tier from that track', () => {
            const groups = buildSuggestedAudioGroups(
                [track(1, { language: 'eng' })],
                1
            );

            expect(groups.every((g) => g.sourceTrackIndex === 1)).toBe(true);
            expect(new Set(groups.map((g) => g.id)).size).toBe(groups.length);
        });

        it('returns nothing when there is no audio at all', () => {
            expect(buildSuggestedAudioGroups([], 1)).toEqual([]);
        });
    });

    describe('tier selection follows the source', () => {
        it('does not offer tiers above the source bitrate', () => {
            const groups = buildSuggestedAudioGroups(
                [track(1, { bitrateKbps: 64 })],
                1
            );

            expect(groups.every((g) => (g.audioBitrateKbps ?? 0) <= 96)).toBe(true);
        });

        it('halves tier bitrates for a mono source', () => {
            const groups = buildSuggestedAudioGroups(
                [track(1, { channels: 1, bitrateKbps: 128 })],
                1
            );

            expect(groups.some((g) => g.audioBitrateKbps === 64)).toBe(true);
        });
    });
});
