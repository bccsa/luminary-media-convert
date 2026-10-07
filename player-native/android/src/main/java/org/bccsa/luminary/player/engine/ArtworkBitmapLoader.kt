package org.bccsa.luminary.player.engine

import android.graphics.Bitmap
import android.net.Uri
import android.util.Base64
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.BitmapLoader
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

/**
 * The lock screen's picture: a post's own, else the host's stand-in when the post's does not load,
 * answers with an error or is not an image. A `data:` stand-in loads like any other address.
 *
 * The stand-in is held here rather than in the item's metadata: the session copies metadata
 * strings into every update it sends the system, and a `data:` URL there overflows the binder.
 */
class ArtworkBitmapLoader(private val inner: BitmapLoader) : BitmapLoader by inner {
    /** The current item's stand-in, for when its artwork does not load. */
    var fallback: String? = null

    override fun loadBitmapFromMetadata(metadata: MediaMetadata): ListenableFuture<Bitmap>? {
        val first = inner.loadBitmapFromMetadata(metadata) ?: return null
        val fallback = fallback?.takeIf { it.isNotEmpty() } ?: return first
        return Futures.catchingAsync(
            first,
            Throwable::class.java,
            { inner.loadBitmap(Uri.parse(fallback)) },
            MoreExecutors.directExecutor(),
        )
    }

    companion object {
        /** The bytes of a base64 `data:` URL; null for anything else, or a payload that does not decode. */
        fun dataUrlBytes(url: String): ByteArray? {
            if (!url.startsWith("data:", ignoreCase = true)) return null
            val comma = url.indexOf(',').takeIf { it >= 0 } ?: return null
            if (!url.substring(0, comma).endsWith(";base64", ignoreCase = true)) return null
            return runCatching { Base64.decode(url.substring(comma + 1), Base64.DEFAULT) }.getOrNull()
        }
    }
}
