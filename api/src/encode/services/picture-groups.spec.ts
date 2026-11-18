import {
    MIN_INFORMATIVE,
    SAMPLE_BYTES,
    VERIFY_SAMPLE_COUNT,
    comparePair,
    defaultAngleTracks,
    frameCorrelation,
    frameStats,
    framesAgree,
    groupPictures,
    instantAligner,
    keyframeGrids,
    keyframesAligned,
    provenDifferent,
    recheckInstants,
    sameAspect,
    sampleInstants,
    stillAlike,
    type TrackFrames,
} from './picture-groups.js';

/**
 * A 32x18 frame with plenty of contrast, a different picture for every seed:
 * two seeds correlate near zero, the way two cameras do.
 */
function picture(seed: number): Uint8Array {
    const frame = new Uint8Array(SAMPLE_BYTES);
    let x = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < frame.length; i++) {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        frame[i] = 40 + (x % 176);
    }
    return frame;
}

/** Black, a fade, a title card's background: no contrast at all. */
function flat(level = 16): Uint8Array {
    return new Uint8Array(SAMPLE_BYTES).fill(level);
}

/** The same picture at `contrast` times its contrast, about mid-grey. */
function scaled(frame: Uint8Array, contrast: number): Uint8Array {
    const { mean } = frameStats(frame);
    return Uint8Array.from(frame, (v) =>
        Math.round(128 + (v - mean) * contrast)
    );
}

/** A track's frames from `[instant, frame]` pairs. */
function track(entries: [number, Uint8Array | null][]): TrackFrames {
    return new Map(entries);
}

/** Every instant here is re-checked half a second either side, unclamped. */
const halfSecond = (instant: number) => [instant - 500, instant + 500];

describe('sampleInstants', () => {
    it('centres eight instants in the span, in whole milliseconds', () => {
        expect(sampleInstants(0, 60_000)).toEqual([
            3750, 11250, 18750, 26250, 33750, 41250, 48750, 56250,
        ]);
    });

    it('takes the verifying count and phase without repeating a first-look instant', () => {
        const first = sampleInstants(1400, 61_400);
        const verifying = sampleInstants(
            1400,
            61_400,
            VERIFY_SAMPLE_COUNT,
            0.25
        );
        expect(verifying).toHaveLength(VERIFY_SAMPLE_COUNT);
        expect(verifying.filter((at) => first.includes(at))).toEqual([]);
        expect(Math.min(...verifying)).toBeGreaterThan(1400);
        expect(Math.max(...verifying)).toBeLessThan(61_400);
    });

    it('gives nothing for a span with no length', () => {
        expect(sampleInstants(5000, 5000)).toEqual([]);
        expect(sampleInstants(5000, 4000)).toEqual([]);
    });
});

describe('recheckInstants', () => {
    it('looks half a second either side', () => {
        expect(recheckInstants(10_000, 0, 60_000)).toEqual([9500, 10_500]);
    });

    it('drops a neighbour outside the span every track covers', () => {
        expect(recheckInstants(300, 0, 60_000)).toEqual([800]);
        expect(recheckInstants(59_800, 0, 60_000)).toEqual([59_300]);
    });
});

describe('framesAgree', () => {
    it('agrees on one picture and not on two', () => {
        expect(framesAgree(picture(1), scaled(picture(1), 0.6))).toBe(true);
        expect(framesAgree(picture(1), picture(2))).toBe(false);
    });

    it('agrees on black, and not on black against a picture', () => {
        expect(framesAgree(flat(16), flat(20))).toBe(true);
        expect(framesAgree(flat(16), picture(1))).toBe(false);
    });

    // A neighbour is judged by the rule a sampled instant is matched by, or a
    // dim pair either side of the flat threshold was one picture as a sample
    // and two as the neighbour of a disagreement.
    it('judges a dim pair either side of the flat threshold as a sample is judged', () => {
        const brighter = scaled(picture(3), 0.068);
        const dimmer = scaled(picture(3), 0.054);
        expect(frameStats(brighter).stdDev).toBeGreaterThan(3);
        expect(frameStats(dimmer).stdDev).toBeLessThan(3);

        expect(framesAgree(brighter, dimmer)).toBe(true);
        const asSample = comparePair(
            track([[0, brighter]]),
            track([[0, dimmer]]),
            [0],
            halfSecond
        );
        expect(asSample.matched).toBe(1);
    });
});

