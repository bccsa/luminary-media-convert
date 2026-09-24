import { displayDimensionsOf } from './aspect';
import type { VideoTrackInfo } from './types';

/** One rung of the standard ABR ladder. */
export interface LadderRung {
    height: number;
    width: number;
    bitrateKbps: number;
    label: string;
    /**
     * This rung's budget is the source's own *measured* bitrate rather than a
     * table value written for 30 fps. Only the sub-144p fallback sets it, and
     * {@link suggestLadder} reads it to skip the frame-rate adjustment: the
     * measurement was taken at the source's own frame rate, so adjusting it
     * would apply that frame rate a second time and quietly cut a 24 fps clip
     * by 15%.
     */
    sourceMeasured?: boolean;
}

/**
 * The standard ABR ladder, in 16:9 square pixels at 30 fps.
 *
 * The budgets are 30 fps numbers, sized at or just under the tiers in Apple's
 * HLS authoring specification, which leaves ~25p material — the common case
 * here, and x0.872 through {@link fpsAdjustedBitrateKbps} — landing about where
 * the old table put it outright.
 *
 * Bits per pixel rises monotonically as the resolution falls, which is the way
 * round it has to be: a downscaled picture is a *harder* picture, because
 * scaling throws away exactly the smooth detail an encoder predicts cheaply and
 * keeps the edges it does not. The old table had 480p at 0.00244 bits per pixel
 * against 720p's 0.00271 — backwards: the rung where bandwidth-constrained
 * viewers actually sit was the thinnest-served in the table.
 *
 * Widths here are only the canonical case; a rung's real width comes from
 * {@link aspectWidthForHeight} against the source's *display* shape, which
 * reproduces these exactly for a 16:9 source.
 */
