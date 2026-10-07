package org.bccsa.luminary.player.engine

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.BitmapLoader
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

/**
 * The lock screen's picture: a post's own, else the host's stand-in when the post's does not load,
 * answers with an error or is not an image. A `data:` stand-in loads like any other address.
 */
class ArtworkBitmapLoader(private val inner: BitmapLoader) : BitmapLoader by inner {
    override fun loadBitmapFromMetadata(metadata: MediaMetadata): ListenableFuture<Bitmap>? {
        val first = inner.loadBitmapFromMetadata(metadata) ?: return null
        val fallback = metadata.extras?.getString(FALLBACK_ARTWORK)?.takeIf { it.isNotEmpty() } ?: return first
        return Futures.catchingAsync(
            first,
            Throwable::class.java,
            { inner.loadBitmap(Uri.parse(fallback)) },
            MoreExecutors.directExecutor(),
        )
    }

    companion object {
        private const val FALLBACK_ARTWORK = "org.bccsa.luminary.player.FALLBACK_ARTWORK"

        /** Metadata extras carrying [fallback] for this loader. */
        fun extrasWith(fallback: String) = Bundle().apply { putString(FALLBACK_ARTWORK, fallback) }
    }
}
