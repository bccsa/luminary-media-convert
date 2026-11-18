import { describe, expect, it } from 'vitest';
import {
    angleDoubt,
    angleNames,
    anglesOf,
    initialAssignment,
    moveTrack,
    rankTracks,
    undecidedPairs,
    type Angle,
} from './angles';
import type { VideoTrackInfo } from './types';

function track(overrides: Partial<VideoTrackInfo>): VideoTrackInfo {
    return {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitrateKbps: 5000,
        frameRate: 25,
        ...overrides,
    };
}

/** One angle holding `members`, every one of them included. */
function angle(members: VideoTrackInfo[]): Angle {
    const sorted = [...members].sort(rankTracks);
    return {
        id: Math.min(...members.map((t) => t.index)),
        members: sorted,
        included: sorted,
        best: sorted[0],
    };
}

/** Two tracks detection grouped, verified unless said otherwise. */
const grouped = (a: Partial<VideoTrackInfo>, b: Partial<VideoTrackInfo>) => [
    track({
        index: 0,
        pictureGroup: 0,
        pictureMatches: 48,
        pictureVerified: true,
        ...a,
    }),
    track({
        index: 1,
        pictureGroup: 0,
        pictureMatches: 48,
        pictureVerified: true,
        ...b,
    }),
];

describe('angleDoubt', () => {
    it('has nothing to say about a verified ladder', () => {
        expect(
            angleDoubt(
                angle(
                    grouped({}, { width: 640, height: 360, bitrateKbps: 800 })
                )
            )
        ).toBeNull();
    });

    it('doubts a grouping the time allowed cut short, and says how far it got', () => {
        const doubt = angleDoubt(
            angle(
                grouped(
                    { pictureMatches: 21, pictureVerified: false },
                    {
                        width: 640,
                        height: 360,
                        bitrateKbps: 800,
                        pictureMatches: 21,
                        pictureVerified: false,
                    }
                )
            )
        );

        expect(doubt).toContain('ran out of time');
        expect(doubt).toContain('#0 and #1');
        expect(doubt).toContain('matched at 21');
    });

    // A programme feed and the camera it sits on, recorded side by side by one
    // recorder: the same size, codec, frame rate and bitrate. A source's own
    // ladder steps down from rung to rung.
    it('doubts two tracks encoded alike', () => {
        expect(angleDoubt(angle(grouped({}, { bitrateKbps: 4600 })))).toContain(
            'encoded alike'
        );
    });

    it('doubts two tracks of one size whose bitrates are unknown', () => {
        expect(
            angleDoubt(angle(grouped({ bitrateKbps: 0 }, { bitrateKbps: 0 })))
        ).toContain('encoded alike');
    });

    it('takes two rungs of one size at clearly different bitrates for a ladder', () => {
        expect(
            angleDoubt(
                angle(grouped({ bitrateKbps: 7800 }, { bitrateKbps: 6000 }))
            )
        ).toBeNull();
    });

    it('leaves a grouping the operator made alone', () => {
        const byHand = [
            track({ index: 0 }),
            track({ index: 1, bitrateKbps: 4900 }),
        ];

        expect(angleDoubt(angle(byHand))).toBeNull();
    });

    it('asks only about tracks still included', () => {
        const members = grouped({}, { bitrateKbps: 4900 });
        const a: Angle = {
            id: 0,
            members,
            included: [members[0]],
            best: members[0],
        };

        expect(angleDoubt(a)).toBeNull();
    });
});

describe('undecidedPairs', () => {
    const undecided = [
        track({ index: 0, pictureUndecided: [1] }),
        track({
            index: 1,
            width: 640,
            height: 360,
            bitrateKbps: 800,
            pictureUndecided: [0],
        }),
    ];

    it('names each pair detection kept apart without deciding, once', () => {
        const notes = undecidedPairs([
            angle([undecided[0]]),
            angle([undecided[1]]),
        ]);

        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('#0 and #1');
        expect(notes[0]).toContain('separate angles');
    });

    it('has nothing left to say once the pair is one angle', () => {
        expect(undecidedPairs([angle(undecided)])).toEqual([]);
    });

    it('has nothing left to say once one of the pair is left out', () => {
        expect(undecidedPairs([angle([undecided[0]])])).toEqual([]);
    });
});

describe('rankTracks', () => {
    it('puts the most picture first, then the most bits, then the lower index', () => {
        const ranked = [
            track({ index: 0, width: 640, height: 360, bitrateKbps: 9000 }),
            track({ index: 1, bitrateKbps: 4000 }),
            track({ index: 2, bitrateKbps: 6000 }),
            track({ index: 3, bitrateKbps: 6000 }),
        ].sort(rankTracks);

        expect(ranked.map((t) => t.index)).toEqual([2, 3, 1, 0]);
    });

    it('ranks an anamorphic master by its display size', () => {
        const master = track({
            index: 1,
            width: 1440,
            displayWidth: 1920,
            displayHeight: 1080,
            bitrateKbps: 1,
        });
        const proxy = track({
            index: 0,
            width: 1600,
            height: 900,
            bitrateKbps: 9000,
        });

        expect([proxy, master].sort(rankTracks)[0]).toBe(master);
    });
});

describe('angle assignment', () => {
    const tracks = [
        track({ index: 0, pictureGroup: 0 }),
        track({ index: 1, width: 640, height: 360, pictureGroup: 0 }),
        track({ index: 2 }),
    ];

    it('starts from detection: grouped tracks share an angle, the rest stand alone', () => {
        expect(Object.fromEntries(initialAssignment(tracks))).toEqual({
            0: 0,
            1: 0,
            2: 2,
        });
    });

    it('keys an angle by its lowest member however tracks are moved', () => {
        const moved = moveTrack(initialAssignment(tracks), 0, 2);

        expect(Object.fromEntries(moved)).toEqual({ 0: 0, 1: 1, 2: 0 });
        expect(Object.fromEntries(moveTrack(moved, 2, 'new'))).toEqual({
            0: 0,
            1: 1,
            2: 2,
        });
    });

    it('lists the angles in id order, best member first, without ones left out entirely', () => {
        const angles = anglesOf(
            tracks,
            initialAssignment(tracks),
            new Set([2])
        );

        expect(angles.map((a) => a.id)).toEqual([0]);
        expect(angles[0].best.index).toBe(0);
        expect(
            anglesOf(tracks, initialAssignment(tracks), new Set([2]), false)
        ).toHaveLength(2);
    });
});

describe('angleNames', () => {
    it('counts unnamed angles in order and numbers a repeated name', () => {
        const angles = [
            angle([track({ index: 0 })]),
            angle([track({ index: 2, name: 'Camera' })]),
            angle([track({ index: 3, name: 'camera' })]),
            angle([track({ index: 4 })]),
        ];

        expect(Object.fromEntries(angleNames(angles))).toEqual({
            0: 'Angle 0',
            2: 'Camera',
            3: 'camera 2',
            4: 'Angle 3',
        });
    });
});
