package org.bccsa.luminary.player.conformance

import org.bccsa.luminary.player.Cancellable
import org.bccsa.luminary.player.Clock

/**
 * Timers due at the same instant fire in the order they were set, and [now] reads the timer's own
 * time while it fires, so a position computed inside one is exact.
 */
class VirtualClock : Clock {
    private class Timer(val at: Double, val seq: Long, val run: () -> Unit)

    private var current = 0.0
    private var sequence = 0L
    private val timers = mutableListOf<Timer>()

    override fun now(): Double = current

    override fun schedule(delaySeconds: Double, run: () -> Unit): Cancellable {
        val timer = Timer(current + delaySeconds, sequence++, run)
        timers += timer
        return Cancellable { timers.remove(timer) }
    }

    fun advance(seconds: Double) {
        val until = current + seconds
        while (true) {
            val next = timers.filter { it.at <= until }.minWithOrNull(compareBy<Timer> { it.at }.thenBy { it.seq })
                ?: break
            timers.remove(next)
            current = next.at
            next.run()
        }
        current = until
    }
}
