/**
 * Square-pixel geometry.
 *
 * HLS output from this encoder is **always** square-pixel — every rendition is
 * scaled to its display size and tagged `setsar=1`. That is a contract, not an
 * adjustment, and it exists because a coded frame size says nothing about the
 * shape of the picture inside it: a 720x576 PAL broadcast carrying 16:9 stores
 * non-square samples (ffprobe reports `sample_aspect_ratio` 64:45) and is meant
 * to be shown 1024 square pixels wide. Fed its coded width, this form used to
 * suggest a 600x480 rung — the source's storage shape, which is nobody's
 * picture.
 *
 * A deliberate copy of `api/src/encode/services/aspect.ts`, for the reason
 * `copyMode.ts` sets out at length: the API cannot import a Vue library, and
 * both sides have to answer this identically. Twenty lines, kept in step by
 * reading them.
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
 * The fallback is what makes this safe against a probe from before the API
 * reported the fields: an absent `displayWidth` means "nobody asked", and the
 * coded size is the right answer for every square-pixel source, which is all
 * but broadcast SD.
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
