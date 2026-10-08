package org.bccsa.luminary.player.engine

import org.junit.Assert.assertEquals
import org.junit.Test

/** The time text, as `FullscreenControlsTests.swift` pins it: video.js's `formatTime`. */
class FullscreenTextTest {
    @Test
    fun `minutes and seconds, padded as video js pads them`() {
        assertEquals("0:07", formatTime(7.9, guide = 120.0))
        assertEquals("2:00", formatTime(120.0, guide = 120.0))
        // The duration reaches ten minutes, so every time pads its minutes.
        assertEquals("01:05", formatTime(65.0, guide = 600.0))
        assertEquals("10:00", formatTime(600.0, guide = 600.0))
    }

    @Test
    fun `hours appear once the duration reaches one, for every time`() {
        assertEquals("0:00:07", formatTime(7.0, guide = 3600.0))
        assertEquals("1:01:01", formatTime(3661.0, guide = 7200.0))
    }

    @Test
    fun `a negative time reads as zero, and one that is not a number reads dashes`() {
        assertEquals("0:00", formatTime(-5.0, guide = 60.0))
        assertEquals("-:-", formatTime(Double.NaN, guide = 60.0))
        assertEquals("-:-:-", formatTime(Double.NaN, guide = 3600.0))
    }

    @Test
    fun `the time row reads position over duration, or LIVE`() {
        assertEquals("0:07 / 2:00", timeText(live = false, position = 7.4, duration = 120.0))
        assertEquals("LIVE", timeText(live = true, position = 7.4, duration = 0.0))
    }

    @Test
    fun `a position past the known duration widens the duration to it`() {
        assertEquals("0:05 / 0:05", timeText(live = false, position = 5.0, duration = 0.0))
    }
}
