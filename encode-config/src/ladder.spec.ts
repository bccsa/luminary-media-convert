import { describe, expect, it } from 'vitest';
import {
    ABR_LADDER,
    CONTENT_PRESETS,
    aspectWidthForHeight,
    fpsAdjustedBitrateKbps,
    ladderFor,
    sourceCapKbps,
    suggestLadder,
} from './ladder';
import type { VideoTrackInfo } from './types';

describe('fpsAdjustedBitrateKbps', () => {
    it('scales symmetrically about 30 fps', () => {
        expect(fpsAdjustedBitrateKbps(5000, 30)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 25)).toBe(4361);
        expect(fpsAdjustedBitrateKbps(5000, 23.976)).toBe(4226);
    });

    it('raises the budget for 50 fps material', () => {
        // The case from #93: 1080p50 at the 30 fps budget pinned the encoder to
        // its cap for 73% of the programme.
        const adjusted = fpsAdjustedBitrateKbps(5000, 50);
        expect(adjusted).toBeGreaterThan(7000);
        expect(adjusted).toBeLessThan(7700);
    });

    it('raises 60 fps further, sublinearly', () => {
        const at60 = fpsAdjustedBitrateKbps(5000, 60);
        expect(at60).toBeGreaterThan(fpsAdjustedBitrateKbps(5000, 50));
        expect(at60).toBeLessThan(10000);
    });

    it('caps runaway frame rates at double the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, 1000)).toBe(10000);
    });

    it('treats a missing frame rate as the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, NaN)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 0)).toBe(5000);
    });

    it('never takes more than 30% off, however low the frame rate', () => {
        // Unclamped, (12/30)^0.75 = 0.50 would halve the budget to 2515. Sparse
        // frames carry bigger deltas between them — the same reason the curve
        // is sublinear at all — so the discount has to stop, and 0.7 is where.
        expect(fpsAdjustedBitrateKbps(5000, 12)).toBe(3500);
    });

    it('lets go of the floor just above 18.6 fps, with no step', () => {
        // (fps/30)^0.75 crosses 0.7 at 30 x 0.7^(4/3) = 18.646 fps. Below that
        // the floor decides and above it the curve does; the handover is one
        // kbps, not a jump that would price 18.6 and 18.7 fps visibly apart.
        expect(fpsAdjustedBitrateKbps(5000, 18.64)).toBe(3500);
        expect(fpsAdjustedBitrateKbps(5000, 18.65)).toBe(3501);
        expect(fpsAdjustedBitrateKbps(5000, 19)).toBe(3550);
    });

    it('passes through the table value at 30 fps, continuous either side', () => {
        // 30 fps is where the curve used to switch on, and is now simply where
        // it passes 1x. A step there would price 29.97 and 30 fps material — the
        // same programme from two cameras — noticeably differently.
        expect(fpsAdjustedBitrateKbps(5000, 29.97)).toBe(4996);
        expect(fpsAdjustedBitrateKbps(5000, 30)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 30.03)).toBe(5004);
    });

    it('gives an impossible frame rate the table value, not the floor', () => {
        // The guard runs before the clamp on purpose. 0 and NaN are what an
        // unprobed source reports, and a negative is no likelier to be true;
        // sent through the clamp, any of them lands on the 0.7 floor and docks
        // 30% off every rung of a ladder nobody has measured.
        expect(fpsAdjustedBitrateKbps(5000, -25)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, -Infinity)).toBe(5000);
    });
});

