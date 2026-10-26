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
    fun `a tap opens the strip and holds the video, without moving it`() {
        scrub.tapped(framesReady = true, playing = true)
        assertEquals(Mode.STRIP, scrub.mode)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause), effects)
    }

    @Test
    fun `without frames a tap opens the thick bar instead`() {
        scrub.tapped(framesReady = false, playing = true)
        assertEquals(Mode.BAR, scrub.mode)
        assertEquals(listOf(Effect.Open(Mode.BAR), Effect.Pause), effects)
    }

    @Test
    fun `only a drag moves the video, and it stays held after`() {
        scrub.tapped(framesReady = true, playing = true)
        scrub.dragBegan(framesReady = true, playing = false)
        scrub.dragEnded(42.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Seek(42.0)), effects)
        assertTrue(scrub.isOpen)
    }

    @Test
    fun `a drag from closed opens it on the way`() {
        scrub.dragBegan(framesReady = true, playing = true)
        scrub.dragEnded(10.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Seek(10.0)), effects)
    }

    @Test
    fun `it closes three seconds after the last touch, and the video plays on`() {
        scrub.tapped(framesReady = true, playing = true)
        clock.advance(2.9)
        assertTrue(scrub.isOpen)
        clock.advance(0.1)
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Close, Effect.Play), effects.takeLast(2))
    }

    @Test
    fun `a finger on it keeps it open, and the count starts again when it lifts`() {
        scrub.tapped(framesReady = true, playing = true)
        clock.advance(2.0)
        scrub.dragBegan(framesReady = true, playing = false)
        clock.advance(10.0)
        assertTrue(scrub.isOpen)
        scrub.dragEnded(5.0)
        clock.advance(2.9)
        assertTrue(scrub.isOpen)
        clock.advance(0.1)
        assertFalse(scrub.isOpen)
    }

    @Test
    fun `a tap elsewhere closes it and the video plays on`() {
        scrub.tapped(framesReady = true, playing = true)
        scrub.tappedElsewhere()
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Close, Effect.Play), effects)
    }

    @Test
    fun `a video that was paused stays paused when it closes`() {
        scrub.tapped(framesReady = true, playing = false)
        clock.advance(3.0)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Close), effects)
    }

    @Test
    fun `play closes it and plays, even if the video was paused`() {
        scrub.tapped(framesReady = false, playing = false)
        scrub.playPressed()
        assertFalse(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.BAR), Effect.Close, Effect.Play), effects)
    }

    @Test
    fun `a new video puts it away without playing`() {
        scrub.tapped(framesReady = true, playing = true)
        scrub.reset()
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause, Effect.Close), effects)
        clock.advance(10.0)
        assertEquals(3, effects.size)
    }

    @Test
    fun `a second tap while open does nothing but start the count again`() {
        scrub.tapped(framesReady = true, playing = true)
        clock.advance(2.0)
        scrub.tapped(framesReady = true, playing = false)
        clock.advance(2.9)
        assertTrue(scrub.isOpen)
        assertEquals(listOf(Effect.Open(Mode.STRIP), Effect.Pause), effects)
    }
}
