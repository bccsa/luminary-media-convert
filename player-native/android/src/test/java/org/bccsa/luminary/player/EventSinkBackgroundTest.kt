package org.bccsa.luminary.player

import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.Assert.assertEquals
import org.junit.Test

class EventSinkBackgroundTest {
    private val clock = VirtualClock()
    private val names = mutableListOf<String>()
    private val sink = EventSink("player-1", clock, variantSwitching = false, emit = { name, _ -> names += name }) { clock.now() }

    private fun timeupdates() = names.count { it == "timeupdate" }

    private fun playing() {
        sink.begin("load1")
        sink.playing()
        names.clear()
    }

    @Test
    fun `plays at 4 Hz in the foreground`() {
        playing()
        clock.advance(10.0)
        assertEquals(40, timeupdates())
    }

    @Test
    fun `slows to one every 5 s in the background, and back on return`() {
        playing()
        sink.setBackground(true)
        clock.advance(10.0)
        assertEquals(2, timeupdates())

        names.clear()
        sink.setBackground(false)
        clock.advance(1.0)
        assertEquals(4, timeupdates())
    }

    @Test
    fun `a pause in the background still reports at once`() {
        playing()
        sink.setBackground(true)
        sink.paused()
        assertEquals(listOf("timeupdate", "pause"), names)
        clock.advance(20.0)
        assertEquals(1, timeupdates())
    }
}
