package org.bccsa.luminary.player

import androidx.media3.common.ParserException
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import android.net.Uri
import java.io.InterruptedIOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

private const val LIVE_KEY_HEX = "000102030405060708090a0b0c0d0e0f"
private const val LIVE = "https://live.example.com/channel/video_360/chunks.m3u8"
private const val WINDOW = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4,\nl_100.ts\n"

/** The router answering `luminary://live/<n>` the way ExoPlayer asks for it, ported from `UriRouterLiveTests`. */
@RunWith(RobolectricTestRunner::class)
class UriRouterLiveTest {
    private val uri = "luminary://live/1"

    private fun router(upstream: FakeLiveUpstream, release: Boolean = false): UriRouter {
        val assets = AssetStore()
        assets.putLive(1, uri, LiveSpec(LIVE, LIVE, KEY_URI, hexBytes(LIVE_KEY_HEX), 4.0))
        if (release) {
            assets.release(1)
            assets.purgeReleasedBefore(2)
        }
        return UriRouter(assets, KeyHolder(), null, upstream.fetch)
    }

    private fun open(router: UriRouter, uri: String = this.uri): Pair<androidx.media3.datasource.DataSource, ByteArray> {
        val source = router.createDataSource(androidx.media3.common.C.DATA_TYPE_MANIFEST)
        val spec = DataSpec(Uri.parse(uri))
        val length = source.open(spec)
        val bytes = ByteArray(length.toInt())
        var read = 0
        while (read < bytes.size) read += source.read(bytes, read, bytes.size - read).also { check(it > 0) }
        return source to bytes
    }

    @Test
    fun `serves the playlist read for this request`() {
        val router = router(FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Body(WINDOW.toByteArray()))))
        val (source, bytes) = open(router)
        source.close()
        assertTrue(String(bytes).contains("https://live.example.com/channel/video_360/l_100.ts"))
    }

    @Test
    fun `reads again for the next request`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Body(WINDOW.toByteArray())))
        val router = router(upstream)
        repeat(2) { open(router).first.close() }
        assertEquals(2, upstream.reads.size)
    }

    @Test
    fun `an upstream status reaches the engine as the response code a direct request would have met`() {
        val router = router(FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Status(503))))
        val error = assertThrows(HttpDataSource.InvalidResponseCodeException::class.java) { open(router) }
        assertEquals(503, error.responseCode)
    }

    @Test
    fun `a playlist that is not one is a parse error, which the engine does not retry`() {
        val router = router(FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Body("<html>no</html>".toByteArray()))))
        assertThrows(ParserException::class.java) { open(router) }
    }

    @Test
    fun `a released address waits for the engine to cancel, and reads nothing`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Body(WINDOW.toByteArray())))
        val router = router(upstream, release = true)
        val source = router.createDataSource(androidx.media3.common.C.DATA_TYPE_MANIFEST)
        var failure: Throwable? = null
        val waiting = Thread { failure = runCatching { source.open(DataSpec(Uri.parse(uri))) }.exceptionOrNull() }
        waiting.start()
        Thread.sleep(100)
        assertTrue(waiting.isAlive)

        source.close()
        waiting.join(2000)

        assertTrue(!waiting.isAlive)
        assertTrue(failure is InterruptedIOException)
        assertTrue(upstream.reads.isEmpty())
    }

    @Test
    fun `cancels the read when the engine abandons the request`() {
        val upstream = FakeLiveUpstream(mutableMapOf(LIVE to FakeLiveUpstream.Answer.Hang))
        val router = router(upstream)
        val source = router.createDataSource(androidx.media3.common.C.DATA_TYPE_MANIFEST)
        val waiting = Thread { runCatching { source.open(DataSpec(Uri.parse(uri))) } }
        waiting.start()
        Thread.sleep(100)

        source.close()
        waiting.join(2000)

        assertTrue(!waiting.isAlive)
        assertEquals(1, upstream.cancels)
    }

    @Test
    fun `purging a generation zeroes the key its live address held`() {
        val assets = AssetStore()
        val spec = LiveSpec(LIVE, LIVE, KEY_URI, hexBytes(LIVE_KEY_HEX), 4.0)
        assets.putLive(1, uri, spec)
        assets.release(1)
        assets.purgeReleasedBefore(2)
        assertEquals(null, spec.keyBytes)
        assertEquals(null, assets.live(uri))
    }
}