export const ABR_LADDER: LadderRung[] = [
    { height: 2160, width: 3840, bitrateKbps: 16000, label: '4K' },
    { height: 1440, width: 2560, bitrateKbps: 9000, label: '1440p' },
    { height: 1080, width: 1920, bitrateKbps: 5500, label: '1080p' },
    { height: 720, width: 1280, bitrateKbps: 3000, label: '720p' },
    { height: 480, width: 854, bitrateKbps: 1400, label: '480p' },
    { height: 360, width: 640, bitrateKbps: 800, label: '360p' },
    { height: 240, width: 426, bitrateKbps: 400, label: '240p' },
    { height: 144, width: 256, bitrateKbps: 200, label: '144p' },
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
 * Rungs are chosen and priced by the source's *short* side, and sized at its
 * shape. The table's 1080p is a 1920x1080 picture, and 1080x1920 is the same
 * picture turned on end; keyed by height instead, a phone's 1080x1920 was
 * laddered as a 1920-line picture — eight rungs, a 4K budget on top, and an
 * 810x1440 rung priced for 2560x1440. A landscape or square source's short side
 * is its height, so for every one of those this is the ladder it always had.
 *
 * The standard rungs at or below that side — plus a rung at the source's own
 * size when the table has none. A 576-line PAL source otherwise topped out at
 * 480p, throwing away a fifth of the lines it actually has, and for a 16:9 one
 * it was worse: 480p at the source's storage shape, 600x480.
 *
 * Only for a source that sits *inside* the table's range; one bigger than 4K is
 * still capped at 4K, as it always has been. The extra rung is priced linearly
 * in pixel count against the standard rung below it, which keeps it on the
 * curve the table already draws (720p has 2.25x the pixels of 480p and 2.5x the
 * bits).
 */
export function ladderFor(track: VideoTrackInfo): LadderRung[] {
    const display = displayDimensionsOf(track);
    const portrait = display.height > display.width;
    const shortSide = portrait ? display.width : display.height;
    const longSide = portrait ? display.height : display.width;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    // A rung whose short side is `side`, at the source's display shape — the
    // table rungs included. The table's own widths are 16:9, and a caller that
    // took them at face value offered a 4:3 source a 854x480 rung it would have
    // to pillarbox to fill.
    const sized = (side: number) => {
        const other = aspectWidthForHeight(side, longSide, shortSide);
        return portrait
            ? { width: side, height: other }
            : { width: other, height: side };
    };
    const rungs = ABR_LADDER.filter((r) => r.height <= shortSide).map((r) => ({
        ...r,
        ...sized(r.height),
    }));

    if (rungs.length === 0) {
        return [
            {
                width: even(display.width),
                height: even(display.height),
                bitrateKbps: track.bitrateKbps || 1000,
                label: `${even(shortSide)}p`,
                // Below every table rung there is nothing to interpolate
                // against, so this budget is the source's own measurement — at
                // the source's own frame rate, which is what `sourceMeasured`
                // tells `suggestLadder` not to adjust a second time.
                sourceMeasured: true,
            },
        ];
    }

    const hasSourceRung = ABR_LADDER.some((r) => r.height === shortSide);
    if (hasSourceRung || shortSide >= ABR_LADDER[0].height) return rungs;

    const below = rungs[0];
    const sourceSide = even(shortSide);
    const top = sized(sourceSide);
    // Priced against the rung below it *at this source's shape* — which is what
    // `below` now is. A 4:3 source's 480p rung is 640x480, not 854x480, and
    // pricing against the table's wider 16:9 number made a 720x540 top rung
    // come out cheaper than the 480p beneath it.
    return [
        {
            ...top,
            bitrateKbps: Math.round(
                (below.bitrateKbps * (top.width * top.height)) /
                    (below.width * below.height)
            ),
            label: `${sourceSide}p`,
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
 * Scales with (fps/30)^0.75, in both directions. The exponent is sublinear
 * because H.264 is inter-frame and our GOP is time-based (`-g = segmentDuration
 * x fps`), so the I-frame overhead per *second* of video does not move with the
 * frame rate at all: doubling the frame rate needs +30-50% bits for equal
 * per-frame quality, +50-60% on high motion. The number is a maxrate ceiling
 * rather than a target — CRF drives the quality and unused headroom costs
 * nothing — so it is sized to the high-motion end, 2^0.75 = 1.68x. #93/#99
 * anchor that empirically at 50 fps (1.467x, inside the 1.40-1.54 band those
 * cases validated); ^0.5 would land below it.
 *
 * Downward it is the same logic inverted: sparser frames carry bigger deltas
 * between them, so 24 fps saves 15% rather than the 20% a linear rule would
 * take. The 0.7 floor binds only below ~18.6 fps.
 *
 * The `fps <= 0` guard in front of all of it is load-bearing, not tidiness: an
 * unprobed source reports 0 or NaN, and must come away with the table value —
 * hitting the floor instead would dock 30% off every rung of a ladder built
 * from a source nobody has measured yet.
 */
export function fpsAdjustedBitrateKbps(baseKbps: number, fps: number): number {
    if (!Number.isFinite(fps) || fps <= 0) return baseKbps;
    const factor = Math.min(Math.max(Math.pow(fps / 30, 0.75), 0.7), 2);
    return Math.round(baseKbps * factor);
}

/**
 * The most a rung of this size can usefully carry, given what the source has.
 *
 * Re-encoding above the source's own bitrate recovers nothing: the detail was
 * thrown away by whoever encoded the file, and every bit spent past that point
 * pays to reproduce that encoder's artefacts faithfully. A 1080p source at 1805
 * kbps was being offered a 5500 kbps 1080p rendition — three times the bytes
 * for strictly less picture than the file already contains.
 *
 * Lower rungs are capped sublinearly rather than in proportion to their pixel
 * count, because downscaling a soft source yields a genuinely sharper small
 * picture: the 480p rung deserves more per pixel than the source spent, and a
 * proportional cap would starve it. The outer `min` covers the two ways the
 * ratio can reach past 1 — odd-height rounding (a 577-line source's own rung is
 * 578 lines, so its pixel count fractionally exceeds the source's) and a rung an
 * operator added above the source's size.
 *
 * `Infinity` when the source bitrate or either pixel area is unknown: an absent
 * measurement is not a licence to guess a ceiling. Note too that
 * `ProbeService`'s packet-counting fallback — what MKV and MXF get, since
 * neither declares a stream bitrate — reports a *peak* rather than an average,
 * so the cap derived from it is a generous one.
 */
export function sourceCapKbps(
    rungWidth: number,
    rungHeight: number,
    sourceKbps: number,
    sourceDisplayWidth: number,
    sourceDisplayHeight: number
): number {
    const rungPx = rungWidth * rungHeight;
    const sourcePx = sourceDisplayWidth * sourceDisplayHeight;
    if (!(sourceKbps > 0) || !(rungPx > 0) || !(sourcePx > 0)) return Infinity;
    return Math.min(
        sourceKbps,
        Math.round(sourceKbps * Math.pow(rungPx / sourcePx, 0.75))
    );
}

/** One ladder rung, priced for the source in front of it. */
export interface SuggestedRendition {
    width: number;
    height: number;
    bitrateKbps: number;
    label: string;
}

/** A named content-complexity factor, as the form offers it. */
export interface ContentPreset {
    id: 'low' | 'standard' | 'high';
    label: string;
    factor: number;
}

/**
 * The content-complexity presets, multiplying the table's generic budget.
 *
 * The table is written for material nobody has described — mixed motion, mixed
 * detail. A camera locked on a lectern for an hour is not that, and neither is
 * sport, so the operator gets to say which.
 *
 * Low motion is 0.6 and deliberately not lower, however still the picture looks
 * in the preview. The rendition's number is double duty: it sets the CRF target
 * *and* the `-maxrate` ceiling, so it has to cover the peak, not the average.
 * Calm content is not zero-motion content — it is bursty, and the burst is the
 * whole-frame pan or the congregation standing up. A x0.3 ceiling pins the
 * encoder at maxrate the instant the camera moves, which is #93's starvation
 * mode arriving by a different road: the average would have been fine and the
 * only visible seconds are ruined. Below 0.6 is available through the form's
 * Custom entry, as the operator's deliberate call rather than a preset's.
 */
export const CONTENT_PRESETS: ContentPreset[] = [
    { id: 'low', label: 'Low motion', factor: 0.6 },
    { id: 'standard', label: 'Standard', factor: 1 },
    { id: 'high', label: 'High motion', factor: 1.3 },
];

/**
 * The ladder to put in front of the operator, priced for this source.
 *
 * Three decisions compose here, and the order of the last two is the whole of
 * it. {@link ladderFor} picks the rungs and the table gives each a 30 fps
 * budget; {@link fpsAdjustedBitrateKbps} moves that budget to the source's
 * frame rate; {@link sourceCapKbps} takes whichever of that and the source's
 * own means is smaller. The cap is never itself fps-adjusted — it comes from a
 * measured bitrate that was already recorded at the source's frame rate, and
 * adjusting it would apply that frame rate twice. `min(fpsAdjusted(table),
 * cap)`, never `fpsAdjusted(min(...))`.
 *
 * The ladder stays monotonic for free: both sequences rise with the rung size,
 * and a pointwise minimum of two increasing sequences increases. The sub-144p
 * fallback rung is the one exception to the adjustment, which is what
 * {@link LadderRung.sourceMeasured} exists to say.
 *
 * `contentFactor` ({@link CONTENT_PRESETS}, or an operator's own number) is
 * applied asymmetrically, because its two directions mean different things
 * against the cap. Raising (x1.3) says the table's guess about generic content
 * undershoots — and the table is the only guessed term, so the raise lands on
 * the table value and the cap still wins: no factor can conjure detail the file
 * does not carry, and a 235 kbps source stays 235 under High motion. Lowering
 * (x0.6) says this material needs less than *whatever* was going to be spent,
 * and nothing about the source can forbid spending less — so the reduction
 * also scales the cap, and a leanly encoded calm source comes down with
 * everything else. It was once applied before the cap in both directions, and
 * on a source lean enough for the cap to bind, Low motion visibly did nothing:
 * a preset the operator chose and could not see was worse than the double
 * discount it avoided. `sourceMeasured` rungs follow the same rule through the
 * cap, which equals their measurement.
 *
 * A factor that is not a positive finite number is ignored rather than obeyed —
 * a half-typed entry must not flatten the ladder to 1 kbps. Monotonicity is
 * untouched: the factor scales each increasing sequence uniformly, and the
 * pointwise min of increasing sequences still increases.
 */
export function suggestLadder(
    track: VideoTrackInfo,
    contentFactor = 1
): SuggestedRendition[] {
    const display = displayDimensionsOf(track);
    const fps = track.frameRate ?? 30;
    const f =
        Number.isFinite(contentFactor) && contentFactor > 0 ? contentFactor : 1;
    return ladderFor(track).map((rung) => {
        const base = rung.sourceMeasured
            ? rung.bitrateKbps
            : Math.round(fpsAdjustedBitrateKbps(rung.bitrateKbps, fps) * f);
        const cap = sourceCapKbps(
            rung.width,
            rung.height,
            track.bitrateKbps,
            display.width,
            display.height
        );
        const ceiling = Number.isFinite(cap)
            ? Math.round(cap * Math.min(f, 1))
            : cap;
        return {
            width: rung.width,
            height: rung.height,
            label: rung.label,
            bitrateKbps: Math.max(1, Math.min(base, ceiling)),
        };
    });
}
