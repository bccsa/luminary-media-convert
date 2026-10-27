package org.bccsa.luminary.player

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlin.math.roundToLong

fun interface Cancellable {
    fun cancel()
}

/** The time every timer in `PlayerHost` and `EventSink` runs on, so tests can run them on virtual time. */
interface Clock {
    /** Seconds on a monotonic clock. */
    fun now(): Double

    /** Runs [run] on the main thread after [delaySeconds]. */
    fun schedule(delaySeconds: Double, run: () -> Unit): Cancellable
}

/** Monotonic, so a wall-clock change cannot bunch or starve the emission timers. */
class MainLooperClock : Clock {
    private val handler = Handler(Looper.getMainLooper())

    override fun now(): Double = SystemClock.elapsedRealtime() / 1000.0

    override fun schedule(delaySeconds: Double, run: () -> Unit): Cancellable {
        val runnable = Runnable(run)
        handler.postDelayed(runnable, (delaySeconds * 1000).roundToLong())
        return Cancellable { handler.removeCallbacks(runnable) }
    }
}
