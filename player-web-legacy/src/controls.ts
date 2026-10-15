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
 * The skip interval is configurable for the same reason: 10 s suits a lecture
 * and 30 s a sermon, and the consumer knows which it is shipping. Back and
 * forward are separate values because they are commonly asymmetric. The
 * defaults are 10 s here rather than `player-web`'s 15, because this player
 * exists to match the Luminary app's chrome and that is what it ships.
 */
export interface PlayerControlsOptions {
    /**
     * Show the audio-track menu. Only ever visible when the stream carries more
     * than one track, whatever this says.
     */
    audioMenu: boolean;
    /**
     * Show the audio/video toggle in the top-right corner. Only ever visible
     * when there is somewhere for it to go, whatever this says: the stream must
     * carry the synthesized audio-only rendering, and — when audio-only is what
     * is playing — a real video angle to come back to.
     */
    audioVideoToggle: boolean;
    /**
     * Show the subtitles / captions menu.
     *
     * Only ever visible when the source carries text tracks, whatever this says
     * — video.js hides the button itself while there are none. It is an option
     * regardless, because "invisible in today's content" is not the same promise
     * as "absent": an app that has never had this control does not want one
     * appearing the first time a stream ships a caption track.
     */
    subtitlesMenu: boolean;
    /**
     * Seconds the skip-back button moves. `0` removes the button, which is the
     * honest way to say "this player does not skip" — a button that moves
     * nowhere is worse than no button.
     *
     * video.js ships skip-button icons for 5, 10 and 30 seconds only, and hides
     * a button configured for anything else outright. Rather than lose the
     * control, an off-set value is snapped to the nearest of {5, 10, 30} — for
     * the icon *and* for the seek, which are the same number: the snapped value
     * is what is handed to video.js. So `15` is a 10-second button that seeks
     * 10 seconds, not a 15-second jump behind a "10" label. Stay on {5, 10, 30}
     * to get exactly what is asked for.
     */
    skipBackSeconds: number;
    /** Seconds the skip-forward button moves. `0` removes the button; the same snapping to {5, 10, 30} applies. */
    skipForwardSeconds: number;
}

/** The behaviour the library had before any of this was configurable. */
export const DEFAULT_CONTROLS: PlayerControlsOptions = {
    audioMenu: true,
    audioVideoToggle: true,
    subtitlesMenu: true,
    skipBackSeconds: 10,
    skipForwardSeconds: 10,
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

    for (const key of ['audioMenu', 'audioVideoToggle', 'subtitlesMenu'] as const) {
        const value = partial[key];
        if (typeof value === 'boolean') {
            merged[key] = value;
        }
    }
    for (const key of ['skipBackSeconds', 'skipForwardSeconds'] as const) {
        const value = partial[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            merged[key] = value;
        }
    }
    return merged;
}
