/**
 * Every user-facing string this package can render lives here.
 *
 * Rule for the package: no string literal is ever written into the DOM outside
 * {@link DEFAULT_MESSAGES}. Implementing apps localize either by passing a
 * `messages` prop of resolved strings (any i18n framework, no coupling) or by
 * replacing whole surfaces through the `coming-soon` / `error` scoped slots.
 */
export interface PlayerMessages {
    // --- Status surfaces ---------------------------------------------------
    /** Shown while the master playlist has not been published yet. */
    comingSoon: string;

    // --- Errors ------------------------------------------------------------
    /** Fallback for any error code without a dedicated message. */
    errorGeneric: string;
    /** Engine cannot play munged content in this browser (e.g. iOS < 17.1). */
    errorUnsupportedBrowser: string;
    /** Encrypted content was loaded without a key. */
    errorKeyRequired: string;
    errorNetwork: string;
    errorMedia: string;
    retry: string;

    // --- Transport ---------------------------------------------------------
    play: string;
    pause: string;
    /** aria-label of the seek slider. */
    scrubberLabel: string;
    /** aria-label of the elapsed-time readout. */
    elapsedLabel: string;
    /** aria-label of the remaining-time readout. */
    remainingLabel: string;

    // --- Fullscreen --------------------------------------------------------
    /**
     * Only the exit affordance is ours. Entering fullscreen is the host app's
     * to place and label — it belongs with that app's own playback controls,
     * not floating over the picture. Call `enterFullscreen()` on the player.
     */
    exitFullscreen: string;

    // --- Track menus -------------------------------------------------------
    audioMenuLabel: string;
    subtitlesMenuLabel: string;
    /** The "no subtitles" entry of the subtitles menu. */
    subtitlesOff: string;
}

/** Built-in English strings. Merged under any partial the host supplies. */
export const DEFAULT_MESSAGES: PlayerMessages = {
    comingSoon: 'Coming soon',

    errorGeneric: 'This video could not be played.',
    errorUnsupportedBrowser: 'This browser cannot play this video. Please update it or try another one.',
    errorKeyRequired: 'This video is protected and no key was supplied.',
    errorNetwork: 'The video could not be reached. Check your connection.',
    errorMedia: 'Playback of this video failed.',
    retry: 'Try again',

    play: 'Play',
    pause: 'Pause',
    scrubberLabel: 'Seek',
    elapsedLabel: 'Elapsed time',
    remainingLabel: 'Remaining time',

    exitFullscreen: 'Exit full screen',

    audioMenuLabel: 'Audio',
    subtitlesMenuLabel: 'Subtitles',
    subtitlesOff: 'Off',
};

/**
 * Merges a partial override map over {@link DEFAULT_MESSAGES}. `undefined`
 * entries fall back to the default so callers can spread sparse objects.
 */
export function mergeMessages(partial?: Partial<PlayerMessages>): PlayerMessages {
    if (!partial) return { ...DEFAULT_MESSAGES };
    const merged = { ...DEFAULT_MESSAGES };
    for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof PlayerMessages)[]) {
        const value = partial[key];
        if (typeof value === 'string') merged[key] = value;
    }
    return merged;
}
