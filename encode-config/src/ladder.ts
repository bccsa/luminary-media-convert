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
