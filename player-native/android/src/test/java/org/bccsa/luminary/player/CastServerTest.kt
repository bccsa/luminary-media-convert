package org.bccsa.luminary.player

import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

private const val KEY_HEX = "000102030405060708090a0b0c0d0e0f"
private const val LIVE_URL = "https://live.example.com/channel/chunks.m3u8"
private const val MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nluminary://asset/1/1.m3u8\n"
private const val MEDIA =
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI=\"luminary://key\"\n#EXTINF:4,\nhttps://cdn.example.com/s_0.m4s\n"

/** The phone-side server a Cast receiver talks to, over real loopback sockets. */
@RunWith(RobolectricTestRunner::class)
class CastServerTest {
    private val assets = AssetStore()
    private val key = KeyHolder()
    private val live = FakeLiveUpstream(
        mutableMapOf(LIVE_URL to FakeLiveUpstream.Answer.Body("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI=\"luminary://key\"\n#EXTINF:4,\nl_1.ts\n".toByteArray())),
    )
    private val router = UriRouter(assets, key, null, live.fetch)
    private val server = CastServer(router, InetAddress.getByName("127.0.0.1"))
    private val http = OkHttpClient()

    init {
        assets.put(
            1,
            listOf(
                BridgeAsset("luminary://asset/1/1.m3u8", "application/vnd.apple.mpegurl", MEDIA),
                BridgeAsset("luminary://asset/1/2.m3u8", "application/vnd.apple.mpegurl", MASTER),
            ),
        )
        assets.putLive(1, "luminary://live/1", LiveSpec(LIVE_URL, LIVE_URL, KEY_URI, hexBytes(KEY_HEX), 4.0))
        key.set(KEY_HEX)
    }

    private val base = server.start()

    @After
    fun tearDown() = server.close()

    private fun request(path: String, method: String = "GET", headers: Map<String, String> = emptyMap(), base: String = this.base): Response {
        val builder = Request.Builder().url(base + path)
        headers.forEach { (name, value) -> builder.header(name, value) }
        return http.newCall(builder.method(method, null).build()).execute()
    }

    @Test
    fun `a playlist is served with its addresses rewritten to the server's`() {
        request("/a/1/2.m3u8").use { response ->
            assertEquals(200, response.code)
            assertEquals("application/vnd.apple.mpegurl", response.header("Content-Type"))
            assertEquals("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n$base/a/1/1.m3u8\n", response.body!!.string())
        }
    }

    @Test
    fun `the key a media playlist names is served from the phone, and the key itself raw`() {
        request("/a/1/1.m3u8").use { assertTrue(it.body!!.string().contains("URI=\"$base/key\"")) }
        request("/key").use { response ->
            assertEquals(200, response.code)
            assertEquals("application/octet-stream", response.header("Content-Type"))
            assertEquals(KEY_HEX, response.body!!.bytes().joinToString("") { "%02x".format(it) })
        }
    }

    @Test
    fun `a live playlist is read from the origin for each request and rewritten`() {
        repeat(2) {
            request("/l/1.m3u8").use { response ->
                assertEquals(200, response.code)
                val text = response.body!!.string()
                assertTrue(text.contains("URI=\"$base/key\""))
                assertTrue(text.contains("l_1.ts"))
            }
        }
        assertEquals(2, live.reads.size)
    }

    @Test
    fun `a live playlist the origin will not give is a bad gateway`() {
        live.routes[LIVE_URL] = FakeLiveUpstream.Answer.Status(503)
        request("/l/1.m3u8").use { assertEquals(502, it.code) }
    }

    @Test
    fun `without the token, or with another, nothing is served`() {
        val root = base.substringBeforeLast("/")
        request("/a/1/2.m3u8", base = root).use { assertEquals(404, it.code) }
        request("/a/1/2.m3u8", base = "$root/${"0".repeat(32)}").use { assertEquals(404, it.code) }
        request("/key", base = "$root/${server.token.dropLast(1)}").use { assertEquals(404, it.code) }
    }

    @Test
    fun `only what the router holds can be asked for`() {
        for (path in listOf("/a/2/1.m3u8", "/a/1/9.m3u8", "/l/2.m3u8", "/", "/nope", "/a/1/../2.m3u8", "/key/extra")) {
            request(path).use { assertEquals("$path", 404, it.code) }
        }
    }

    @Test
    fun `the key is gone with the key holder, and so is its address`() {
        key.zero()
        request("/key").use { assertEquals(404, it.code) }
    }

    @Test
    fun `a purged generation is not served`() {
        assets.release(1)
        assets.purgeReleasedBefore(2)
        request("/a/1/2.m3u8").use { assertEquals(404, it.code) }
    }

