/**
 * The poster the player always carries.
 *
 * The artwork a host passes as `poster` is drawn *behind* the player, by the
 * component, not by video.js — that is what lets the picture sit on the host's
 * own rounded, object-covered image rather than on video.js's letterboxed one.
 *
 * But a video.js player with no poster of its own shows a black rectangle
 * before the first frame, covering that artwork exactly when it is the only
 * thing there is to look at. Giving it a 1×1 transparent PNG is how the Luminary
 * app answers this: the poster machinery runs as normal and paints nothing.
 *
 * Inlined rather than shipped as a file so the package stays a single JS module
 * with no asset resolution for a consumer's bundler to get wrong. The cost of
 * inlining is that the pixel is unreadable: the base64 that used to be here
 * decoded to RGBA `[255, 0, 0, 127]` — red at half opacity — and washed every
 * frame it covered, most visibly over a YouTube iframe and over audio-only
 * playback, where the poster is the only layer left. `poster.spec.ts` decodes it
 * rather than trusting the name of the constant.
 */
export const TRANSPARENT_POSTER =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
