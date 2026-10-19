package org.bccsa.luminary.player.engine

import android.view.OrientationEventListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhonePoseTest {
    @Test
    fun `either side counts as sideways`() {
        listOf(60, 90, 120, 240, 270, 300).forEach { assertEquals("$it", PhonePose.SIDEWAYS, phonePoseOf(it)) }
    }

    @Test
    fun `around the top counts as upright`() {
        listOf(0, 15, 30, 330, 345, 359).forEach { assertEquals("$it", PhonePose.UPRIGHT, phonePoseOf(it)) }
    }

    @Test
    fun `halfway, upside down and flat say nothing`() {
        listOf(31, 45, 59, 121, 180, 239, 301, 329).forEach { assertNull("$it", phonePoseOf(it)) }
        assertNull(phonePoseOf(OrientationEventListener.ORIENTATION_UNKNOWN))
    }

    @Test
    fun `a phone still held upright does not leave the turn full-screen made itself`() {
        val exit = UprightExit()
        assertFalse(exit.saw(PhonePose.UPRIGHT))
        assertFalse(exit.saw(null))
        assertFalse(exit.beenSideways)
    }

    @Test
    fun `once the phone has been on its side, turning it upright leaves`() {
        val exit = UprightExit()
        assertFalse(exit.saw(PhonePose.SIDEWAYS))
        assertFalse(exit.saw(null))
        assertTrue(exit.saw(PhonePose.UPRIGHT))
    }

    @Test
    fun `each full-screen starts afresh`() {
        val exit = UprightExit()
        exit.saw(PhonePose.SIDEWAYS)
        exit.reset()
        assertFalse(exit.saw(PhonePose.UPRIGHT))
    }
}
