/**
 * The arithmetic behind the scrub preview: where a pointer lands on the timeline, what time that is,
 * which frame covers it, and where the preview may sit. Pure, so the rules a native player has to
 * reproduce — the nudge off the end, the clamping — are written down once and tested.
 */

/** How close to the bar, in pixels, the pointer still counts as being on it. A finger is not precise. */
export const SCRUB_SLOP_PX = 18;

/** How far the preview keeps from the edge of the frame, in pixels. */
export const SCRUB_EDGE_PX = 8;

/** Where `clientX` falls along `rect`, 0–1, or null when the bar has no width to measure against. */
export function pointerRatio(clientX: number, rect: { left: number; width: number }): number | null {
    if (!(rect.width > 0)) return null;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** Whether the pointer is on the bar, or close enough above or below it that the viewer means it. */
export function isOnBar(
    clientX: number,
    clientY: number,
    rect: { left: number; right: number; top: number; bottom: number },
    slop = SCRUB_SLOP_PX
): boolean {
    return (
        rect.right > rect.left &&
        clientX >= rect.left - slop &&
        clientX <= rect.right + slop &&
        clientY >= rect.top - slop &&
        clientY <= rect.bottom + slop
    );
}

/**
 * The time a ratio names, and the time to look a frame up at.
 *
 * Cue ranges are end-exclusive, so a drag to the far right of the bar lands exactly on the last cue's
 * end and matches nothing — the preview would blink out at the one position a viewer is most likely to
 * hold. The label keeps the true time; only the lookup is nudged back off the end.
 */
export function previewTimes(ratio: number, duration: number): { time: number; lookup: number } {
    const time = ratio * duration;
    return { time, lookup: Math.min(time, Math.max(0, duration - 0.001)) };
}

/**
 * Centre of a preview `width` wide, as close to `x` as keeps the whole box between `min` and `max`.
 * When the space is narrower than the box it is centred in it, which spills evenly rather than off one
 * side.
 */
export function clampPreviewCentre(x: number, width: number, min: number, max: number): number {
    const half = width / 2;
    if (max - min < width) return (min + max) / 2;
    return Math.min(max - half, Math.max(min + half, x));
}

/** `m:ss`, or `h:mm:ss` when the media runs an hour or more. */
export function formatClock(seconds: number, withHours: boolean): string {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return withHours ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${Math.floor(total / 60)}:${ss}`;
}
