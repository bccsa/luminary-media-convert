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
        position: Double = 545.0,
    ) = NextUp.due(offered, closed, live, duration, position)

    @Test
    fun `it is up with a minute or less left`() {
        assertTrue(due(position = 540.0))
        assertTrue(due(position = 599.0))
        assertFalse(due(position = 539.9))
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
