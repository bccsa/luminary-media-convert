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
    /**
     * aria-label of the readout at the far end of the scrubber, which shows the
     * whole length of the video rather than what is left of it.
     */
    durationLabel: string;
    /**
     * Skip-back button label. `{seconds}` is replaced with the configured
     * interval — the number must not be written into the string, or it reads
     * "15" on a player configured to move 10.
     */
    skipBack: string;
    /** Skip-forward button label. `{seconds}` is replaced as above. */
    skipForward: string;

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

    // --- Audio / video toggle ----------------------------------------------
    /**
     * The half of the top-right toggle that plays the picture. Labels an
     * action, not a state: pressing it is what returns to video.
     */
    videoModeLabel: string;
    /**
     * The half that plays sound only — no video data is downloaded at all, so
     * the wording is about bandwidth as much as about listening.
     */
    audioModeLabel: string;
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
    durationLabel: 'Total time',
    skipBack: 'Skip back {seconds} seconds',
    skipForward: 'Skip forward {seconds} seconds',

    exitFullscreen: 'Exit full screen',

    audioMenuLabel: 'Audio',
    subtitlesMenuLabel: 'Subtitles',
    subtitlesOff: 'Off',

    videoModeLabel: 'Play video',
    audioModeLabel: 'Play audio only',
};

/**
 * Fills `{seconds}` in a message that carries a number.
 *
 * Deliberately not a template engine: one named placeholder is the whole
 * requirement, and a translator needs to know only that the token survives into
 * their wording — including moving, which languages that put the number last
 * require.
 */
export function formatSeconds(template: string, seconds: number): string {
    return template.replace('{seconds}', String(seconds));
}

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
