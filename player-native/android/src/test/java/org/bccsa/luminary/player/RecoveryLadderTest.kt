package org.bccsa.luminary.player

import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The ladder on virtual time; every case is also pinned in `RecoveryLadderTests.swift`. */
class RecoveryLadderTest {
    private val clock = VirtualClock()
    private val steps = mutableListOf<String>()
    private var inPlaceAnswer = false
    private val failure = RecoveryLadder.Failure("network", "network-error", "offline")

    private val hooks = object : RecoveryLadder.Hooks {
        override fun recoverInPlace(category: String): Boolean {
            steps += "in-place"
            return inPlaceAnswer
        }

        override fun reattach() {
            steps += "reattach@${clock.now()}"
        }

        override fun requestReload(reason: RecoveryLadder.Reason, attempt: Int) {
            steps += "reload(${reason.wire},$attempt)@${clock.now()}"
        }

        override fun onExhausted(failure: RecoveryLadder.Failure) {
            steps += "exhausted:${failure.code}"
        }
    }

    private fun ladder(policy: RecoveryPolicy = RecoveryPolicy.DEFAULT) = RecoveryLadder(policy, clock, hooks)

    private fun short(max: Int) = RecoveryPolicy(10_000.0, max, listOf(1_000.0))

    @Test
    fun `climbs in-place, re-attach, two reloads, then reports the failure`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(2.0)
        ladder.note(failure)
        clock.advance(4.0)
        ladder.note(failure)
        clock.advance(8.0)
        ladder.note(failure)

