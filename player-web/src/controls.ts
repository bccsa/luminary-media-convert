/**
 * What the fullscreen controls offer, and how far the skip buttons move.
 *
 * `player-web` is a published library, not one app's private UI. Outside
 * fullscreen the encoder draws its own audio selector beside the player, so the
 * one in here is redundant *for the encoder* — but a consumer app has no
 * selectors of its own, and for its viewers these controls are the whole
 * surface. Removing the menu outright would take language switching away from
 * every consumer to tidy one screen. So it is configurable, and the default is
 * what the library did before this option existed.
 *
 * The skip interval is configurable for the same reason: 15 s suits a lecture
 * and 30 s a sermon, and the consumer knows which it is shipping. Back and
 * forward are separate values because they are commonly asymmetric.
 */
export interface PlayerControlsOptions {
    /**
     * Show the audio-track menu. Only ever visible when the stream carries more
     * than one track, whatever this says.
     */
    audioMenu: boolean;
    /**
     * Seconds the skip-back button moves. `0` removes the button, which is the
     * honest way to say "this player does not skip" — a button that moves
     * nowhere is worse than no button.
     */
    skipBackSeconds: number;
    /** Seconds the skip-forward button moves. `0` removes the button. */
    skipForwardSeconds: number;
}

/** The behaviour the library had before any of this was configurable. */
export const DEFAULT_CONTROLS: PlayerControlsOptions = {
    audioMenu: true,
    skipBackSeconds: 15,
    skipForwardSeconds: 15,
};

/**
 * Merges a partial override map over {@link DEFAULT_CONTROLS}.
 *
 * Sparse is the point: a host that only wants to drop the audio menu says that
 * and inherits every other default, so adding an option here later cannot
 * change what an existing caller already gets.
 *
 * A negative or non-finite interval is treated as absent rather than honoured —
 * `NaN` would travel into `seek()` and strand the video, and seeking backwards
 * from the forward button is not a configuration anyone means.
 */
export function mergeControls(
    partial?: Partial<PlayerControlsOptions>
): PlayerControlsOptions {
    const merged = { ...DEFAULT_CONTROLS };
    if (!partial) return merged;

    if (typeof partial.audioMenu === 'boolean') {
        merged.audioMenu = partial.audioMenu;
    }
    for (const key of ['skipBackSeconds', 'skipForwardSeconds'] as const) {
        const value = partial[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            merged[key] = value;
        }
    }
    return merged;
}
