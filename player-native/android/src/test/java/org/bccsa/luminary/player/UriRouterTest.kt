package org.bccsa.luminary.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.FileNotFoundException
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class UriRouterTest {
    private val assets = AssetStore()
    private val key = KeyHolder()
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val router = UriRouter(assets, key, HttpUpstream(OkHttpClient()))

    /** isNetwork per transfer start, in order. */
    private val transfers = mutableListOf<Boolean>()
    private val listener = object : TransferListener {
        override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
        override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {
            transfers += isNetwork
        }
        override fun onBytesTransferred(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean, bytes: Int) {}
        override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) {}
    }

    @After
    fun tearDown() = upstream.close()

    private fun read(dataSpec: DataSpec): ByteArray {
        val source = router.createDataSource(C.DATA_TYPE_MANIFEST)
        source.addTransferListener(listener)
        source.open(dataSpec)
        try {
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (true) {
                val count = source.read(buffer, 0, buffer.size)
                if (count == C.RESULT_END_OF_INPUT) break
                out.write(buffer, 0, count)
            }
            return out.toByteArray()
        } finally {
            source.close()
        }
    }

    private fun read(uri: String) = read(DataSpec(Uri.parse(uri)))

    @Test
    fun `an asset is answered from memory, off the bandwidth estimate`() {
        assets.put(1, listOf(BridgeAsset("luminary://asset/1/1.m3u8", "application/vnd.apple.mpegurl", "#EXTM3U\n")))

        assertEquals("#EXTM3U\n", String(read("luminary://asset/1/1.m3u8")))
        assertEquals(listOf(false), transfers)
    }

    @Test
    fun `a byte range of an asset reads only that range`() {
        assets.put(1, listOf(BridgeAsset("luminary://asset/1/1.vtt", "text/vtt", "0123456789")))

        val range = DataSpec.Builder().setUri("luminary://asset/1/1.vtt").setPosition(3).setLength(4).build()
        assertEquals("3456", String(read(range)))
    }

    @Test
    fun `the key is exactly its 16 bytes, and fails once zeroed`() {
        key.set("000102030405060708090a0b0c0d0e0f")
        assertArrayEquals(ByteArray(16) { it.toByte() }, read(KEY_URI))

        key.zero()
        assertThrows(KeyRequiredException::class.java) { read(KEY_URI) }
    }

    @Test
    fun `a missing asset fails as not-found, which the load policy does not retry`() {
        assertThrows(FileNotFoundException::class.java) { read("luminary://asset/9/1.m3u8") }
    }

    @Test
    fun `https goes upstream, and a byte range carries its Range header`() {
        read("${upstream.base}/video/init.mp4")
        val range = DataSpec.Builder().setUri("${upstream.base}/media/video_0.m4s").setPosition(100).setLength(16).build()
        assertEquals(16, read(range).size)

        assertNull(upstream.requests[0].getHeader("Range"))
        assertEquals("bytes=100-115", upstream.requests[1].getHeader("Range"))
        assertEquals(listOf(true, true), transfers)
    }
}