        assertEquals(
            listOf("in-place", "reattach@2.0", "reload(fatal,2)@6.0", "reload(fatal,3)@14.0", "exhausted:network-error"),
            steps,
        )
    }

    @Test
    fun `an in-place repair that took stops the climb`() {
        inPlaceAnswer = true
        ladder().note(failure)
        clock.advance(30.0)
        assertEquals(listOf("in-place"), steps)
    }

    @Test
    fun `the in-place repair is not offered again for the same failure inside the window`() {
        inPlaceAnswer = true
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(2.0)
        assertEquals(listOf("in-place", "reattach@3.0"), steps)
    }

    @Test
    fun `a burst of failures while a rung is scheduled buys no extra rungs`() {
        val ladder = ladder()
        repeat(3) { ladder.note(failure) }
        clock.advance(30.0)
        assertEquals(listOf("in-place", "reattach@2.0"), steps)
    }

    @Test
    fun `playback moving again starts the ladder over`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(2.0)
        ladder.notePlaybackHealthy()
        ladder.note(failure)
        clock.advance(2.0)
        assertEquals(listOf("in-place", "reattach@2.0", "in-place", "reattach@4.0"), steps)
    }

    @Test
    fun `the source a reload rebuilt keeps the count, and any other source starts over`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(2.0)
        ladder.note(failure)
        clock.advance(4.0)
        assertTrue(ladder.pendingReload)

        ladder.noteSourceLoaded()
        ladder.note(failure)
        clock.advance(8.0)
        assertEquals("reload(fatal,3)@14.0", steps.last())

        ladder.notePlaybackHealthy()
        ladder.noteSourceLoaded()
        ladder.note(failure)
        assertEquals("in-place", steps.last())
    }

    @Test
    fun `nothing is outstanding once the failure is reported`() {
        val ladder = ladder(short(2))
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        assertTrue(ladder.pendingReload)

        ladder.note(failure)

        assertEquals("exhausted:network-error", steps.last())
        assertFalse(ladder.pendingReload)
    }

    @Test
    fun `a rung scheduled before playback recovered does not fire`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(1.0)
        ladder.notePlaybackHealthy()
        clock.advance(10.0)
        assertEquals(listOf("in-place"), steps)
    }

    @Test
    fun `a rung scheduled before another source loaded does not fire`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(1.0)
        ladder.noteSourceLoaded()
        clock.advance(10.0)
        assertEquals(listOf("in-place"), steps)
    }

    @Test
    fun `reports the failure once, and the next one that counts is after playback moved again`() {
        val ladder = ladder(short(1))
        ladder.note(failure)
        clock.advance(1.0)
        repeat(3) { ladder.note(failure) }
        assertEquals(listOf("in-place", "reattach@1.0", "exhausted:network-error"), steps)

        ladder.notePlaybackHealthy()
        ladder.note(failure)
        assertEquals("in-place", steps.last())
    }

    @Test
    fun `a reload asked for while the app is suspended is held for the resume, once`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(2.0)
        ladder.setAppSuspended(true)
        ladder.note(failure)
        clock.advance(4.0)

        assertEquals(listOf("in-place", "reattach@2.0"), steps)
        assertTrue(ladder.pendingReload)
        assertEquals(PendingReload("fatal", 2), ladder.takeHeldReload())
        assertNull(ladder.takeHeldReload())
    }

    @Test
    fun `a held reload is dropped once the failure is reported, and once playback moves again`() {
        val policy = short(2)
        val ladder = ladder(policy)
        ladder.setAppSuspended(true)
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        assertEquals("exhausted:network-error", steps.last())
        assertNull(ladder.takeHeldReload())

        val again = ladder(policy)
        again.setAppSuspended(true)
        again.note(failure)
        clock.advance(1.0)
        again.note(failure)
        clock.advance(1.0)
        again.notePlaybackHealthy()
        assertNull(again.takeHeldReload())
    }

    @Test
    fun `a destroyed ladder does nothing more`() {
        val ladder = ladder()
        ladder.note(failure)
        ladder.destroy()
        clock.advance(30.0)
        ladder.note(failure)
        assertEquals(listOf("in-place"), steps)
    }

    @Test
    fun `a failure that needs the source rebuilt skips the repairs a re-attach would make`() {
        val ladder = ladder()
        ladder.note(failure.copy(needsRebuild = true))
        clock.advance(4.0)
        assertEquals(listOf("reload(fatal,2)@4.0"), steps)
    }

    @Test
    fun `a policy that allows no attempts reports the failure at once`() {
        val ladder = ladder(short(0))
        ladder.note(failure)
        assertEquals(listOf("in-place", "exhausted:network-error"), steps)
    }

    @Test
    fun `a policy changed mid-climb applies to the next rung`() {
        val ladder = ladder()
        ladder.note(failure)
        clock.advance(2.0)
        ladder.setPolicy(short(1))
        ladder.note(failure)
        assertEquals("exhausted:network-error", steps.last())
    }

    @Test
    fun `fewer delays than attempts reuse the last one`() {
        val ladder = ladder(RecoveryPolicy(10_000.0, 3, listOf(1_000.0)))
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        assertEquals(listOf("in-place", "reattach@1.0", "reload(fatal,2)@2.0", "reload(fatal,3)@3.0"), steps)
    }

    @Test
    fun `a policy handed over mid-climb keeps the rung already scheduled and governs the next`() {
        val ladder = ladder()
        ladder.note(failure)
        // One attempt is allowed from here on, and the rung scheduled under the old delays stays.
        ladder.setPolicy(RecoveryPolicy(10_000.0, 1, listOf(10_000.0)))
        clock.advance(2.0)
        ladder.note(failure)
        assertEquals(listOf("in-place", "reattach@2.0", "exhausted:network-error"), steps)
    }

    @Test
    fun `fewer delays than attempts - the last delay repeats`() {
        val ladder = ladder(RecoveryPolicy(10_000.0, 3, listOf(1_000.0)))
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        clock.advance(1.0)
        ladder.note(failure)
        assertEquals(
            listOf("in-place", "reattach@1.0", "reload(fatal,2)@2.0", "reload(fatal,3)@3.0", "exhausted:network-error"),
            steps,
        )
    }

    @Test
    fun `no delays at all - every rung is taken as soon as the clock moves`() {
        val ladder = ladder(RecoveryPolicy(10_000.0, 2, emptyList()))
        ladder.note(failure)
        clock.advance(0.0)
        ladder.note(failure)
        clock.advance(0.0)
        assertEquals(listOf("in-place", "reattach@0.0", "reload(fatal,2)@0.0"), steps)
    }

    @Test
    fun `no attempts allowed - the failure is reported at once, after the in-place repair had its turn`() {
        val ladder = ladder(RecoveryPolicy(10_000.0, 0, listOf(1_000.0)))
        ladder.note(failure)
        clock.advance(30.0)
        assertEquals(listOf("in-place", "exhausted:network-error"), steps)
        assertFalse(ladder.pendingReload)

        // And a repair that took still ends it there.
        steps.clear()
        inPlaceAnswer = true
        ladder(RecoveryPolicy(10_000.0, 0, emptyList())).note(failure)
        assertEquals(listOf("in-place"), steps)
    }
}