    @Test
    fun `HEAD says what a GET would, without the body`() {
        val get = request("/a/1/2.m3u8").use { it.body!!.string().length }
        request("/a/1/2.m3u8", method = "HEAD").use { response ->
            assertEquals(200, response.code)
            assertEquals(get.toString(), response.header("Content-Length"))
            assertEquals(0, response.body!!.contentLength().coerceAtLeast(0))
        }
    }

    @Test
    fun `a receiver's preflight is answered, and every answer carries the CORS headers and no cache`() {
        request("/a/1/2.m3u8", method = "OPTIONS").use { response ->
            assertEquals(204, response.code)
            assertEquals("*", response.header("Access-Control-Allow-Origin"))
            assertTrue(response.header("Access-Control-Allow-Headers")!!.contains("Range"))
        }
        for (path in listOf("/a/1/2.m3u8", "/key", "/missing")) {
            request(path).use { response ->
                assertEquals("*", response.header("Access-Control-Allow-Origin"))
                assertEquals("no-store", response.header("Cache-Control"))
            }
        }
    }

    @Test
    fun `a byte range of the key is a partial answer, and one past its end is refused`() {
        request("/key", headers = mapOf("Range" to "bytes=4-7")).use { response ->
            assertEquals(206, response.code)
            assertEquals("bytes 4-7/16", response.header("Content-Range"))
            assertEquals(listOf<Byte>(4, 5, 6, 7), response.body!!.bytes().toList())
        }
        request("/key", headers = mapOf("Range" to "bytes=99-")).use { assertEquals(416, it.code) }
    }

    @Test
    fun `nothing but GET, HEAD and OPTIONS is accepted`() {
        val post = Request.Builder().url("$base/key").post(okhttp3.RequestBody.create(null, ByteArray(0))).build()
        http.newCall(post).execute().use { assertEquals(405, it.code) }
    }

    @Test
    fun `a request head past the limit is refused, and a malformed one is a bad request`() {
        raw("GET /key HTTP/1.1\r\nX-Pad: ${"a".repeat(10_000)}\r\n\r\n").let { assertTrue(it, it.startsWith("HTTP/1.1 431")) }
        raw("NONSENSE\r\n\r\n").let { assertTrue(it, it.startsWith("HTTP/1.1 400")) }
    }

    @Test
    fun `many receivers at once are all answered`() {
        val pool = Executors.newFixedThreadPool(8)
        val done = CountDownLatch(24)
        val failures = java.util.concurrent.atomic.AtomicInteger()
        repeat(24) {
            pool.execute {
                try {
                    request("/a/1/1.m3u8").use { if (it.code != 200) failures.incrementAndGet() }
                } catch (e: Exception) {
                    failures.incrementAndGet()
                } finally {
                    done.countDown()
                }
            }
        }
        assertTrue(done.await(20, TimeUnit.SECONDS))
        pool.shutdownNow()
        assertEquals(0, failures.get())
    }

    @Test
    fun `a connection that sends nothing is not held for ever, and does not stop the others`() {
        Socket("127.0.0.1", base.substringAfter("127.0.0.1:").substringBefore('/').toInt()).use {
            // Open and silent.
            request("/key").use { response -> assertEquals(200, response.code) }
        }
    }

    @Test
    fun `after stop it accepts nothing`() {
        server.close()
        val failed = try {
            request("/key").close()
            false
        } catch (refused: java.io.IOException) {
            true
        }
        assertTrue(failed)
    }

    @Test
    fun `every cast gets its own token, of 128 bits`() {
        val other = CastServer.newToken()
        assertEquals(32, other.length)
        assertNotEquals(other, CastServer.newToken())
        assertNotEquals(other, server.token)
        assertTrue(other.all { it in "0123456789abcdef" })
    }

    @Test
    fun `the LAN address, when there is one, is a private IPv4 one`() {
        val address = CastServer.lanAddress()
        if (address != null) {
            assertTrue(address is java.net.Inet4Address)
            assertTrue(address.isSiteLocalAddress)
        } else {
            assertNull(address)
        }
    }

    @Test
    fun `a server cannot be started twice`() {
        assertFalse(runCatching { server.start() }.isSuccess)
    }

    /** What the server says to bytes sent without an HTTP client's manners. */
    private fun raw(request: String): String {
        val port = base.substringAfter("127.0.0.1:").substringBefore('/').toInt()
        Socket("127.0.0.1", port).use { socket ->
            socket.soTimeout = 5000
            socket.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
            socket.getOutputStream().flush()
            return socket.getInputStream().bufferedReader(Charsets.ISO_8859_1).readLine() ?: ""
        }
    }
}
