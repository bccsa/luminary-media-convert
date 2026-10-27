package org.bccsa.luminary.player.engine

import android.content.Context
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.DefaultAnalyticsCollector
import androidx.media3.test.utils.FakeAudioRenderer
import androidx.media3.test.utils.FakeVideoRenderer
import androidx.media3.test.utils.TestExoPlayerBuilder

/**
 * `TestExoPlayerBuilder`'s player for a test that reads its stream from a real local server, with the
 * stuck-buffering check off.
 *
 * Its clock jumps ahead whenever the player waits, and while the player waits for bytes on the server's own
 * threads it can jump past the check's ten minutes in a second of real time on a busy machine, failing a
 * test that is not stuck. One that is stuck still fails: `TestPlayerRunHelper` gives up in real time.
 */
internal fun fixturePlayer(context: Context): ExoPlayer {
    val base = TestExoPlayerBuilder(context)
    val clock = base.clock
    val builder = ExoPlayer.Builder(context) { handler, video, audio, _, _ ->
        val events = clock.createHandler(handler.looper, null)
        arrayOf(FakeVideoRenderer(events, video), FakeAudioRenderer(events, audio))
    }
        .setTrackSelector(base.trackSelector)
        .setLoadControl(base.loadControl)
        .setBandwidthMeter(base.bandwidthMeter)
        .setAnalyticsCollector(DefaultAnalyticsCollector(clock))
        .setClock(clock)
        .setUseLazyPreparation(base.useLazyPreparation)
        .setStuckBufferingDetectionTimeoutMs(Int.MAX_VALUE)
    base.looper?.let(builder::setLooper)
    return builder.build()
}
