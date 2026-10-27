package org.bccsa.luminary.player.engine

/** How the phone is held, read from the orientation sensor's degrees. */
internal enum class PhonePose { UPRIGHT, SIDEWAYS }

/**
 * The pose for a sensor reading, or null when it says neither: unknown (flat on a table), upside
 * down, or between the two. The gaps between the bands keep a phone tilted halfway from flicking
 * back and forth.
 */
internal fun phonePoseOf(degrees: Int): PhonePose? = when {
    degrees < 0 -> null
    degrees in 60..120 || degrees in 240..300 -> PhonePose.SIDEWAYS
    degrees <= 30 || degrees >= 330 -> PhonePose.UPRIGHT
    else -> null
}

/**
 * When turning the phone upright leaves full-screen. Full-screen opened with the phone still held
 * upright turns the picture sideways by itself, so the phone being upright says nothing until it
 * has been on its side; after that, turning it upright is the viewer leaving.
 */
internal class UprightExit {
    var beenSideways = false
        private set

    /** Returns whether this pose is the viewer turning the phone upright to leave. */
    fun saw(pose: PhonePose?): Boolean = when (pose) {
        PhonePose.SIDEWAYS -> {
            beenSideways = true
            false
        }
        PhonePose.UPRIGHT -> beenSideways
        null -> false
    }

    fun reset() {
        beenSideways = false
    }
}
