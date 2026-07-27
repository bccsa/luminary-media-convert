/**
 * Waveform bar geometry.
 *
 * Peaks are normalized 0–1, and plotting them linearly is unkind to real material:
 * dialogue sitting at 10% of full scale draws 5px in a 48px track, so quiet or
 * sparse audio reads as an empty line. A square-root curve — what audio editors
 * conventionally use — lifts the quiet end without letting loud passages exceed
 * the track: that same 10% peak draws ~15px, while 100% still maps to the full
 * height.
 */
export function peakBarHeight(peak: number, maxHeight: number): number {
    if (!Number.isFinite(peak) || !Number.isFinite(maxHeight) || maxHeight <= 0) {
        return 0;
    }
    const clamped = Math.min(1, Math.max(0, peak));
    // Floor of 1px so silence still draws a baseline rather than vanishing.
    return Math.max(1, Math.sqrt(clamped) * maxHeight);
}
