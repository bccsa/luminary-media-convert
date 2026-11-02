/**
 * Every user-facing string this package renders itself; the controls' own labels are Video.js's.
 *
 * Hosts localize by passing a `messages` prop of resolved strings, or replace whole surfaces through
 * the `coming-soon` / `error` scoped slots.
 */
export interface PlayerMessages {
    /** Shown while the master playlist has not been published yet. */
    comingSoon: string;
    /** Fallback for any error code without a dedicated message. */
    errorGeneric: string;
    /** Engine cannot play munged content in this browser (e.g. iOS < 17.1). */
    errorUnsupportedBrowser: string;
    /** Encrypted content was loaded without a key. */
    errorKeyRequired: string;
    errorNetwork: string;
    errorMedia: string;
    retry: string;
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