describe('comparePair', () => {
    const instants = [1000, 2000, 3000, 4000, 5000, 6000];

    it('counts the instants where the tracks show the same picture', () => {
        const a = track(instants.map((at) => [at, picture(at)]));
        const b = track(instants.map((at) => [at, scaled(picture(at), 0.5)]));

        const evidence = comparePair(a, b, instants, halfSecond);

        expect(evidence).toEqual({
            informative: 6,
            matched: 6,
            explained: 0,
            confirmed: 0,
            needed: [],
        });
        expect(stillAlike(evidence)).toBe(true);
    });

    it('skips instants both frames are black at, or either track gave nothing at', () => {
        const a = track([
            [1000, flat()],
            [2000, null],
            [4000, picture(4)],
        ]);
        const b = track([
            [1000, flat(20)],
            [2000, picture(2)],
            [3000, picture(3)],
            [4000, picture(4)],
        ]);

        const evidence = comparePair(
            a,
            b,
            [1000, 2000, 3000, 4000],
            halfSecond
        );

        expect(evidence.informative).toBe(1);
        expect(evidence.matched).toBe(1);
    });

    it('asks to re-check the earliest disagreement only', () => {
        const a = track(instants.map((at) => [at, picture(at)]));
        const b = track(
            instants.map((at) => [
                at,
                at === 2000 || at === 3000 ? picture(-at) : picture(at),
            ])
        );

        const evidence = comparePair(a, b, instants, halfSecond);

        expect(evidence.needed).toEqual([1500, 2500]);
        expect(evidence.confirmed).toBe(0);
        expect(stillAlike(evidence)).toBe(false);
        expect(provenDifferent(evidence)).toBe(false);
    });

    // A scene cut or a frame offset between two qualities of one picture: they
    // agree either side, so the disagreement is excused.
    it('excuses a disagreement the frames either side agree on', () => {
        const a = track([
            ...instants.map((at): [number, Uint8Array] => [at, picture(at)]),
            [1500, picture(15)],
            [2500, picture(25)],
        ]);
        const b = track([
            ...instants.map((at): [number, Uint8Array] => [
                at,
                at === 2000 ? picture(-1) : picture(at),
            ]),
            [1500, picture(15)],
            [2500, picture(25)],
        ]);

        const evidence = comparePair(a, b, instants, halfSecond);

        expect(evidence).toMatchObject({
            matched: 5,
            explained: 1,
            confirmed: 0,
            needed: [],
        });
        expect(stillAlike(evidence)).toBe(true);
    });

    // A programme feed cut away from the camera it otherwise shows: the
    // disagreement lasts, and one is proof of two pictures.
    it('confirms a disagreement a neighbour shares, and stops comparing there', () => {
        const a = track([
            ...instants.map((at): [number, Uint8Array] => [at, picture(at)]),
            [1500, picture(15)],
            [2500, picture(25)],
        ]);
        const b = track([
            ...instants.map((at): [number, Uint8Array] => [
                at,
                at === 2000 ? picture(-1) : picture(at),
            ]),
            [1500, picture(15)],
            [2500, picture(-25)],
        ]);

        const evidence = comparePair(a, b, instants, halfSecond);

        expect(evidence).toMatchObject({
            informative: 2,
            matched: 1,
            confirmed: 1,
            needed: [],
        });
        expect(provenDifferent(evidence)).toBe(true);
        expect(stillAlike(evidence)).toBe(false);
    });

    it('confirms a disagreement with nothing either side to excuse it', () => {
        const a = track([[1000, picture(1)]]);
        const b = track([[1000, picture(2)]]);

        expect(comparePair(a, b, [1000], () => []).confirmed).toBe(1);
    });

    it('takes no evidence from a neighbour either track gave no frame at', () => {
        const a = track([
            [2000, picture(1)],
            [1500, picture(15)],
            [2500, picture(25)],
        ]);
        const excused = track([
            [2000, picture(2)],
            [1500, null],
            [2500, picture(25)],
        ]);
        const unexcused = track([
            [2000, picture(2)],
            [1500, null],
            [2500, null],
        ]);

        expect(comparePair(a, excused, [2000], halfSecond)).toMatchObject({
            explained: 1,
            confirmed: 0,
        });
        expect(comparePair(a, unexcused, [2000], halfSecond).confirmed).toBe(1);
    });

    // Tracks at frame rates that do not divide each other disagree on fast
    // motion at many instants and are still one picture.
    it('does not hold excused disagreements against a pair, however many', () => {
        const many = [
            1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000,
        ];
        const odd = new Set([2000, 4000, 6000, 8000]);
        const entries = (other: boolean): [number, Uint8Array][] => [
            ...many.map((at): [number, Uint8Array] => [
                at,
                other && odd.has(at) ? picture(-at) : picture(at),
            ]),
            ...[...odd].flatMap((at): [number, Uint8Array][] => [
                [at - 500, picture(at - 500)],
                [at + 500, picture(at + 500)],
            ]),
        ];

        const evidence = comparePair(
            track(entries(false)),
            track(entries(true)),
            many,
            halfSecond
        );

        expect(evidence).toMatchObject({
            matched: 6,
            explained: 4,
            confirmed: 0,
        });
        expect(stillAlike(evidence)).toBe(true);
    });

    it(`is not one picture on fewer than ${MIN_INFORMATIVE} agreeing instants`, () => {
        const few = instants.slice(0, MIN_INFORMATIVE - 1);
        const a = track(few.map((at) => [at, picture(at)]));

        const evidence = comparePair(a, a, few, halfSecond);

        expect(stillAlike(evidence)).toBe(false);
        expect(provenDifferent(evidence)).toBe(false);
    });
});

