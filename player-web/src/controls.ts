/** Which of the stock skin's controls the player offers. */
export interface PlayerControlsOptions {
    /** Show the audio-track menu. Only ever visible when the stream carries more than one track. */
    audioMenu: boolean;
    /** Show the captions button and menu. Only ever visible when the source carries text tracks. */
    subtitlesMenu: boolean;
    /**
     * Show the controls while the player is windowed.
     *
     * `false` leaves the windowed frame bare, for a host that drives playback from its own interface (the
     * encoder, whose timeline shortcuts are the whole transport): nothing on the frame takes a click, focus or
     * a key, and a double-click toggles fullscreen. Fullscreen shows every control regardless.
     */
    windowedControls: boolean;
}

export const DEFAULT_CONTROLS: PlayerControlsOptions = {
    audioMenu: true,
    subtitlesMenu: true,
    windowedControls: true,
};

/**
 * Merges a partial override map over {@link DEFAULT_CONTROLS}. Sparse is the point: adding an option
 * here later cannot change what an existing caller already gets.
 */
export function mergeControls(partial?: Partial<PlayerControlsOptions>): PlayerControlsOptions {
    const merged = { ...DEFAULT_CONTROLS };
    if (!partial) return merged;
    for (const key of ['audioMenu', 'subtitlesMenu', 'windowedControls'] as const) {
        const value = partial[key];
        if (typeof value === 'boolean') merged[key] = value;
    }
    return merged;
}
