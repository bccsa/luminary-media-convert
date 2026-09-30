package org.bccsa.luminary.player.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mirrors `snapSkipSeconds` in `player-web`, so a skip means the same on every platform. */
class SkipSecondsTest {
    @Test
    fun `the seconds the skin can draw are kept`() {
        assertEquals(5, snapSkipSeconds(5.0))
        assertEquals(10, snapSkipSeconds(10.0))
        assertEquals(30, snapSkipSeconds(30.0))
    }

    @Test
    fun `anything else snaps to the nearest, the first winning a tie`() {
        assertEquals(5, snapSkipSeconds(1.0))
        assertEquals(5, snapSkipSeconds(7.0))
        assertEquals(10, snapSkipSeconds(8.0))
        assertEquals(10, snapSkipSeconds(20.0))
        assertEquals(30, snapSkipSeconds(100.0))
    }

    @Test
    fun `zero, negative and non-finite mean no button`() {
        assertNull(snapSkipSeconds(0.0))
        assertNull(snapSkipSeconds(-10.0))
        assertNull(snapSkipSeconds(Double.NaN))
        assertNull(snapSkipSeconds(Double.POSITIVE_INFINITY))
    }

    @Test
    fun `the options snap each direction on its own`() {
        val options = SkinOptions(skipBackSeconds = 12.0, skipForwardSeconds = 0.0)
        assertEquals(10, options.back)
        assertNull(options.forward)
    }
}
