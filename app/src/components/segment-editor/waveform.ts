/**
 * The most a waveform is boosted. Enough to bring a quiet recording up to the
 * full height of the strip; not so much that a file of background hiss is
 * drawn as if it were speech.
 */
export const MAX_WAVEFORM_GAIN = 16;

/**
 * What every peak is multiplied by so the loudest one reaches the top of the
 * strip. Peaks are the recording's real amplitude, so a quiet recording would
 * otherwise sit as a thin band along the bottom with its shape hard to read.
 *
 * Taken over every peak the timeline has, not the part on screen, so zooming
 * does not change the heights. A silent file stays flat.
 */
export function waveformGain(
    peaks: readonly number[] | null | undefined
): number {
    let loudest = 0;
    for (const peak of peaks ?? []) {
        if (peak > loudest) loudest = peak;
    }
    if (loudest <= 0) return 1;
    return Math.min(1 / loudest, MAX_WAVEFORM_GAIN);
}
