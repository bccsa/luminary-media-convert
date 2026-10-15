package org.bccsa.luminary.player.engine

import kotlin.math.abs

/** The intervals `player-web`'s skin can draw (`SKIP_ICON_SECONDS`), and so the ones native offers. */
private val SKIP_ICON_SECONDS = intArrayOf(5, 10, 30)

/**
 * Rounds a requested skip onto the set the skin can draw, as `snapSkipSeconds` in `player-web`
 * does, so a button's label and its jump agree. Null means no button.
 */
fun snapSkipSeconds(seconds: Double): Int? {
    if (!seconds.isFinite() || seconds <= 0) return null
    return SKIP_ICON_SECONDS.minBy { abs(it - seconds) }
}

/** What the full-screen controls and the notification skip by, from `CreateOptions`. */
data class SkinOptions(val skipBackSeconds: Double = 10.0, val skipForwardSeconds: Double = 10.0) {
    val back: Int? get() = snapSkipSeconds(skipBackSeconds)
    val forward: Int? get() = snapSkipSeconds(skipForwardSeconds)
}
