package org.bccsa.luminary.player.engine

import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.upstream.BandwidthMeter
import org.junit.Assert.assertEquals
import org.junit.Test

@UnstableApi
class SeedableBandwidthMeterTest {
    /** A meter whose estimate the test moves, standing in for ExoPlayer's own. */
    private class FakeMeter(var estimate: Long) : BandwidthMeter {
        override fun getBitrateEstimate() = estimate

        override fun getTransferListener(): TransferListener? = null

        override fun addEventListener(eventHandler: Handler, eventListener: BandwidthMeter.EventListener) {}

        override fun removeEventListener(eventListener: BandwidthMeter.EventListener) {}
    }

    @Test
    fun `with no hint it says what the meter says`() {
        val meter = SeedableBandwidthMeter(FakeMeter(1_000_000))
        assertEquals(1_000_000L, meter.bitrateEstimate)
    }

    @Test
    fun `the host's hint stands until the meter has measured something`() {
        val inner = FakeMeter(1_000_000)
        val meter = SeedableBandwidthMeter(inner)
        meter.hint = 8_000_000

        assertEquals(8_000_000L, meter.bitrateEstimate)

        inner.estimate = 3_500_000
        assertEquals("a real measurement replaces the hint, it is not a cap", 3_500_000L, meter.bitrateEstimate)
    }

    @Test
    fun `a later load with no hint goes back to the meter`() {
        val meter = SeedableBandwidthMeter(FakeMeter(1_000_000))
        meter.hint = 8_000_000
        meter.hint = null
        assertEquals(1_000_000L, meter.bitrateEstimate)
    }
}
