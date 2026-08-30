import { displayDimensionsOf } from './aspect';
import type { VideoTrackInfo } from './types';

/** One rung of the standard ABR ladder. */
export interface LadderRung {
    height: number;
    width: number;
    bitrateKbps: number;
    label: string;
}

/**
 * The standard ABR ladder, in 16:9 square pixels at 30 fps.
 *
 * Widths here are only the canonical case; a rung's real width comes from
 * {@link aspectWidthForHeight} against the source's *display* shape, which
 * reproduces these exactly for a 16:9 source.
 */
export const ABR_LADDER: LadderRung[] = [
    { height: 2160, width: 3840, bitrateKbps: 15000, label: '4K' },
    { height: 1440, width: 2560, bitrateKbps: 8000, label: '1440p' },
    { height: 1080, width: 1920, bitrateKbps: 5000, label: '1080p' },
    { height: 720, width: 1280, bitrateKbps: 2500, label: '720p' },
    { height: 480, width: 854, bitrateKbps: 1000, label: '480p' },
    { height: 360, width: 640, bitrateKbps: 600, label: '360p' },
    { height: 240, width: 426, bitrateKbps: 300, label: '240p' },
    { height: 144, width: 256, bitrateKbps: 150, label: '144p' },
];

/**
 * A rendition width for a target height that keeps the source's *display*
 * shape, rounded even (H.264/yuv420p requires even dimensions).
 *
 * The dimensions to pass are the source's display dimensions, not its coded
 * ones. A 720x576 PAL broadcast carrying 16:9 stores 720 non-square samples and
 * is shown 1024 square ones wide; fed 720x576 this returned 600 for the 480p
 * rung — the source's storage shape, which is nobody's picture. Output is
 * always encoded square (`setsar=1` in the encoder's filter graph), so every
 * width this returns is a square-pixel width.
 *
 * For a 16:9 source it still reproduces the canonical ladder widths exactly
 * (480p to 854, 240p to 426). Returns at least 2.
 */
export function aspectWidthForHeight(
    height: number,
    sourceDisplayWidth: number,
    sourceDisplayHeight: number
): number {
    if (!sourceDisplayWidth || !sourceDisplayHeight) return height;
    const width =
        Math.round((height * sourceDisplayWidth) / sourceDisplayHeight / 2) * 2;
    return Math.max(2, width);
}

/**
 * The ladder for a single-track source, top rung first.
 *
 * The standard rungs at or below the source's display height — plus a rung at
 * that height itself when the table has none. A 576-line PAL source otherwise
 * topped out at 480p, throwing away a fifth of the lines it actually has, and
 * for a 16:9 one it was worse: 480p at the source's storage shape, 600x480.
 *
 * Only for a source that sits *inside* the table's range; one taller than 4K is
 * still capped at 4K, as it always has been. The extra rung is priced linearly
 * in pixel count against the standard rung below it, which keeps it on the
 * curve the table already draws (720p has 2.25x the pixels of 480p and 2.5x the
 * bits).
 */
export function ladderFor(track: VideoTrackInfo): LadderRung[] {
    const display = displayDimensionsOf(track);
    const sourceHeight = Math.max(2, Math.round(display.height / 2) * 2);
    const rungs = ABR_LADDER.filter((r) => r.height <= display.height);

    if (rungs.length === 0) {
        return [
            {
                height: sourceHeight,
                width: Math.max(2, Math.round(display.width / 2) * 2),
                bitrateKbps: track.bitrateKbps || 1000,
                label: `${sourceHeight}p`,
            },
        ];
    }

    const hasSourceRung = ABR_LADDER.some((r) => r.height === display.height);
    if (hasSourceRung || display.height >= ABR_LADDER[0].height) return rungs;

    const below = rungs[0];
    const width = aspectWidthForHeight(
        sourceHeight,
        display.width,
        display.height
    );
    // Priced against the rung below it *at this source's shape*, not against
    // the table's own 16:9 width. A 4:3 source's 480p rung is 640x480, not
    // 854x480, and comparing against the wider one made a 720x540 top rung come
    // out cheaper than the 480p beneath it.
    const belowWidth = aspectWidthForHeight(
        below.height,
        display.width,
        display.height
    );
    return [
        {
            height: sourceHeight,
            width,
            bitrateKbps: Math.round(
                (below.bitrateKbps * (width * sourceHeight)) /
                    (belowWidth * below.height)
            ),
            label: `${sourceHeight}p`,
        },
        ...rungs,
    ];
}

/**
 * Scale a ladder rung's bitrate to the source frame rate.
 *
 * The ABR ladder's budgets are 30 fps numbers. Applied unchanged to a 50 fps
 * broadcast they buy two-thirds of the bits per frame, the encoder rides its
 * rate cap, and motion macroblocks — reported as "scratching" on real output
 * whose stored data decoded perfectly cleanly (#93).
 *
 * Grows with (fps/30)^0.75 — motion compensation means doubling the frame rate
 * does not double the bits needed. Never shrinks below the table value: lower
 * frame rates keep the floor, extreme ones are capped at 2x.
 */
export function fpsAdjustedBitrateKbps(baseKbps: number, fps: number): number {
    if (!Number.isFinite(fps) || fps <= 30) return baseKbps;
    const factor = Math.min(Math.pow(fps / 30, 0.75), 2);
    return Math.round(baseKbps * factor);
}