describe('instantAligner', () => {
    // At 11.25 s a 50 fps track gives its frame at 11.26 and a 25 fps one its
    // frame at 11.28: on fast motion, or across a cut, two different frames.
    it('moves instants onto the slowest track’s frames and asks half the fastest frame early', () => {
        const aligner = instantAligner([
            { start: 0, period: 1 / 50 },
            { start: 0, period: 1 / 25 },
        ]);

        expect(aligner.align(11_250)).toBe(11_240);
        expect(aligner.align(3750)).toBe(3760);
        expect(aligner.seekFor(11_240)).toBeCloseTo(11.23, 6);
    });

    it('lays the grid from the slowest track’s first frame', () => {
        const aligner = instantAligner([
            { start: 1.4, period: 1 / 25 },
            { start: 1.4, period: 1 / 50 },
        ]);

        expect(aligner.align(3750)).toBe(3760);
        expect(aligner.align(1400)).toBe(1400);
    });

    it('leaves instants alone when any track’s cadence is unknown', () => {
        const aligner = instantAligner([
            { start: 0, period: 1 / 25 },
            undefined,
        ]);

        expect(aligner.align(11_250)).toBe(11_250);
        expect(aligner.seekFor(11_250)).toBe(11.25);
    });

    it('leaves instants alone when the frames are too close together to ask for safely', () => {
        const aligner = instantAligner([{ start: 0, period: 0.0015 }]);

        expect(aligner.align(11_251)).toBe(11_251);
    });
});

