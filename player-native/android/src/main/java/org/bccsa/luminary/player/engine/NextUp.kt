package org.bccsa.luminary.player.engine

/** When the strip of next videos is offered: the web player's rule, so full-screen counts down to the end the same way. */
internal object NextUp {
    /** The strip is up once this much or less of the video is left: the very end, so a short clip is not half covered. */
    const val LEAD_SECONDS = 10.0

    /** Room for this many cards. */
    const val MAX = 5

    /**
     * Whether the strip is due. Live and not-yet-known lengths have no end to count down to, and a strip the viewer
     * closed, or one with nothing on offer, stays away.
     */
    fun due(offered: Boolean, closed: Boolean, live: Boolean, durationSeconds: Double?, positionSeconds: Double): Boolean {
        if (!offered || closed || live) return false
        if (durationSeconds == null || !(durationSeconds > 0)) return false
        return durationSeconds - positionSeconds <= LEAD_SECONDS
    }
}
