package org.bccsa.luminary.player.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the web player's `nextUpVisible`. */
class NextUpTest {
    private fun due(
        offered: Boolean = true,
        closed: Boolean = false,
        live: Boolean = false,
        duration: Double? = 600.0,
        position: Double = 595.0,
    ) = NextUp.due(offered, closed, live, duration, position)

    @Test
    fun `it is up with ten seconds or less left`() {
        assertTrue(due(position = 590.0))
        assertTrue(due(position = 599.0))
        assertFalse(due(position = 589.9))
    }

    @Test
    fun `it leaves most of a short clip uncovered`() {
        // A 1:16 video: not at 0:16, only in its last ten seconds.
        assertFalse(due(duration = 76.0, position = 16.0))
        assertTrue(due(duration = 76.0, position = 66.0))
    }

    @Test
    fun `it stays away with nothing on offer or once closed`() {
        assertFalse(due(offered = false))
        assertFalse(due(closed = true))
    }

    @Test
    fun `live and an unknown length have no end to count down to`() {
        assertFalse(due(live = true))
        assertFalse(due(duration = null))
        assertFalse(due(duration = 0.0))
    }
}
