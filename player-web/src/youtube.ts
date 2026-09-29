/**
 * YouTube URL recognition, ported from the Luminary app's `util/youtube.ts`.
 *
 * The player branches on this before anything else: a YouTube URL bypasses the
 * whole LMC pipeline (no munging, no key, no controller) and is handed to
 * `videojs-youtube` instead. Kept pure and free of video.js so the branch is
 * decidable before a player exists.
 */

/**
 * Matches every YouTube form the app has ever been handed: `watch?v=`, `/v/`,
 * `/e/`, `/embed/`, a channel-ish path with a trailing id, and `youtu.be/`.
 * The id is the trailing 11-character group — YouTube's fixed width, which is
 * what makes a single expression able to cover the lot.
 */
const YOUTUBE_URL =
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/;

/** Whether this URL is a YouTube video the `videojs-youtube` tech can play. */
export function isYouTubeUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return YOUTUBE_URL.test(url);
}

/** The 11-character video id, or null when the URL is not a YouTube one. */
export function extractYouTubeId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(YOUTUBE_URL);
    return match?.[1] ?? null;
}

/**
 * Normalizes any YouTube URL to the canonical `watch?v=` form.
 *
 * `videojs-youtube` accepts several shapes but resolves them inconsistently
 * (a `youtu.be` short link goes through an extra redirect inside the iframe),
 * so the id is extracted once here and the plugin is always handed the same
 * thing. A URL that is not YouTube is returned untouched — the caller has
 * already decided the mode, and rewriting it would be a lie.
 */
export function toVideoJsYouTubeUrl(url: string): string {
    const videoId = extractYouTubeId(url);
    if (!videoId) return url;
    return `https://www.youtube.com/watch?v=${videoId}`;
}