function track(overrides: Partial<VideoTrackInfo> = {}): VideoTrackInfo {
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

/** `WxH` per rung, which is what the form actually puts in front of the user. */
function rungs(t: VideoTrackInfo): string[] {
    const { displayWidth = t.width, displayHeight = t.height } = t;
    return ladderFor(t).map(
        (r) =>
            `${aspectWidthForHeight(r.height, displayWidth, displayHeight)}x${r.height}`
    );
}

describe('aspectWidthForHeight', () => {
    it('reproduces the canonical 16:9 widths exactly', () => {
        // The table's own numbers, so a 16:9 source is untouched by any of this.
        expect(aspectWidthForHeight(1080, 1920, 1080)).toBe(1920);
        expect(aspectWidthForHeight(720, 1920, 1080)).toBe(1280);
        expect(aspectWidthForHeight(480, 1920, 1080)).toBe(854);
        expect(aspectWidthForHeight(240, 1920, 1080)).toBe(426);
    });

    it('works from the display shape, not the storage shape', () => {
        // Fed the coded 720x576 it returned 600 for the 480p rung — the
        // source's storage shape, which is nobody's picture.
        expect(aspectWidthForHeight(480, 1024, 576)).toBe(854);
        expect(aspectWidthForHeight(480, 720, 576)).toBe(600);
    });

    it('keeps every width even, as yuv420p requires', () => {
        expect(aspectWidthForHeight(360, 1024, 576) % 2).toBe(0);
        expect(aspectWidthForHeight(577, 1024, 576) % 2).toBe(0);
    });

    it('falls back to the height when the source has no dimensions', () => {
        expect(aspectWidthForHeight(480, 0, 0)).toBe(480);
    });
});

describe('ladderFor', () => {
    it('unsquishes PAL SD carrying 16:9 and offers its own resolution', () => {
        // The reported bug. Before: 600x480 / 450x360 / 300x240 / 180x144 —
        // every rung squashed, and the source's real 1024x576 never offered.
        expect(
            rungs(
                track({
                    width: 720,
                    height: 576,
                    displayWidth: 1024,
                    displayHeight: 576,
                })
            )
        ).toEqual(['1024x576', '854x480', '640x360', '426x240', '256x144']);
    });

    it('builds a 4:3 ladder for NTSC DV, which corrects on height', () => {
        expect(
            rungs(
                track({
                    width: 720,
                    height: 480,
                    displayWidth: 720,
                    displayHeight: 540,
                })
            )
        ).toEqual(['720x540', '640x480', '480x360', '320x240', '192x144']);
    });

    it('leaves a square-pixel HD source exactly as it was', () => {
        expect(rungs(track())).toEqual([
            '1920x1080',
            '1280x720',
            '854x480',
            '640x360',
            '426x240',
            '256x144',
        ]);
    });

    it('adds no extra rung when the source sits on a table height', () => {
        expect(rungs(track({ width: 1280, height: 720 }))).toEqual([
            '1280x720',
            '854x480',
            '640x360',
            '426x240',
            '256x144',
        ]);
    });

    it('treats a probe with no display fields as square', () => {
        // A session restored across the upgrade must produce the ladder it
        // produced yesterday.
        const legacy = track({ width: 1920, height: 1080 });
        expect(legacy.displayWidth).toBeUndefined();
        expect(rungs(legacy)).toEqual(rungs(track()));
    });

    it('still caps an oversized source at 4K', () => {
        expect(rungs(track({ width: 7680, height: 4320 }))[0]).toBe('3840x2160');
    });

    it('falls back to the source itself when it is below every rung', () => {
        expect(rungs(track({ width: 100, height: 100 }))).toEqual(['100x100']);
    });

    it('gives that fallback rung the source bitrate, or a floor when it has none', () => {
        // Below every table rung there is nothing to interpolate against, so
        // the source's own bitrate is the only number available — and a source
        // that did not report one still has to get a budget.
        expect(
            ladderFor(track({ width: 100, height: 100, bitrateKbps: 750 }))[0]
                .bitrateKbps
        ).toBe(750);
        expect(
            ladderFor(track({ width: 100, height: 100, bitrateKbps: 0 }))[0]
                .bitrateKbps
        ).toBe(1000);
    });

    it('keeps the fallback rung even, and unsquished', () => {
        // The one path that does not go through `aspectWidthForHeight`, so its
        // rounding is its own and worth pinning separately.
        const [rung] = ladderFor(
            track({
                width: 101,
                height: 99,
                displayWidth: 135,
                displayHeight: 99,
            })
        );
        expect(rung.width % 2).toBe(0);
        expect(rung.height % 2).toBe(0);
        expect(`${rung.width}x${rung.height}`).toBe('136x100');
    });

    it('prices the extra rung above the standard rung beneath it', () => {
        // Linear in pixel count against the rung below *at this source's shape*.
        // Measured against the table's own 16:9 width instead, a 4:3 720x540
        // top rung came out cheaper than the 640x480 under it.
        for (const t of [
            track({ width: 720, height: 576, displayWidth: 1024, displayHeight: 576 }),
            track({ width: 720, height: 480, displayWidth: 720, displayHeight: 540 }),
        ]) {
            const budgets = ladderFor(t).map((r) => r.bitrateKbps);
            expect(budgets[0]).toBeGreaterThan(budgets[1]);
        }
    });

    it('labels the extra rung by its display height', () => {
        expect(
            ladderFor(
                track({
                    width: 720,
                    height: 576,
                    displayWidth: 1024,
                    displayHeight: 576,
                })
            )[0].label
        ).toBe('576p');
    });

    it('shapes the table rungs to the source, not to 16:9', () => {
        // Read straight off `ladderFor`, not recomputed the way `rungs()` does:
        // `suggestLadder` hands these widths to the form as they are, and a 4:3
        // source taking the table's own would be offered 854x480 — a picture
        // it can only fill by being pillarboxed.
        expect(
            ladderFor(track({ width: 1440, height: 1080 })).map(
                (r) => `${r.width}x${r.height}`
            )
        ).toEqual([
            '1440x1080',
            '960x720',
            '640x480',
            '480x360',
            '320x240',
            '192x144',
        ]);
    });

    it('marks only the sub-144p fallback as a measured budget', () => {
        // `suggestLadder` exempts a measured rung from the frame-rate
        // adjustment. On a table rung the flag would leave a 30 fps number
        // unscaled — the #93 starvation at 50 fps — and on the extra rung it
        // would mistake an interpolation for a measurement.
        expect(
            ladderFor(track({ width: 100, height: 100, bitrateKbps: 750 }))[0]
                .sourceMeasured
        ).toBe(true);
        for (const t of [
            track(),
            track({
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
            }),
        ]) {
            expect(ladderFor(t).some((r) => r.sourceMeasured)).toBe(false);
        }
    });

    it('prices a 4:3 extra rung against the 640x480 beneath it, exactly', () => {
        // The figures behind the ordering test above. Priced against the
        // table's own 854 width, the 720x540 rung would come to 1328 — under
        // the 1400 of the smaller rung beneath it.
        expect(
            ladderFor(
                track({
                    width: 720,
                    height: 480,
                    displayWidth: 720,
                    displayHeight: 540,
                })
            ).map((r) => `${r.width}x${r.height}@${r.bitrateKbps}`)
        ).toEqual([
            '720x540@1772',
            '640x480@1400',
            '480x360@800',
            '320x240@400',
            '192x144@200',
        ]);
    });
});

/**
 * The table itself. Its budgets are judgement calls, but their shape is not:
 * putting bits per pixel the right way round was the point of the retune.
 */
describe('ABR_LADDER', () => {
    it('runs top rung first, each shorter and cheaper than the one above', () => {
        // `ladderFor` filters this by height, reads its first survivor as the
        // rung beneath an extra one, and treats [0] as the tallest; all three
        // assume top-first order.
        for (let i = 1; i < ABR_LADDER.length; i++) {
            expect(ABR_LADDER[i].height).toBeLessThan(ABR_LADDER[i - 1].height);
            expect(ABR_LADDER[i].bitrateKbps).toBeLessThan(
                ABR_LADDER[i - 1].bitrateKbps
            );
        }
    });

    it('spends more per pixel as the picture gets smaller', () => {
        // The old table served 480p fewer bits per pixel than the 720p above
        // it, so the rung where bandwidth-constrained viewers actually sit was
        // the thinnest-served in the table. A downscaled picture is the harder
        // one: scaling keeps exactly the edges an encoder cannot predict.
        const bitsPerPixel = ABR_LADDER.map(
            (r) => r.bitrateKbps / (r.width * r.height * 30)
        );
        for (let i = 1; i < bitsPerPixel.length; i++) {
            expect(bitsPerPixel[i]).toBeGreaterThan(bitsPerPixel[i - 1]);
        }
    });
});

describe('sourceCapKbps', () => {
    it('is the source bitrate itself at the source size', () => {
        // Re-encoding past what the file carries recovers nothing. This 1805
        // kbps 1080p service was being offered 5500 kbps at 1080p.
        expect(sourceCapKbps(1920, 1080, 1805, 1920, 1080)).toBe(1805);
    });

    it('lets a smaller rung keep more per pixel than the source spent', () => {
        // 720p holds 4/9 of the pixels, so a proportional cap would allow 802
        // kbps. The 0.75 exponent allows 983: downscaling a soft source makes a
        // genuinely sharper small picture, and proportional pricing starves it.
        expect(sourceCapKbps(1280, 720, 1805, 1920, 1080)).toBe(983);
    });

    it('never lets a rung past the source bitrate, even a larger rung', () => {
        // The outer min. A 577-line source's own rung is rounded even to 578
        // lines, so its pixel count edges past the source's and the curve alone
        // gives 1810; an operator's 4K row over a 1080p source would be allowed
        // 5105. Neither is detail the file contains.
        const [own] = ladderFor(track({ width: 1024, height: 577 }));
        expect(`${own.width}x${own.height}`).toBe('1026x578');
        expect(sourceCapKbps(own.width, own.height, 1805, 1024, 577)).toBe(
            1805
        );
        expect(sourceCapKbps(3840, 2160, 1805, 1920, 1080)).toBe(1805);
    });

    it('declines to guess a ceiling when the source bitrate is unknown', () => {
        // 0 is what the probe reports when every bitrate strategy failed. A
        // guessed cap would quietly squeeze the ladder of a source nobody
        // measured; Infinity lets the table stand.
        for (const unknown of [0, -1805, NaN]) {
            expect(sourceCapKbps(1280, 720, unknown, 1920, 1080)).toBe(
                Infinity
            );
        }
    });

    it('declines as well when either picture has no area', () => {
        // The form asks this of every row an operator edits, and a dimension
        // being retyped is briefly empty, which multiplies out to no area.
        // Unguarded, that row's cap would be 0 kbps and the form would flag it
        // as above what the source carries while the operator is still typing.
        expect(sourceCapKbps(0, 720, 1805, 1920, 1080)).toBe(Infinity);
        expect(sourceCapKbps(1280, 0, 1805, 1920, 1080)).toBe(Infinity);
        expect(sourceCapKbps(1280, 720, 1805, 0, 1080)).toBe(Infinity);
        expect(sourceCapKbps(1280, 720, 1805, 1920, 0)).toBe(Infinity);
    });
});

/**
 * What the operator is actually shown: the table moved to the source's frame
 * rate, capped by what the source carries, and scaled by the content preset.
 */
describe('suggestLadder', () => {
    const kbps = (t: VideoTrackInfo, factor?: number): number[] =>
        suggestLadder(t, factor).map((r) => r.bitrateKbps);

    it('never offers more than the source carries', () => {
        // The file this started from: a 24 fps 1080p service at 1805 kbps was
        // suggested 5000 kbps at 1080p, 2.8x the source. The cap binds on every
        // rung, and the top one is the source bitrate exactly — adjusting the
        // cap for frame rate as well would have made it 1527, applying 24 fps
        // to a measurement that was already taken at 24 fps.
        const ladder = suggestLadder(
            track({ frameRate: 24, bitrateKbps: 1805 })
        );
        expect(ladder.map((r) => `${r.width}x${r.height}`)).toEqual([
            '1920x1080',
            '1280x720',
            '854x480',
            '640x360',
            '426x240',
            '256x144',
        ]);
        expect(ladder.map((r) => r.label)).toEqual([
            '1080p',
            '720p',
            '480p',
            '360p',
            '240p',
            '144p',
        ]);
        expect(ladder.map((r) => r.bitrateKbps)).toEqual([
            1805, 983, 535, 347, 189, 88,
        ]);
    });

    it('prices a source of unknown bitrate from the table alone', () => {
        // No measurement, no cap: exactly the table at 25 fps, rather than a
        // guessed ceiling squeezing a source nobody measured.
        expect(kbps(track({ bitrateKbps: 0 }))).toEqual([
            4797, 2617, 1221, 698, 349, 174,
        ]);
    });

    it('leaves a mezzanine source to the table', () => {
        // A 184 Mbps master carries far more than any rung can use. The cap
        // only ever takes away, and here it has nothing to take: the ladder is
        // the one a source of unknown bitrate gets.
        expect(kbps(track({ bitrateKbps: 184000 }))).toEqual([
            4797, 2617, 1221, 698, 349, 174,
        ]);
    });

    it('raises a 50 fps ladder by the #93 factor, and caps it all the same', () => {
        // 1080p50 on the 30 fps budget was the #93 starvation, so a rich source
        // gets the full 1.467x. A lean one is still held to what it carries —
        // at exactly 3698, not the 5424 that adjusting the cap for frame rate
        // would allow: the measurement was taken at 50 fps already.
        expect(kbps(track({ frameRate: 50, bitrateKbps: 184000 }))).toEqual([
            8068, 4401, 2054, 1173, 587, 293,
        ]);
        expect(kbps(track({ frameRate: 50, bitrateKbps: 3698 }))).toEqual([
            3698, 2013, 1096, 712, 387, 180,
        ]);
    });

    it('caps the extra PAL rung like any other and keeps it above 480p', () => {
        // The 576-line rung is interpolated, not measured, so the cap applies:
        // at 1500 kbps the source carries less than the 1757 the table would
        // spend on it. Capped to the source exactly, it still stands above the
        // 480p beneath it; from 360p down the table is the smaller number.
        expect(
            suggestLadder(
                track({
                    width: 720,
                    height: 576,
                    displayWidth: 1024,
                    displayHeight: 576,
                    bitrateKbps: 1500,
                })
            ).map((r) => `${r.width}x${r.height}@${r.bitrateKbps}`)
        ).toEqual([
            '1024x576@1500',
            '854x480@1142',
            '640x360@698',
            '426x240@349',
            '256x144@174',
        ]);
    });

    it('treats a frame rate the probe never reported as 30 fps', () => {
        // The table is written for 30 fps, so an absent rate prices at the
        // table itself — neither a discount nor a raise on no evidence.
        const unreported = track({ bitrateKbps: 0, frameRate: undefined });
        expect(kbps(unreported)).toEqual([5500, 3000, 1400, 800, 400, 200]);
        expect(kbps(unreported)).toEqual(
            kbps(track({ bitrateKbps: 0, frameRate: 30 }))
        );
    });

    it('leaves the measured sub-144p rung at the source frame rate', () => {
        // That budget is the source's own measurement, taken at 24 fps. Scaled
        // for frame rate again it would come to 634 — the 15% cut for being a
        // 24 fps clip, taken twice.
        expect(
            kbps(
                track({
                    width: 100,
                    height: 100,
                    frameRate: 24,
                    bitrateKbps: 750,
                })
            )
        ).toEqual([750]);
    });

    it('never suggests less than 1 kbps', () => {
        // The API refuses a `videoBitrateKbps` under 1 (`@Min(1)`), so a rung
        // rounded to 0 would fail the encode at submit. An 8K source at 235
        // kbps under x0.1 — the lowest the Custom entry accepts — gets there:
        // its 240p and 144p caps are 3 and 1 kbps, and a tenth of either
        // rounds to nothing.
        expect(
            kbps(track({ width: 7680, height: 4320, bitrateKbps: 235 }), 0.1)
        ).toEqual([8, 5, 3, 2, 1, 1, 1, 1]);
    });

    it('never offers a lower rung more than the one above it', () => {
        // A rung dearer than the rung above it spends more bandwidth on fewer
        // pixels, and no player's ABR should ever want it. Both terms rise with
        // rung size, and a pointwise min of rising sequences rises — but they
        // are rounded separately, scaled by the factor separately and floored
        // at 1, so this is checked across every shape the ladder special-cases,
        // and factors spanning the Custom entry's whole 0.1-2 range, rather
        // than trusted from one example.
        const sizes: Partial<VideoTrackInfo>[] = [
            { width: 7680, height: 4320 },
            { width: 3840, height: 2160 },
            { width: 1920, height: 1080 },
            { width: 1440, height: 1080 },
            { width: 1280, height: 720 },
            { width: 1024, height: 577 },
            { width: 720, height: 576, displayWidth: 1024, displayHeight: 576 },
            { width: 720, height: 480, displayWidth: 720, displayHeight: 540 },
            { width: 1080, height: 1920 },
            { width: 640, height: 360 },
            { width: 100, height: 100 },
            { width: 101, height: 99, displayWidth: 135, displayHeight: 99 },
        ];
        const cases = sizes.flatMap((size) =>
            [0, 235, 1805, 3698, 184000].flatMap((bitrateKbps) =>
                [0, 12, 23.976, 25, 30, 50, 60].flatMap((frameRate) =>
                    [0.1, 0.6, 1, 1.3, 2].map((factor) => ({
                        size,
                        bitrateKbps,
                        frameRate,
                        factor,
                    }))
                )
            )
        );
        // A matrix that silently lost a dimension would still pass.
        expect(cases).toHaveLength(2100);
        for (const { size, bitrateKbps, frameRate, factor } of cases) {
            const ladder = kbps(
                track({ ...size, bitrateKbps, frameRate }),
                factor
            );
            const where = JSON.stringify({
                ...size,
                bitrateKbps,
                frameRate,
                factor,
                ladder,
            });
            for (let i = 1; i < ladder.length; i++) {
                expect(ladder[i], where).toBeLessThanOrEqual(ladder[i - 1]);
            }
        }
    });

    describe('with a content factor', () => {
        const lean = track({ width: 640, height: 360, bitrateKbps: 235 });

        it('lowers a lean source under Low motion, capped rungs included', () => {
            // Why a reduction scales the cap too. Applied to the table alone,
            // x0.6 on a source this lean changed nothing — the cap was holding
            // every rung, and Low motion left [235, 128, 59] exactly as it
            // found it. A preset the operator chose and could not see was worse
            // than the double discount it avoided.
            expect(kbps(lean)).toEqual([235, 128, 59]);
            expect(kbps(lean, 0.6)).toEqual([141, 77, 35]);
            // A 720p50 source the cap holds only at the top two rungs: those
            // take the full 0.6 as well, 3698 coming down to 2219 where
            // discounting the table alone stopped at 2641.
            expect(
                kbps(
                    track({
                        width: 1280,
                        height: 720,
                        frameRate: 50,
                        bitrateKbps: 3698,
                    }),
                    0.6
                )
            ).toEqual([2219, 1208, 704, 352, 176]);
        });

        it('raises only what the source can carry under High motion', () => {
            // No factor conjures detail the file does not have, so the lean
            // source stays exactly where it was. A rich one, where the table
            // was the smaller number all along, is raised by the full 1.3.
            expect(kbps(lean, 1.3)).toEqual(kbps(lean));
            expect(kbps(track({ bitrateKbps: 184000 }), 1.3)).toEqual([
                6236, 3402, 1587, 907, 454, 226,
            ]);
        });

        it('ignores a factor that is not a positive, finite number', () => {
            // A Custom entry being retyped is empty or 0 for a moment. Obeyed,
            // 0 and negatives would flatten every rung to 1 kbps, NaN would put
            // NaN in front of the operator, and Infinity would lift a rich
            // source to its own cap. Each gets the plain ladder instead.
            const rich = track({ bitrateKbps: 184000 });
            for (const nonsense of [NaN, 0, -0.6, Infinity, -Infinity]) {
                expect(kbps(rich, nonsense)).toEqual([
                    4797, 2617, 1221, 698, 349, 174,
                ]);
            }
        });

        it('moves a measured sub-144p rung down under Low motion, never up', () => {
            // A measured rung's cap is its own measurement, so it answers to
            // the factor exactly as a capped table rung does: Low motion brings
            // 750 kbps down to 450, and High motion cannot lift it past what
            // was measured.
            const tiny = track({ width: 100, height: 100, bitrateKbps: 750 });
            expect(kbps(tiny, 0.6)).toEqual([450]);
            expect(kbps(tiny, 1.3)).toEqual([750]);
        });
    });
});

describe('CONTENT_PRESETS', () => {
    it('offers Low, Standard and High motion at 0.6, 1 and 1.3', () => {
        // The ids are remembered per layout (`saveContentPreset`) and matched
        // on the next session, so renaming one silently drops every saved
        // choice. Standard has to stay exactly 1 — choosing it is choosing the
        // ladder with no opinion — and Low stays at 0.6 because the number is
        // the maxrate ceiling too, and calm material still has its bursts.
        expect(CONTENT_PRESETS).toEqual([
            { id: 'low', label: 'Low motion', factor: 0.6 },
            { id: 'standard', label: 'Standard', factor: 1 },
            { id: 'high', label: 'High motion', factor: 1.3 },
        ]);
    });
});
