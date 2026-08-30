/**
 * Square-pixel geometry.
 *
 * HLS output from this encoder is **always** square-pixel — every rendition is
 * scaled to its display size and tagged `setsar=1`. That is a contract, not an
 * adjustment, and it exists because a coded frame size says nothing about the
 * shape of the picture inside it: a 720x576 PAL broadcast carrying 16:9 stores
 * non-square samples (ffprobe reports `sample_aspect_ratio` 64:45) and is meant
 * to be shown 1024 square pixels wide.
 *
 * Every ladder rung, preview rendition, storyboard tile and `RESOLUTION=`
 * attribute is a statement about the picture's shape, so all of them read the
 * display dimensions rather than deriving them from the ratio themselves. Six
 * places doing that arithmetic is six ways to get it wrong, which is how the
 * anamorphic bug happened in the first place.
 *
 * Pure, with no Nest or node imports, so `copy-mode-eligibility.ts` can use it
 * without pulling `child_process` in behind it.
 */

/** Just enough of a probed video track to answer a question about its shape. */
export interface AspectTrack {
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
}

/**
 * A track's square-pixel display dimensions, falling back to its coded ones.
 *
 * The fallback is what makes this safe on a session restored from before the
 * API reported the fields: an absent `displayWidth` means "nobody asked", and
 * the coded size is the right answer for every square-pixel source, which is
 * all but broadcast SD.
 */
export function displayDimensionsOf(track: AspectTrack | undefined): {
    width: number;
    height: number;
} {
    const width = track?.displayWidth;
    const height = track?.displayHeight;
    return {
        width: width != null && width > 0 ? width : (track?.width ?? 0),
        height: height != null && height > 0 ? height : (track?.height ?? 0),
    };
}

/**
 * Whether this track stores non-square pixels.
 *
 * The whole of the question, with no ratio arithmetic: the display dimensions
 * are equal to the coded ones exactly when the samples are square.
 */
export function isAnamorphic(track: AspectTrack | undefined): boolean {
    if (!track || track.width <= 0 || track.height <= 0) return false;
    const display = displayDimensionsOf(track);
    return display.width !== track.width || display.height !== track.height;
}
