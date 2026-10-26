package org.bccsa.luminary.player.engine

import org.bccsa.luminary.player.Cancellable
import org.bccsa.luminary.player.Clock

/**
 * The timeline under a finger: a tap does not move the video, it opens the way to scrub it. With frames that is the
 * strip of them; without, a thicker bar with a handle. Only a drag moves the playhead. The video holds still while
 * either is open, and they put themselves away a few seconds after the last touch, on a tap elsewhere or on play,
 * the video carrying on only if it was playing when they opened. `player-web` and the iOS player keep the same rules.
 */
internal class TimelineScrub(private val clock: Clock) {
    /** What a touch on the timeline has opened. */
    enum class Mode { CLOSED, STRIP, BAR }

    /** What the player has to do about it. */
    sealed interface Effect {
        data class Open(val mode: Mode) : Effect
        data object Close : Effect
        data object Pause : Effect
        data object Play : Effect
        data class Seek(val seconds: Double) : Effect
    }

    var mode = Mode.CLOSED
        private set
    val isOpen get() = mode != Mode.CLOSED
    var onEffect: ((Effect) -> Unit)? = null

    private var resumeOnClose = false
    private var idle: Cancellable? = null

    /** A finger came down on the timeline or the strip: nothing closes under it. */
    fun touchBegan() {
        idle?.cancel()
        idle = null
    }

    /** A tap on the timeline, which never moves the video. */
    fun tapped(framesReady: Boolean, playing: Boolean) {
        openIfClosed(framesReady, playing)
        armIdle()
    }

    /** A drag on the timeline or the strip started. */
    fun dragBegan(framesReady: Boolean, playing: Boolean) {
        openIfClosed(framesReady, playing)
        touchBegan()
    }

    /** The drag let go at [seconds]: the one place the video moves. */
    fun dragEnded(seconds: Double) {
        onEffect?.invoke(Effect.Seek(seconds))
        armIdle()
    }

    /** The drag was taken away from the finger without a decision: nothing moves. */
    fun dragCancelled() = armIdle()

    /** A tap anywhere but the timeline and the strip. */
    fun tappedElsewhere() = close(resume = true)

    /** Play was asked for while open: it closes, and the video plays whether or not it was before. */
    fun playPressed() {
        if (!isOpen) return
        resumeOnClose = true
        close(resume = true)
    }

    /** A new video, or the player going away: put away without touching playback. */
    fun reset() = close(resume = false)

    private fun openIfClosed(framesReady: Boolean, playing: Boolean) {
        if (mode != Mode.CLOSED) return
        resumeOnClose = playing
        mode = if (framesReady) Mode.STRIP else Mode.BAR
        onEffect?.invoke(Effect.Open(mode))
        if (playing) onEffect?.invoke(Effect.Pause)
    }

    private fun armIdle() {
        idle?.cancel()
        idle = if (isOpen) clock.schedule(IDLE_SECONDS) { close(resume = true) } else null
    }

    private fun close(resume: Boolean) {
        idle?.cancel()
        idle = null
        if (!isOpen) return
        mode = Mode.CLOSED
        onEffect?.invoke(Effect.Close)
        if (resume && resumeOnClose) onEffect?.invoke(Effect.Play)
        resumeOnClose = false
    }

    companion object {
        /** How long after the last touch it closes on its own. */
        const val IDLE_SECONDS = 5.0
    }
}
