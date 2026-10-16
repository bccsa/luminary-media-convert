package org.bccsa.luminary.player.engine

import androidx.media3.common.PlaybackException

/** The `error` event's `category` (`AdapterErrorCategory`) for a Media3 failure. */
internal fun categoryOf(error: PlaybackException): String = when (error.errorCode) {
    // ERROR_CODE_IO_*
    in 2000..2999 -> "network"
    // ERROR_CODE_PARSING_* and ERROR_CODE_DECODING_* / DECODER_*
    in 3000..4999 -> "media"
    else -> "other"
}
