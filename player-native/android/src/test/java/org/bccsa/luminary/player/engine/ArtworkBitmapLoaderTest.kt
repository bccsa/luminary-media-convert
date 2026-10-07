package org.bccsa.luminary.player.engine

import android.graphics.Bitmap
import android.net.Uri
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.BitmapLoader
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ArtworkBitmapLoaderTest {
    /** Answers the addresses it knows, and fails every other the way a 404 or an undecodable body does. */
    private class FakeLoader(private val images: Map<String, Bitmap>) : BitmapLoader {
        val asked = mutableListOf<String>()

        override fun supportsMimeType(mimeType: String) = true

        override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = Futures.immediateFailedFuture(IOException())

        override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
            asked += uri.toString()
            return images[uri.toString()]?.let { Futures.immediateFuture(it) } ?: Futures.immediateFailedFuture(IOException("404"))
        }
    }

    private val poster = Bitmap.createBitmap(4, 3, Bitmap.Config.ARGB_8888)
    private val standIn = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

    private fun metadata(artwork: String) = MediaMetadata.Builder().setArtworkUri(Uri.parse(artwork)).build()

    private fun loader(inner: BitmapLoader, fallback: String?) = ArtworkBitmapLoader(inner).also { it.fallback = fallback }

    @Test
    fun `the post's picture when it loads, without asking for the stand-in`() {
        val inner = FakeLoader(mapOf("https://cdn/poster.jpg" to poster, "data:stand-in" to standIn))
        val bitmap = loader(inner, "data:stand-in").loadBitmapFromMetadata(metadata("https://cdn/poster.jpg"))!!.get()
        assertSame(poster, bitmap)
        assertEquals(listOf("https://cdn/poster.jpg"), inner.asked)
    }

    @Test
    fun `the stand-in when the post's picture does not load`() {
        val inner = FakeLoader(mapOf("data:stand-in" to standIn))
        val bitmap = loader(inner, "data:stand-in").loadBitmapFromMetadata(metadata("https://cdn/gone.jpg"))!!.get()
        assertSame(standIn, bitmap)
        assertEquals(listOf("https://cdn/gone.jpg", "data:stand-in"), inner.asked)
    }

    @Test(expected = java.util.concurrent.ExecutionException::class)
    fun `with no stand-in, a picture that does not load is no picture`() {
        loader(FakeLoader(emptyMap()), null).loadBitmapFromMetadata(metadata("https://cdn/gone.jpg"))!!.get()
    }

    @Test
    fun `a base64 data URL gives its bytes, and anything else gives none`() {
        assertArrayEquals(byteArrayOf(1, 2, 3), ArtworkBitmapLoader.dataUrlBytes("data:image/jpeg;base64,AQID"))
        assertNull(ArtworkBitmapLoader.dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E"))
        assertNull(ArtworkBitmapLoader.dataUrlBytes("https://cdn/poster.jpg"))
    }
}
