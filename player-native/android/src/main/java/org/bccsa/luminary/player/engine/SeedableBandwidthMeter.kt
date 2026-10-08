package org.bccsa.luminary.player.engine

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.upstream.BandwidthMeter

/**
 * ExoPlayer's bandwidth meter, started from the host's own measure of the connection
 * (`PlayerSource.bandwidthEstimate`) until the meter has measured something itself. The hint is a
 * start, never a cap: the first real estimate replaces it. A meter has no setter for its initial
 * estimate, and a load arrives after the player is built, hence this.
 */
@OptIn(UnstableApi::class)
class SeedableBandwidthMeter(private val delegate: BandwidthMeter) : BandwidthMeter by delegate {
    /** What the meter said before it had measured anything; while it still says that, it has not. */
    private val unmeasured = delegate.bitrateEstimate

    /** Bits per second the host measured, or null for no hint. */
    @Volatile var hint: Long? = null

    override fun getBitrateEstimate(): Long {
        val measured = delegate.bitrateEstimate
        val hint = hint
        return if (hint != null && measured == unmeasured) hint else measured
    }
}