describe('groupPictures', () => {
    const hd = (index: number) => ({ index, width: 1920, height: 1080 });

    it('groups tracks under their lowest index and leaves the rest out', () => {
        const groups = groupPictures(
            [hd(0), hd(1), hd(2), hd(3)],
            (a, b) => (a === 1 && b === 3) || (a === 3 && b === 1)
        );

        expect([...groups]).toEqual([
            [1, 1],
            [3, 1],
        ]);
    });

    // A like B and B like C, but A proven unlike C: chaining would pull A and
    // C into one angle on evidence that says they are two pictures.
    it('joins a track only to a group it is alike with every member of', () => {
        const alike = new Set(['0-1', '1-2']);
        const groups = groupPictures([hd(0), hd(1), hd(2)], (a, b) =>
            alike.has(`${Math.min(a, b)}-${Math.max(a, b)}`)
        );

        expect([...groups]).toEqual([
            [0, 0],
            [1, 0],
        ]);
    });

    it('never asks about tracks of different shapes', () => {
        const alike = vi.fn(() => true);
        const groups = groupPictures(
            [hd(0), { index: 1, width: 1440, height: 1080 }],
            alike
        );

        expect(groups.size).toBe(0);
        expect(alike).not.toHaveBeenCalled();
    });
});

describe('sameAspect', () => {
    it('compares display shapes, so an anamorphic track matches its square-pixel proxy', () => {
        expect(
            sameAspect(
                {
                    width: 1440,
                    height: 1080,
                    displayWidth: 1920,
                    displayHeight: 1080,
                },
                { width: 640, height: 360 }
            )
        ).toBe(true);
        expect(
            sameAspect(
                { width: 1440, height: 1080 },
                { width: 640, height: 360 }
            )
        ).toBe(false);
    });
});

describe('frameCorrelation', () => {
    it('is 1 for one picture at any contrast, near 0 for two, and 0 for black', () => {
        const a = picture(9);
        const b = scaled(a, 0.4);
        const c = picture(10);
        const correlate = (x: Uint8Array, y: Uint8Array) =>
            frameCorrelation(x, frameStats(x), y, frameStats(y));

        expect(correlate(a, b)).toBeGreaterThan(0.99);
        expect(Math.abs(correlate(a, c))).toBeLessThan(0.2);
        expect(correlate(a, flat())).toBe(0);
    });
});

describe('keyframesAligned', () => {
    it('lines up keyframes within the tolerance over the stretch both lists cover', () => {
        expect(keyframesAligned([0, 2, 4, 6], [2.01, 4, 6, 8], 0.02)).toBe(
            true
        );
    });

    it('refuses a keyframe with no partner, or a comparison of fewer than two', () => {
        expect(keyframesAligned([0, 2, 4, 6], [0, 2, 6], 0.02)).toBe(false);
        expect(keyframesAligned([0, 2, 4], [0, 2.5, 4], 0.02)).toBe(false);
        expect(keyframesAligned([0], [0], 0.02)).toBe(false);
        expect(keyframesAligned([], [0, 2], 0.02)).toBe(false);
    });
});

describe('keyframeGrids', () => {
    it('puts each track on the grid of the first track it lines up with', () => {
        const cadence: Record<number, number> = { 0: 2, 1: 3, 2: 2, 3: 3 };
        const grids = keyframeGrids(
            [0, 1, 2, 3],
            (a, b) => cadence[a] === cadence[b]
        );

        expect(Object.fromEntries(grids)).toEqual({ 0: 0, 1: 1, 2: 0, 3: 1 });
    });
});

describe('defaultAngleTracks', () => {
    const tracks = [
        { index: 0, pictureGroup: 0 },
        { index: 1, pictureGroup: 0 },
        { index: 2 },
    ];

    it('keeps the angle holding track 0 when angles were detected', () => {
        expect(
            defaultAngleTracks({
                videoTracks: tracks,
                anglesDetected: true,
            }).map((t) => t.index)
        ).toEqual([0, 1]);
    });

    it('keeps every track when they were never compared', () => {
        expect(
            defaultAngleTracks({ videoTracks: tracks }).map((t) => t.index)
        ).toEqual([0, 1, 2]);
    });
});
