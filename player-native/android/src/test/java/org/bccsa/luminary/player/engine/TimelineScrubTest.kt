package org.bccsa.luminary.player.engine

import org.bccsa.luminary.player.conformance.VirtualClock
import org.bccsa.luminary.player.engine.TimelineScrub.Effect
import org.bccsa.luminary.player.engine.TimelineScrub.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the iOS player's `TimelineScrubTests`. */
class TimelineScrubTest {
    private val clock = VirtualClock()
    private val effects = mutableListOf<Effect>()
    private val scrub = TimelineScrub(clock).also { it.onEffect = { effect -> effects += effect } }

    @Test
    fun `a tap opens the strip without moving the video or holding it`() {
        scrub.tapped(framesReady = true)
        assertEquals(Mode.STRIP, scrub.mode)
        assertEquals(listOf(Effect.Open(Mode.STRIP)), effects)
    }

    @Test
    fun `without frames a tap opens the thick bar instead`() {
        scrub.tapped(framesReady = false)
        assertEquals(Mode.BAR, scrub.mode)
        assertEquals(listOf(Effect.Open(Mode.BAR)), effects)
    }

    @Test
    fun `a drag holds the video under the finger, and it plays on from where the finger let go`() {
        scrub.dragBegan(framesReady = true, playing = true)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause), effects)
        scrub.dragEnded(42.0)
        assertTrue(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Seek(42.0), Effect.Play), effects)
    }

    @Test
    fun `a video that was paused stays paused after a drag`() {
        scrub.dragBegan(framesReady = true, playing = false)
        scrub.dragEnded(10.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Seek(10.0)), effects)
    }

    @Test
    fun `a drag taken away from the finger plays on without moving`() {
        scrub.dragBegan(framesReady = true, playing = true)
        scrub.dragCancelled()
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Play), effects)
    }

    @Test
    fun `a drag reported again while under way holds and plays on once`() {
        scrub.dragBegan(framesReady = true, playing = true)
        scrub.dragBegan(framesReady = true, playing = false)
        scrub.dragEnded(5.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Seek(5.0), Effect.Play), effects)
    }

    @Test
    fun `it closes five seconds after the last touch, leaving playback alone`() {
        scrub.tapped(framesReady = true)
        clock.advance(4.9)
        assertTrue(scrub.isOpen)
        clock.advance(0.1)
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Close), effects)
    }

    @Test
    fun `a finger on it keeps it open, and the count starts again when it lifts`() {
        scrub.tapped(framesReady = true)
        clock.advance(2.0)
        scrub.dragBegan(framesReady = true, playing = true)
        clock.advance(10.0)
        assertTrue(scrub.isOpen)
        scrub.dragEnded(5.0)
        clock.advance(4.9)
        assertTrue(scrub.isOpen)
        clock.advance(0.1)
        assertFalse(scrub.isOpen)
    }

    @Test
    fun `a tap elsewhere closes it`() {
        scrub.tapped(framesReady = true)
        scrub.tappedElsewhere()
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Close), effects)
    }

    @Test
    fun `play closes it and plays`() {
        scrub.tapped(framesReady = false)
        scrub.playPressed()
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.BAR), Effect.Close, Effect.Play), effects)
    }

    @Test
    fun `a new video mid-drag puts it away without playing`() {
        scrub.dragBegan(framesReady = true, playing = true)
        scrub.reset()
        clock.advance(10.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Close), effects)
    }

    @Test
    fun `a second tap while open does nothing but start the count again`() {
        scrub.tapped(framesReady = true)
        clock.advance(2.0)
        scrub.tapped(framesReady = true)
        clock.advance(4.9)
        assertTrue(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP)), effects)
    }
}
