import { describe, expect, it } from 'vitest';
import { aspectWidthForHeight, fpsAdjustedBitrateKbps, ladderFor } from './ladder';
import type { VideoTrackInfo } from './types';

describe('fpsAdjustedBitrateKbps', () => {
    it('leaves 30 fps and below on the table value', () => {
        expect(fpsAdjustedBitrateKbps(5000, 30)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 25)).toBe(5000);
        expect(fpsAdjustedBitrateKbps(5000, 23.976)).toBe(5000);
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
});
