/**
 * The 3-second control auto-hide.
 *
 * video.js hides its own control bar when the pointer leaves it — which never
 * happens here, because this skin stretches the bar over the whole picture (see
 * `styles.css`). With the bar covering the video, the pointer is always "on the
 * controls" and they never go away.
 *
 * So the Luminary app drives the same state machine by hand: every pointer
 * movement or click restarts a timer, and the timer marks the user inactive,
 * which is the signal video.js already fades the chrome on. This is a port of
 * that workaround, not an invention.
 */
import type Player from 'video.js/dist/types/player';

/** How long the chrome stays up after the last movement, in milliseconds. */
export const AUTO_HIDE_MS = 3000;

/**
 * Starts hiding the controls 3 s after the last pointer activity.
 *
 * Returns an uninstall function: it clears the pending timer as well as
 * detaching the listeners, because a timer that fires after the player is
 * disposed calls a method on a dead object.
 */
export function installAutoHide(player: Player, delayMs = AUTO_HIDE_MS): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            player.userActive(false);
        }, delayMs);
    };

    player.on(['mousemove', 'click'], schedule);

    return () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        player.off(['mousemove', 'click'], schedule);
    };
}
