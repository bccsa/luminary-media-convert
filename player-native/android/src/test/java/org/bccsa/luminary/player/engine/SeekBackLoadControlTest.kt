package org.bccsa.luminary.player.engine

import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.PlayerId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@UnstableApi
class SeekBackLoadControlTest {
    @Test
    fun `played media is kept for a skip back to land in`() {
        val control = seekBackLoadControl()
        assertEquals(BACK_BUFFER_MS * 1000L, control.getBackBufferDurationUs(PlayerId.UNSET))
        assertTrue(control.retainBackBufferFromKeyframe(PlayerId.UNSET))
    }
}
